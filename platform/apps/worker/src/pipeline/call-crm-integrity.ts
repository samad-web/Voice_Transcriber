import { getAdminPool, withOrgContext } from "@aura/db";

/**
 * Does a call's own AI read agree with what the CRM ended up recording?
 *
 * Structurally similar to crm-reconcile.ts (org iteration → withOrgContext,
 * batch/window consts) but a DIFFERENT comparison - that sweep checks
 * leads↔deals/contacts staying in sync with each other; this checks a call's
 * OWN outcome/quality signal against the deal it produced (or failed to).
 * Unlike crm-reconcile, this is ON BY DEFAULT: it is a permanent product
 * surface with its own resolve workflow (call_crm_integrity_flags.status),
 * not an opt-in burn-in instrument for a migration in progress.
 *
 * Three flag types, deliberately kept structural (comparable in one query)
 * rather than semantic - this is a triage queue for a human, not a verdict:
 *
 * - no_deal_from_positive_call: the call read as interested (or scored well)
 *   but produced no deal at all. Either the lead-qualification rule missed
 *   it, or the agent never actually logged the outcome anywhere durable.
 * - outcome_status_contradiction: the call's read and the deal's current
 *   status point opposite directions - not_interested but won, or a
 *   strong-signal call whose deal is marked lost.
 * - stalled_after_positive_call: a deal that started from a clearly
 *   promising call has gone quiet - the SLA-adjacent case, only knowable
 *   after time passes, which is why this runs as a sweep and not inline in
 *   the pipeline (pipeline.ts only ever sees the instant the call completed).
 */

const BATCH = positiveInt(process.env.CALL_CRM_INTEGRITY_BATCH, 500);
/** Only calls completed recently - an old call's integrity is either already
 *  flagged or already resolved; re-scanning it forever adds nothing. */
const WINDOW_DAYS = positiveInt(process.env.CALL_CRM_INTEGRITY_WINDOW_DAYS, 7);
/** How stale a deal must be before "no update since a promising call" counts. */
const STALL_DAYS = positiveInt(process.env.CALL_CRM_INTEGRITY_STALL_DAYS, 5);
/** call_analytics.quality_score at or above this counts as a "strong signal"
 *  call, alongside (not instead of) an explicit 'interested' outcome. */
const QUALITY_THRESHOLD = positiveInt(process.env.CALL_CRM_INTEGRITY_QUALITY_THRESHOLD, 70);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

type Queryable = {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
};

interface Flag {
  callId: string;
  dealId: string | null;
  flagType: "no_deal_from_positive_call" | "outcome_status_contradiction";
  details: Record<string, unknown>;
}

function isPositive(outcome: string | null, qualityScore: number | null): boolean {
  return outcome === "interested" || (qualityScore !== null && qualityScore >= QUALITY_THRESHOLD);
}

interface CallRow {
  call_id: string;
  outcome: string | null;
  quality_score: number | null;
  deal_id: string | null;
  deal_status: string | null;
}

function findCallFlags(row: CallRow): Flag[] {
  const positive = isPositive(row.outcome, row.quality_score);
  const flags: Flag[] = [];

  if (positive && !row.deal_id) {
    flags.push({
      callId: row.call_id,
      dealId: null,
      flagType: "no_deal_from_positive_call",
      details: { outcome: row.outcome, qualityScore: row.quality_score },
    });
    return flags; // nothing on the deal side to compare without one
  }

  if (row.deal_id) {
    if (row.outcome === "not_interested" && row.deal_status === "won") {
      flags.push({
        callId: row.call_id,
        dealId: row.deal_id,
        flagType: "outcome_status_contradiction",
        details: { outcome: row.outcome, dealStatus: row.deal_status },
      });
    } else if (positive && row.deal_status === "lost") {
      flags.push({
        callId: row.call_id,
        dealId: row.deal_id,
        flagType: "outcome_status_contradiction",
        details: { outcome: row.outcome, qualityScore: row.quality_score, dealStatus: row.deal_status },
      });
    }
  }

  return flags;
}

interface StalledDealRow {
  deal_id: string;
  first_call_outcome: string | null;
  first_call_quality: number | null;
  last_activity_at: Date;
}

/** Only new (not-already-open) flags get inserted, so a repeat sweep over an
 *  unchanged call/deal pair is a no-op. */
async function insertFlag(
  client: Queryable,
  orgId: string,
  flag: Flag | { callId: string; dealId: string; flagType: "stalled_after_positive_call"; details: Record<string, unknown> },
): Promise<boolean> {
  const { rows } = await client.query<{ inserted: boolean }>(
    `INSERT INTO call_crm_integrity_flags (org_id, call_id, deal_id, flag_type, details)
     SELECT $1, $2, $3, $4, $5::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM call_crm_integrity_flags
         WHERE call_id = $2 AND flag_type = $4 AND status = 'open'
      )
     RETURNING true AS inserted`,
    [orgId, flag.callId, flag.dealId, flag.flagType, JSON.stringify(flag.details)],
  );
  return rows.length > 0;
}

/** Compare one org's recently-completed calls against the deal they produced
 *  (or failed to), plus its recently-stalled deals against their first call. */
export async function checkOrgIntegrity(client: Queryable, orgId: string): Promise<number> {
  const { rows: callRows } = await client.query<CallRow>(
    `SELECT c.id AS call_id,
            t.intelligence->>'outcome' AS outcome,
            ca.quality_score,
            i.deal_id,
            d.status AS deal_status
       FROM calls c
       LEFT JOIN transcripts t     ON t.call_id = c.id
       LEFT JOIN call_analytics ca ON ca.call_id = c.id
       LEFT JOIN interactions i    ON i.call_id = c.id AND i.type = 'call'
       LEFT JOIN deals d           ON d.id = i.deal_id
      WHERE c.status = 'COMPLETE'
        AND c.started_at > now() - make_interval(days => $1)
      ORDER BY c.started_at DESC
      LIMIT $2`,
    [WINDOW_DAYS, BATCH],
  );

  let logged = 0;
  for (const row of callRows) {
    for (const flag of findCallFlags(row)) {
      if (await insertFlag(client, orgId, flag)) logged++;
    }
  }

  const { rows: stalledRows } = await client.query<StalledDealRow>(
    `SELECT d.id AS deal_id,
            t.intelligence->>'outcome' AS first_call_outcome,
            ca.quality_score AS first_call_quality,
            d.last_activity_at
       FROM deals d
       LEFT JOIN transcripts t     ON t.call_id = d.first_call_id
       LEFT JOIN call_analytics ca ON ca.call_id = d.first_call_id
      WHERE d.status = 'open'
        AND d.last_activity_at < now() - make_interval(days => $1)
        -- Bounded window: a deal stale for months has either already been
        -- flagged or is being tracked some other way - re-flagging it forever
        -- would just be noise the owner has already dismissed once.
        AND d.last_activity_at > now() - make_interval(days => $2)
      LIMIT $3`,
    [STALL_DAYS, WINDOW_DAYS + STALL_DAYS, BATCH],
  );

  for (const row of stalledRows) {
    if (!isPositive(row.first_call_outcome, row.first_call_quality)) continue;
    if (!row.deal_id) continue;
    const inserted = await client.query<{ inserted: boolean }>(
      `INSERT INTO call_crm_integrity_flags (org_id, call_id, deal_id, flag_type, details)
       SELECT $1, NULL, $2, 'stalled_after_positive_call', $3::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM call_crm_integrity_flags
           WHERE deal_id = $2 AND flag_type = 'stalled_after_positive_call' AND status = 'open'
        )
       RETURNING true AS inserted`,
      [
        orgId,
        row.deal_id,
        JSON.stringify({
          firstCallOutcome: row.first_call_outcome,
          firstCallQuality: row.first_call_quality,
          lastActivityAt: row.last_activity_at,
        }),
      ],
    );
    if (inserted.rows.length > 0) logged++;
  }

  return logged;
}

/** Runs across every active org, each under its own RLS context - same shape as crm-reconcile.ts. */
export async function sweepCallCrmIntegrity(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<{ id: string }>(
    "SELECT id FROM organizations WHERE status = 'active'",
  );

  let total = 0;
  for (const org of orgs) {
    total += await withOrgContext(org.id, (client) => checkOrgIntegrity(client, org.id));
  }
  if (total > 0) console.log(`call-crm integrity: flagged ${total} new item(s)`);
  return total;
}

/** Every 30 minutes, same cadence as crm-reconcile - frequent enough to catch
 *  drift without hammering every org's calls/deals tables. */
export function startCallCrmIntegritySweep(): NodeJS.Timeout {
  const interval = positiveInt(process.env.CALL_CRM_INTEGRITY_INTERVAL_MS, 30 * 60 * 1000);
  setTimeout(() => {
    void sweepCallCrmIntegrity().catch((err) => console.error("call-crm integrity:", err));
  }, 60_000).unref?.();

  return setInterval(
    () => void sweepCallCrmIntegrity().catch((err) => console.error("call-crm integrity:", err)),
    interval,
  );
}
