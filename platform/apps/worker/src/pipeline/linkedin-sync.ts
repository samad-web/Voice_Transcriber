import { decryptSecret, encryptSecret, getAdminPool, withOrgContext } from "@aura/db";
import {
  fetchLeadFormResponses,
  linkedinConfigured,
  linkedinOAuthConfig,
  LinkedInHttpError,
  refreshLinkedInToken,
  type NormalizedLinkedInLead,
} from "@aura/shared";
import type { DbClient } from "./crm-dispatch";
import { ensureLeadSource, ingestIntakeLead, pruneIntakeEvents } from "./lead-intake";
import { announce } from "./realtime";

/**
 * Pull LinkedIn Lead Gen Form responses onto the lead board (migration 0078).
 *
 * ── WHY A SWEEP AND NOT A WEBHOOK ─────────────────────────────────────────
 *
 * Because LinkedIn does not offer one. Meta POSTs a leadgen_id the instant
 * somebody submits; LinkedIn expects you to ask. So the latency floor here is
 * the sweep interval, not the network, and a tenant told "leads appear within
 * ten minutes" is being told the truth rather than a hope.
 *
 * ── OFF UNLESS AN APPROVED APP EXISTS ─────────────────────────────────────
 *
 * The Lead Sync API is gated behind LinkedIn Marketing Developer Platform
 * approval, which only the operator can obtain. With no LINKEDIN_CLIENT_ID the
 * sweep does not start and says so once at boot - the same degrade-don't-fail
 * posture the Google and Microsoft connectors take, and the reason this
 * connector could be built and shipped complete before the app was approved.
 *
 * Same shape as every other sweep in this worker: cross-tenant off the admin
 * pool to find work, then re-enter each org's own RLS context to write it.
 */

/** How far back a sweep asks for. Overlap is free - the claim is idempotent. */
const LOOKBACK_HOURS = Number(process.env.LINKEDIN_LOOKBACK_HOURS ?? 48);
/** A cap so a first sync against a busy ad account cannot run unbounded. */
const MAX_LEADS_PER_SWEEP = Number(process.env.LINKEDIN_MAX_LEADS ?? 200);
/** After this many consecutive failures a connection is parked. */
const MAX_FAILURES = 5;

interface ConnectionRow {
  id: string;
  org_id: string;
  account_urn: string;
  account_name: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: Date | null;
  sync_cursor: Date | null;
  sync_failures: number;
  lead_source_id: string | null;
}

export interface LinkedInSyncResult {
  connections: number;
  fetched: number;
  created: number;
  skipped: number;
  errors: number;
}

/**
 * A token about to expire is refreshed before it is used.
 *
 * LinkedIn access tokens last 60 days, so this fires rarely - but when it does,
 * the alternative is a connection that silently stops working two months after
 * somebody set it up and is never looked at again. Refresh tokens are only
 * issued to apps approved for them; without one the connection is marked
 * `expired` so the console can ask for a reconnect rather than retrying
 * forever.
 */
async function usableToken(connection: ConnectionRow): Promise<string | null> {
  const access = decryptSecret(connection.access_token);
  const expiresSoon =
    connection.token_expires_at !== null &&
    connection.token_expires_at.getTime() - Date.now() < 24 * 60 * 60 * 1000;
  if (access && !expiresSoon) return access;

  const refresh = decryptSecret(connection.refresh_token);
  const config = linkedinOAuthConfig();
  if (!refresh || !config) return access;

  const tokens = await refreshLinkedInToken(config, refresh);
  await getAdminPool().query(
    `UPDATE linkedin_connections
        SET access_token = $2, refresh_token = COALESCE($3, refresh_token),
            token_expires_at = $4, status = 'active'
      WHERE id = $1`,
    [
      connection.id,
      encryptSecret(tokens.accessToken),
      tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
      tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
    ],
  );
  return tokens.accessToken;
}

/** One connection: fetch, ingest, advance the cursor. */
export async function syncConnection(
  connection: ConnectionRow,
  fetchImpl: typeof fetch = fetch,
): Promise<{ fetched: number; created: number; skipped: number }> {
  // A grant whose ad account has not been chosen yet. The OAuth callback
  // stores the token against a placeholder urn precisely so nothing is ever
  // pulled from an account nobody picked - see linkedin-oauth.controller.ts.
  if (connection.account_urn.startsWith("pending:")) {
    return { fetched: 0, created: 0, skipped: 0 };
  }

  const token = await usableToken(connection);
  if (!token) throw new Error("no usable access token - reconnect this LinkedIn account");

  const since = connection.sync_cursor ?? new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const leads = await fetchLeadFormResponses(
    connection.account_urn,
    token,
    since,
    MAX_LEADS_PER_SWEEP,
    fetchImpl,
  );

  let created = 0;
  let skipped = 0;
  await withOrgContext(connection.org_id, async (raw) => {
    const client = raw as DbClient;
    const source = connection.lead_source_id
      ? await loadSource(client, connection.lead_source_id)
      : null;
    const target =
      source ??
      (await ensureLeadSource(
        client,
        connection.org_id,
        "linkedin_ads",
        connection.account_name
          ? `LinkedIn - ${connection.account_name}`
          : "LinkedIn Lead Gen Forms",
        "linkedin",
      ));

    for (const lead of leads) {
      const outcome = await ingestIntakeLead(client, connection.org_id, "linkedin_ads", target, {
        externalId: lead.leadId,
        name: lead.fullName,
        email: lead.email,
        phone: lead.phone,
        company: lead.company,
        notes: lead.text ? lead.text.slice(0, 2000) : null,
        text: lead.text,
        occurredAt: parseSubmittedAt(lead),
        facts: { linkedin_account: connection.account_urn },
        raw: lead.raw,
      });
      if (outcome === "created") created += 1;
      else skipped += 1;
    }
  });
  // After the commit, so a console re-reading on the signal sees the rows.
  if (created > 0) announce(connection.org_id, "lead", "created");

  // The cursor advances to the newest submission actually seen, NOT to now():
  // moving it to the wall clock would skip anything LinkedIn had not yet made
  // available when the sweep ran, and those leads would never be fetched again.
  const newest = leads
    .map((lead) => parseSubmittedAt(lead)?.getTime())
    .filter((time): time is number => typeof time === "number" && Number.isFinite(time))
    .reduce((max, time) => (time > max ? time : max), 0);
  await getAdminPool().query(
    `UPDATE linkedin_connections
        SET sync_cursor = COALESCE($2, sync_cursor), last_synced_at = now(),
            sync_failures = 0, last_error = NULL, status = 'active'
      WHERE id = $1`,
    [connection.id, newest > 0 ? new Date(newest) : null],
  );

  return { fetched: leads.length, created, skipped };
}

function parseSubmittedAt(lead: NormalizedLinkedInLead): Date | null {
  if (!lead.submittedAt) return null;
  const parsed = new Date(lead.submittedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function loadSource(client: DbClient, id: string) {
  const {
    rows: [row],
  } = await client.query<{
    id: string;
    workspace_id: string | null;
    marketing_source_id: string | null;
    project_id: string | null;
    assigned_telecaller_id: string | null;
    status: string;
  }>(
    `SELECT id, workspace_id, marketing_source_id, project_id, assigned_telecaller_id, status
       FROM lead_sources WHERE id = $1`,
    [id],
  );
  return row ?? null;
}

/** One pass over every connected LinkedIn account, least-recently-synced first. */
export async function syncLinkedInConnections(
  fetchImpl: typeof fetch = fetch,
): Promise<LinkedInSyncResult> {
  const pool = getAdminPool();
  const { rows: connections } = await pool.query<ConnectionRow>(
    `SELECT id, org_id, account_urn, account_name, access_token, refresh_token,
            token_expires_at, sync_cursor, sync_failures, lead_source_id
       FROM linkedin_connections
      WHERE status = 'active' AND sync_failures < $1
      ORDER BY last_synced_at NULLS FIRST
      LIMIT 50`,
    [MAX_FAILURES],
  );

  const result: LinkedInSyncResult = {
    connections: connections.length,
    fetched: 0,
    created: 0,
    skipped: 0,
    errors: 0,
  };

  for (const connection of connections) {
    try {
      const outcome = await syncConnection(connection, fetchImpl);
      result.fetched += outcome.fetched;
      result.created += outcome.created;
      result.skipped += outcome.skipped;
      if (outcome.created > 0) {
        console.log(
          `linkedin ${connection.account_name ?? connection.account_urn}: ` +
            `${outcome.fetched} fetched, ${outcome.created} new, ${outcome.skipped} already had`,
        );
      }
    } catch (err) {
      result.errors += 1;
      // A dead grant is parked immediately rather than after five tries -
      // retrying a revoked token never succeeds and only burns rate limit.
      const dead = err instanceof LinkedInHttpError && err.needsReconnect;
      await pool.query(
        `UPDATE linkedin_connections
            SET sync_failures = $2, last_error = $3, status = $4
          WHERE id = $1`,
        [
          connection.id,
          dead ? MAX_FAILURES : connection.sync_failures + 1,
          String(err instanceof Error ? err.message : err).slice(0, 500),
          dead ? "expired" : "active",
        ],
      );
      console.error(`linkedin sync ${connection.id}:`, err);
    }
  }

  // Age the intake ledger out on the same tick. It is a receipt, not an
  // archive - see pruneIntakeEvents - and this is the only cross-tenant sweep
  // that already holds an admin connection for it.
  try {
    await pruneIntakeEvents(pool);
  } catch (err) {
    console.error("lead intake prune:", err);
  }

  return result;
}

export function startLinkedInSweep(): NodeJS.Timeout | null {
  if (!linkedinConfigured()) {
    console.log(
      "linkedin lead sync: not configured (LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET) - sweep not started",
    );
    return null;
  }
  const raw = Number(process.env.LINKEDIN_SYNC_INTERVAL_MS);
  const interval = Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
  return setInterval(() => {
    void syncLinkedInConnections().catch((err) => console.error("linkedin sweep:", err));
  }, interval);
}
