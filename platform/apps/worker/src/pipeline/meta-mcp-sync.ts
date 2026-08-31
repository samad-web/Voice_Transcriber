import { createHash } from "node:crypto";
import { assertPublicHttpUrl, decryptSecret, getAdminPool, withOrgContext } from "@aura/db";
import {
  entryStage,
  findTool,
  LEAD_TOOL_CANDIDATES,
  McpClient,
  normalizeLeads,
  parseLeadStages,
  phoneDigits,
  toolJson,
  type NormalizedLead,
} from "@aura/shared";
import type { DbClient } from "./crm-dispatch";
import { projectLeadToCrm } from "./crm-objects";
import { detectProjectsForText } from "./projects";

/**
 * Pull Meta lead-ads leads through a tenant's MCP server and put them on the
 * lead board (migration 0074).
 *
 * ── THE GAP THIS EXISTS TO CLOSE ────────────────────────────────────────
 *
 * The webhook path (0063, meta-webhook.controller.ts) creates a `contact` and
 * a `deal` for every Meta lead and NO `leads` row. The owner console's board
 * and All Leads pages read `leads` — the A6 cutover to deals has not
 * happened — so every Meta lead ever captured has been invisible on the two
 * pages an owner actually works in. Phone leads from the handset appear
 * there; ad leads did not. This sweep writes the `leads` row, which is what
 * makes an ad lead and a call lead sit on the same board.
 *
 * ── WHY A PULL WHEN A WEBHOOK ALREADY EXISTS ────────────────────────────
 *
 * They are not redundant. The webhook needs a public HTTPS endpoint Meta can
 * reach and an app review; a pull works from anywhere, backfills leads that
 * arrived before Aura was connected, and recovers the ones a webhook outage
 * dropped. Both write through the same `meta_leadgen_events` unique index on
 * `leadgen_id`, so running both cannot double-create a lead — whichever
 * arrives first claims the row and the other skips it.
 *
 * Same shape as every other sweep here: cross-tenant off the admin pool to
 * find work, then re-enter each org's RLS context to write it.
 */

/** How far back each sweep asks for. Overlap is free — the claim is idempotent. */
const LOOKBACK_HOURS = Number(process.env.META_MCP_LOOKBACK_HOURS ?? 48);
/** A cap so a first sync against a large ad account cannot run unbounded. */
const MAX_LEADS_PER_SWEEP = Number(process.env.META_MCP_MAX_LEADS ?? 200);

export interface Connection {
  id: string;
  org_id: string;
  server_url: string;
  access_token: string | null;
}

export interface MetaMcpSyncResult {
  connections: number;
  fetched: number;
  created: number;
  skipped: number;
  errors: number;
}

export async function syncMetaMcpConnections(): Promise<MetaMcpSyncResult> {
  const pool = getAdminPool();
  const { rows: connections } = await pool.query<Connection>(
    `SELECT id, org_id, server_url, access_token
       FROM mcp_connections
      WHERE provider = 'meta' AND status = 'connected'`,
  );

  const result: MetaMcpSyncResult = {
    connections: connections.length,
    fetched: 0,
    created: 0,
    skipped: 0,
    errors: 0,
  };

  for (const connection of connections) {
    try {
      const one = await syncOne(connection);
      result.fetched += one.fetched;
      result.created += one.created;
      result.skipped += one.skipped;
    } catch (err) {
      result.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`meta-mcp ${connection.id}: sync failed:`, message);
      // Recorded on the row so the console can explain itself rather than
      // showing a connection that looks healthy and quietly produces nothing.
      await pool
        .query(`UPDATE mcp_connections SET status = 'error', last_error = $2 WHERE id = $1`, [
          connection.id,
          message.slice(0, 500),
        ])
        .catch(() => {});
    }
  }

  return result;
}

async function syncOne(
  connection: Connection,
): Promise<{ fetched: number; created: number; skipped: number }> {
  const client = new McpClient({
    serverUrl: connection.server_url,
    accessToken: connection.access_token ? decryptSecret(connection.access_token) : null,
    assertUrl: assertPublicHttpUrl,
  });

  const tools = await client.listTools();
  const tool = findTool(tools, LEAD_TOOL_CANDIDATES);
  if (!tool) {
    throw new Error(
      `this MCP server advertises no lead-fetching tool (looked for: ${LEAD_TOOL_CANDIDATES.join(", ")})`,
    );
  }

  const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString();
  // Several argument spellings at once. An MCP tool ignores arguments it does
  // not declare, so sending all of them costs nothing and means one code path
  // works against servers that name the same window differently. A server
  // that ignores every one of them just returns its own default window, which
  // the idempotent claim below handles anyway.
  const raw = await client.callTool(tool.name, {
    since,
    start_time: since,
    created_after: since,
    limit: MAX_LEADS_PER_SWEEP,
    max_results: MAX_LEADS_PER_SWEEP,
  });

  const leads = normalizeLeads(toolJson(raw)).slice(0, MAX_LEADS_PER_SWEEP);
  let created = 0;
  let skipped = 0;

  for (const lead of leads) {
    const outcome = await withOrgContext(connection.org_id, (db) =>
      ingestLead(db as unknown as DbClient, connection, lead),
    );
    if (outcome === "created") created += 1;
    else skipped += 1;
  }

  await getAdminPool().query(
    `UPDATE mcp_connections
        SET last_sync_at = now(), status = 'connected', last_error = NULL
      WHERE id = $1`,
    [connection.id],
  );

  console.log(
    `meta-mcp ${connection.id}: ${leads.length} lead(s) fetched, ${created} new, ${skipped} already had`,
  );
  return { fetched: leads.length, created, skipped };
}

/**
 * Off by default. This sweep makes outbound requests to a URL a tenant typed
 * in, so it stays behind an explicit flag rather than starting itself the
 * moment the code ships — the same off-unless-asked posture
 * EMAIL_SENDING_ENABLED and WHATSAPP_SENDING_ENABLED already have. With no
 * `meta` connection configured it is a no-op anyway; the flag is about the
 * operator having said yes, not about the query cost.
 */
export function startMetaMcpSweep(): NodeJS.Timeout | null {
  if (process.env.META_MCP_SYNC_ENABLED !== "true") return null;
  const interval = Number(process.env.META_MCP_SYNC_INTERVAL_MS ?? 10 * 60 * 1000);
  return setInterval(() => {
    void syncMetaMcpConnections().catch((err) => console.error("meta-mcp sweep:", err));
  }, interval);
}

/**
 * One lead, inside the org's RLS context.
 *
 * The claim comes FIRST and decides everything: `meta_leadgen_events` has a
 * unique index on `leadgen_id`, so `ON CONFLICT DO NOTHING` returning no row
 * means some other path — an earlier sweep, or the webhook — already has this
 * lead. Nothing else runs in that case. This is what makes the sweep safe to
 * run on an overlapping window forever.
 */
export async function ingestLead(
  client: DbClient,
  connection: Connection,
  lead: NormalizedLead,
): Promise<"created" | "skipped"> {
  const { rows: claimed } = await client.query<{ id: string }>(
    `INSERT INTO meta_leadgen_events
       (org_id, leadgen_id, page_id, form_id, raw, source, mcp_connection_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'mcp', $6)
     ON CONFLICT (leadgen_id) DO NOTHING
     RETURNING id`,
    [
      connection.org_id,
      lead.leadgenId,
      lead.pageId ?? "unknown",
      lead.formId,
      JSON.stringify(lead.raw),
      connection.id,
    ],
  );
  if (claimed.length === 0) return "skipped";
  const eventId = claimed[0].id;

  const {
    rows: [org],
  } = await client.query<{ lead_stages: unknown; workspace_id: string | null }>(
    // `leads.workspace_id` is NOT NULL, and an ad lead belongs to no handset,
    // so it is filed against the org's first workspace — the same one the
    // instance's devices report into.
    `SELECT o.lead_stages,
            (SELECT w.id FROM workspaces w WHERE w.org_id = o.id ORDER BY w.created_at LIMIT 1)
              AS workspace_id
       FROM organizations o WHERE o.id = $1`,
    [connection.org_id],
  );
  if (!org?.workspace_id) {
    // Nothing to attach the lead to. The claim row stays, carrying `raw`, so
    // the lead is not lost and a backfill can replay it once a workspace
    // exists — but it must not be counted as created.
    console.error(`meta-mcp: org ${connection.org_id} has no workspace; lead parked`);
    return "skipped";
  }

  const digits = phoneDigits(lead.phone);
  const hash = digits ? createHash("sha256").update(digits).digest("hex") : null;
  const title = lead.fullName?.trim() || lead.email?.trim() || (digits ? `${digits.slice(0, 5)}…` : "Meta lead");
  const activityAt = lead.createdTime ? new Date(lead.createdTime) : new Date();

  const {
    rows: [row],
  } = await client.query<{ id: string }>(
    `INSERT INTO leads
       (org_id, workspace_id, contact_name, contact_number_hash, contact_number_prefix,
        contact_number_last3, title, stage, summary, facts, last_activity_at, call_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
             -- An ad lead has had no calls. Starting at 0 rather than the
             -- column default of 1 keeps "calls" on the board honest.
             0)
     ON CONFLICT (workspace_id, contact_number_hash) WHERE contact_number_hash IS NOT NULL
     DO UPDATE SET
       -- Same contract as upsertLead: stage and status belong to the owner,
       -- never to an incoming lead. Someone who filled in an ad form after
       -- already being in Negotiation does not go back to New.
       contact_name = COALESCE(leads.contact_name, EXCLUDED.contact_name),
       summary      = COALESCE(EXCLUDED.summary, leads.summary),
       facts        = leads.facts || EXCLUDED.facts,
       last_activity_at = GREATEST(leads.last_activity_at, EXCLUDED.last_activity_at)
     RETURNING id`,
    [
      connection.org_id,
      org.workspace_id,
      lead.fullName,
      hash,
      digits ? digits.slice(0, 5) : null,
      digits ? digits.slice(-3) : null,
      title,
      entryStage(parseLeadStages(org.lead_stages)),
      lead.text ? lead.text.slice(0, 2000) : null,
      JSON.stringify(
        Object.fromEntries(
          Object.entries({
            source: "meta_lead_ads",
            email: lead.email,
            phone: digits,
            form_id: lead.formId,
          }).filter(([, v]) => v !== null && v !== undefined),
        ),
      ),
      activityAt,
    ],
  );

  await client.query(`UPDATE meta_leadgen_events SET lead_id = $2 WHERE id = $1`, [
    eventId,
    row.id,
  ]);

  // Project the ad lead onto Contact + Deal, through the SAME function the
  // call pipeline uses (pipeline.ts). Without this an ad lead reaches the
  // Lead Board and is invisible on Deals, Contacts and every report built on
  // them — which is precisely the split the webhook path (0063) has in the
  // other direction, creating a deal and no lead. Both doors now put a person
  // in the same four places.
  //
  // Non-blocking, matching how pipeline.ts treats the same call: a projection
  // failure must not lose the lead we have already committed.
  try {
    const projection = await projectLeadToCrm(client, connection.org_id, row.id);
    if (projection.reason === "no default pipeline for org") {
      console.error(
        `meta-mcp: org ${connection.org_id} has no default pipeline — lead ${row.id} is on the board but has no deal`,
      );
    }
    await client.query(`UPDATE meta_leadgen_events SET contact_id = $2, deal_id = $3 WHERE id = $1`, [
      eventId,
      projection.contactId,
      projection.dealId,
    ]);
  } catch (err) {
    console.error(`meta-mcp: crm projection failed for lead ${row.id} (non-blocking):`, err);
  }

  // The same project catalogue the call pipeline matches against, run over
  // the form/campaign/ad names and the lead's own answers — so an ad lead
  // lands on the right project board without anyone mapping forms by hand.
  // AFTER the projection, so the deal exists and gets labelled too.
  await detectProjectsForText(client, connection.org_id, lead.text, row.id);

  return "created";
}
