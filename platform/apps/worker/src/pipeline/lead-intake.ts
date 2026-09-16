import { createHash, randomBytes } from "node:crypto";
import { routeLead } from "@aura/db";
import { entryStage, parseLeadStages, phoneDigits, statusForStage } from "@aura/shared";
import type { LeadSourceKind } from "@aura/shared";
import type { DbClient } from "./crm-dispatch";
import { projectLeadToCrm } from "./crm-objects";
import { detectProjectsForText } from "./projects";

/**
 * The worker's half of the lead intake engine (migration 0078).
 *
 * ── WHY THIS EXISTS ALONGSIDE THE API'S LeadIntakeService ─────────────────
 *
 * Channels that are PUSHED (a web form, a telephony webhook, an inbound email,
 * a Meta lead) arrive at an HTTP route, so their write lives in the API.
 * Channels that must be PULLED - LinkedIn, which has no lead webhook - arrive
 * on a sweep, and every sweep in this platform lives in the worker. The API's
 * Nest container is not reachable from here.
 *
 * So there are two writers, and the risk that they drift is real. Three things
 * hold them together, in descending order of how much work they do:
 *
 *  1. Both normalise through `@aura/shared`, so "what is this person's name"
 *     has exactly one answer.
 *  2. Both write the SAME column set on `leads`, with the same first-touch
 *     COALESCE rules, and both then call `projectLeadToCrm` - the same function
 *     the call pipeline uses - to reach contacts and deals.
 *  3. Both claim in `lead_intake_events` before writing, so a lead cannot be
 *     ingested twice no matter which door it came through.
 *
 * What is NOT duplicated: dedup keys, project detection, and the CRM
 * projection. Those are single implementations both sides call.
 */

export interface IntakeLeadInput {
  externalId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  /** What the person said - the enquiry, the form answers. */
  notes: string | null;
  /** Name + campaign + answers, for project detection. */
  text: string;
  occurredAt: Date | null;
  facts: Record<string, unknown>;
  raw: unknown;
}

export interface IntakeSourceRow {
  id: string;
  workspace_id: string | null;
  marketing_source_id: string | null;
  project_id: string | null;
  assigned_telecaller_id: string | null;
  status: string;
}

/**
 * Find-or-create the `lead_sources` row a pulled channel attributes to.
 *
 * Identical in intent to `LeadIntakeService.ensureManagedSource`, and relies on
 * the same `lead_sources_org_kind_name` unique index - which is what makes two
 * concurrent sweeps converge on one row instead of racing to make two.
 */
export async function ensureLeadSource(
  client: DbClient,
  orgId: string,
  kind: LeadSourceKind,
  name: string,
  provider: string,
): Promise<IntakeSourceRow> {
  const {
    rows: [row],
  } = await client.query<IntakeSourceRow>(
    `INSERT INTO lead_sources (org_id, kind, name, provider, intake_token)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, kind, lower(btrim(name)))
     DO UPDATE SET updated_at = lead_sources.updated_at
     RETURNING id, workspace_id, marketing_source_id, project_id, assigned_telecaller_id, status`,
    [orgId, kind, name, provider, randomBytes(32).toString("base64url")],
  );
  return row;
}

/**
 * One pulled lead, inside the org's RLS context.
 *
 * The claim comes FIRST and decides everything: `lead_intake_events` is unique
 * on `(source_id, external_id)`, so `ON CONFLICT DO NOTHING` returning no row
 * means an earlier sweep already has this lead. Nothing else runs in that case,
 * which is what makes an overlapping fetch window free.
 */
export async function ingestIntakeLead(
  client: DbClient,
  orgId: string,
  kind: LeadSourceKind,
  source: IntakeSourceRow,
  lead: IntakeLeadInput,
): Promise<"created" | "skipped"> {
  if (source.status !== "active") return "skipped";

  const { rows: claimed } = await client.query<{ id: string }>(
    `INSERT INTO lead_intake_events (org_id, source_id, channel, external_id, payload, outcome, reason)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'rejected', 'processing')
     ON CONFLICT (source_id, external_id) WHERE external_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [orgId, source.id, kind, lead.externalId, JSON.stringify(lead.raw ?? {})],
  );
  if (claimed.length === 0) return "skipped";
  const eventId = claimed[0].id;

  if (!lead.phone && !lead.email && !lead.name) {
    await client.query(
      `UPDATE lead_intake_events
          SET outcome = 'rejected', reason = $2, processed_at = now()
        WHERE id = $1`,
      [eventId, "no name, phone or email in this lead"],
    );
    return "skipped";
  }

  const {
    rows: [org],
  } = await client.query<{ lead_stages: unknown; workspace_id: string | null }>(
    // `leads.workspace_id` is NOT NULL, and an ad lead belongs to no handset,
    // so it is filed against the source's workspace or the org's first one -
    // the same one the instance's devices report into.
    `SELECT o.lead_stages,
            COALESCE(
              (SELECT w.id FROM workspaces w WHERE w.org_id = o.id AND w.id = $2::uuid),
              (SELECT w.id FROM workspaces w WHERE w.org_id = o.id ORDER BY w.created_at LIMIT 1)
            ) AS workspace_id
       FROM organizations o WHERE o.id = $1`,
    [orgId, source.workspace_id],
  );
  if (!org?.workspace_id) {
    // Nothing to attach the lead to. The event row stays, carrying the raw
    // payload, so the lead is not lost and can be replayed from the console
    // once a workspace exists - but it must not be counted as created.
    await client.query(
      `UPDATE lead_intake_events SET outcome = 'error', reason = $2, processed_at = now()
        WHERE id = $1`,
      [eventId, "this organization has no workspace to attach a lead to"],
    );
    return "skipped";
  }

  const digits = phoneDigits(lead.phone);
  const hash = digits ? createHash("sha256").update(digits).digest("hex") : null;
  const title =
    lead.name?.trim() || lead.email?.trim() || (digits ? `${digits.slice(0, 5)}…` : "Ad lead");
  const stages = parseLeadStages(org.lead_stages);
  const stage = entryStage(stages);
  const activityAt = lead.occurredAt ?? new Date();

  const facts = {
    ...lead.facts,
    intake_channel: kind,
    ...(lead.email ? { email: lead.email } : {}),
    ...(digits ? { phone: digits } : {}),
    ...(lead.company ? { company: lead.company } : {}),
  };

  const {
    rows: [row],
  } = await client.query<{ id: string; created: boolean }>(
    `INSERT INTO leads
       (org_id, workspace_id, contact_name, contact_number_hash, contact_number_prefix,
        contact_number_last3, title, stage, status, summary, facts, last_activity_at, call_count,
        source_channel, lead_source_id, marketing_source_id, assigned_telecaller_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
             -- An ad lead has had no calls. Starting at 0 rather than the
             -- column default of 1 keeps "calls" on the board honest.
             0, $13, $14, $15, $16)
     ON CONFLICT (workspace_id, contact_number_hash) WHERE contact_number_hash IS NOT NULL
     DO UPDATE SET
       -- Same contract as upsertLead and the API's writeLead: stage and status
       -- belong to the owner, never to an incoming lead. Someone who filled in
       -- an ad form after already being in Negotiation does not go back to New,
       -- and first-touch attribution is never re-credited to a later channel.
       contact_name = COALESCE(leads.contact_name, EXCLUDED.contact_name),
       summary      = COALESCE(EXCLUDED.summary, leads.summary),
       facts        = leads.facts || EXCLUDED.facts,
       source_channel      = COALESCE(leads.source_channel, EXCLUDED.source_channel),
       lead_source_id      = COALESCE(leads.lead_source_id, EXCLUDED.lead_source_id),
       marketing_source_id = COALESCE(leads.marketing_source_id, EXCLUDED.marketing_source_id),
       assigned_telecaller_id =
         COALESCE(leads.assigned_telecaller_id, EXCLUDED.assigned_telecaller_id),
       last_activity_at = GREATEST(leads.last_activity_at, EXCLUDED.last_activity_at)
     RETURNING id, (xmax = 0) AS created`,
    [
      orgId,
      org.workspace_id,
      lead.name,
      hash,
      digits ? digits.slice(0, 5) : null,
      digits ? digits.slice(-3) : null,
      title,
      stage,
      statusForStage(stages, stage),
      lead.notes ? lead.notes.slice(0, 2000) : null,
      JSON.stringify(facts),
      activityAt,
      kind,
      source.id,
      source.marketing_source_id,
      source.assigned_telecaller_id,
    ],
  );

  // Project onto Contact + Deal through the SAME function the call pipeline
  // uses. Without it the lead reaches the board and is invisible on Deals,
  // Contacts and every report built on them.
  //
  // Non-blocking, matching how pipeline.ts treats the same call: a projection
  // failure must not lose the lead already written in this transaction.
  let contactId: string | null = null;
  let dealId: string | null = null;
  try {
    const projection = await projectLeadToCrm(client, orgId, row.id, { emitEvents: true });
    contactId = projection.contactId;
    dealId = projection.dealId;
    if (projection.reason === "no default pipeline for org") {
      console.error(
        `lead-intake: org ${orgId} has no default pipeline - lead ${row.id} is on the board but has no deal`,
      );
    }
  } catch (err) {
    console.error(`lead-intake: crm projection failed for lead ${row.id} (non-blocking):`, err);
  }

  // The tenant's own project catalogue, matched against the campaign and the
  // lead's answers - so an ad lead lands on the right project board without
  // anybody mapping forms by hand. AFTER the projection, so the deal exists
  // and gets labelled too.
  await detectProjectsForText(client, orgId, lead.text, row.id);

  // A source pinned to one project overrides detection, and is recorded as a
  // human decision the detector may never overwrite - the same contract
  // `labelProject` applies on the API side.
  if (source.project_id) {
    await client.query(
      `UPDATE leads SET project_id = $2, project_source = 'human'
        WHERE id = $1 AND COALESCE(project_source, 'extraction') <> 'human'`,
      [row.id, source.project_id],
    );
  }

  // The distribution engine (0094), through the SAME entry point the API's
  // `writeLead` uses - see `packages/db/src/lead-routing.ts` for why routing
  // lives in @aura/db rather than being written once here and once there.
  //
  // Last, after the project label above, because a rule may match on
  // `project_id`. New leads only, and never over a source's named owner: a
  // re-submission must not move a lead off whoever is already working it, and
  // a person's explicit choice outranks a rotation.
  if (row.created && !source.assigned_telecaller_id) {
    await routeLead(client, orgId, { leadId: row.id, dealId, trigger: "intake" });
  }

  await client.query(
    `UPDATE lead_intake_events
        SET outcome = $2, reason = NULL, lead_id = $3, contact_id = $4, deal_id = $5,
            processed_at = now()
      WHERE id = $1`,
    [eventId, row.created ? "created" : "updated", row.id, contactId, dealId],
  );
  await client.query(
    `UPDATE lead_sources SET event_count = event_count + 1, last_event_at = now() WHERE id = $1`,
    [source.id],
  );

  return "created";
}

/**
 * Age out the ledger.
 *
 * The intake ledger holds a copy of every payload that ever arrived, which is
 * what makes a mapping mistake diagnosable and replayable - and also what would
 * make it the largest table in the schema inside a year. Ninety days is long
 * enough that a tenant noticing "our form stopped working last month" can still
 * replay, and short enough that the table stays a working record rather than an
 * archive.
 *
 * Rows that produced a lead are pruned too: the LEAD is the durable record, and
 * this is only the receipt.
 */
export async function pruneIntakeEvents(
  // Deliberately narrower than DbClient so the admin Pool satisfies it
  // directly - this is the one statement here that is cross-tenant by design.
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  days = 90,
): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM lead_intake_events WHERE received_at < now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  return rowCount ?? 0;
}
