import { getAdminPool, withOrgContext } from "@aura/db";

/**
 * The daily productivity rollup (migration 0090): how much each telecaller
 * called, how long they talked, and how long they sat idle between calls.
 *
 * Same shape as every other sweep here - cross-tenant off the admin pool to
 * find the orgs, then re-entering each org's RLS context to read and write its
 * rows. Pure computation over data that already exists: no LLM call, no
 * provider round trip, nothing sent anywhere.
 *
 * ── ONE STATEMENT PER ORG, ON PURPOSE ───────────────────────────────────────
 *
 * The whole rollup - volume, pacing, span and talk - is a single INSERT ... ON
 * CONFLICT DO UPDATE fed by CTEs, rather than a query per metric. The database
 * is ~125ms away (see DB_LATENCY_MIGRATION.md) and node-postgres does not
 * pipeline, so four aggregates written separately would be four round trips per
 * org per tick, forever. This is the same reasoning that collapsed the owner
 * dashboard from 15 exchanges to 4.
 *
 * ── WHY IT RECOMPUTES RATHER THAN ACCUMULATES ───────────────────────────────
 *
 * Every tick recomputes whole days from `calls`, and the unique key
 * (org_id, telecaller_id, day) makes that idempotent. It could instead
 * accumulate deltas since a cursor, which would be cheaper and would drift:
 * a call that arrives late (the handset was offline for a day, which is normal
 * on a telecalling floor), a reprocessed call, or a call the retention reaper
 * removes all change a day that has already been counted. Recomputing means
 * the rollup is always a function of the current `calls` rows rather than of
 * the history of ticks that produced it, so a wrong number is fixed by running
 * the sweep again rather than by hand-editing a total.
 *
 * The window is deliberately narrow - today plus the previous
 * TELECALLER_STATS_LOOKBACK_DAYS - because the cost is proportional to it.
 * Recomputing further back is an explicit call to `runTelecallerStats` with a
 * wider range, which is what the API's recompute endpoint does.
 */

/**
 * Duration at or above which a call counts as having reached a person.
 *
 * Deliberately NOT MIN_TRANSCRIBE_SECONDS (0084, default 5s): that number
 * decides what is worth paying an ASR provider to transcribe, and answers "is
 * there speech in this". This one decides what counts as a connected call on a
 * productivity dashboard, and answers "did somebody pick up and engage". A
 * six-second call has speech in it and is not a conversation.
 *
 * Per-org override lives in `organizations.connected_call_seconds`.
 */
const DEFAULT_CONNECTED_SECONDS = Number(process.env.CONNECTED_CALL_SECONDS ?? 15);

/** How many days back to recompute on every tick, beyond today. */
const LOOKBACK_DAYS = Number(process.env.TELECALLER_STATS_LOOKBACK_DAYS ?? 2);

interface OrgRow {
  id: string;
  reporting_timezone: string;
  connected_call_seconds: number | null;
}

/**
 * The rollup, as one statement.
 *
 * $1 org_id · $2 reporting timezone · $3 window start · $4 window end (exclusive)
 * $5 connected-call threshold in seconds
 *
 * NOTE ON NULLS. Nearly every metric column is left null rather than zeroed
 * when there is nothing to compute it from, and the aggregates below are
 * chosen so that falls out naturally rather than needing a CASE:
 *
 *   - `sum()` over an all-null column returns NULL, so a day of non-diarized
 *     calls writes NULL talk seconds rather than 0. That is the whole point of
 *     talk-metrics-gate.test.ts, one layer up.
 *   - `percentile_cont` over an empty set returns NULL, so a day with a single
 *     call has no median gap rather than a gap of 0.
 *   - `count(col)` counts non-nulls, which is exactly `talk_sample_calls`.
 */
const ROLLUP_SQL = `
WITH bounded AS (
  SELECT c.id,
         c.telecaller_id,
         (c.started_at AT TIME ZONE $2::text)::date AS day,
         c.started_at,
         c.started_at + make_interval(secs => COALESCE(c.duration_s, 0)) AS ended_at,
         COALESCE(c.duration_s, 0) AS duration_s
    FROM calls c
   WHERE c.telecaller_id IS NOT NULL
     AND c.started_at >= $3
     AND c.started_at <  $4
),
gaps AS (
  SELECT telecaller_id,
         day,
         EXTRACT(epoch FROM (
           LEAD(started_at) OVER (PARTITION BY telecaller_id, day ORDER BY started_at)
           - ended_at
         )) AS gap_s
    FROM bounded
),
gap_agg AS (
  SELECT telecaller_id,
         day,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_s)::int AS median_gap_seconds,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY gap_s)::int AS p90_gap_seconds,
         max(gap_s)::int AS longest_gap_seconds
    FROM gaps
   -- gap_s IS NULL is the last call of the day (LEAD found nothing).
   -- gap_s < 0 is two calls that overlap, which a single handset cannot
   -- genuinely do - it is clock skew between the device and the server, and
   -- counting it as negative idle time would drag the median below zero.
   WHERE gap_s IS NOT NULL AND gap_s >= 0
   GROUP BY 1, 2
),
call_agg AS (
  SELECT b.telecaller_id,
         b.day,
         count(*)::int AS calls_total,
         count(*) FILTER (WHERE b.duration_s >= $5)::int AS calls_connected,
         COALESCE(sum(b.duration_s), 0)::int AS total_call_seconds,
         min(b.started_at) AS first_call_at,
         max(b.ended_at)   AS last_call_at,
         EXTRACT(epoch FROM (max(b.ended_at) - min(b.started_at)))::int AS active_span_seconds,
         -- Non-null count: how many calls actually carried talk metrics.
         count(ca.agent_talk_seconds)::int AS talk_sample_calls,
         sum(ca.agent_talk_seconds)::int    AS agent_talk_seconds,
         sum(ca.customer_talk_seconds)::int AS customer_talk_seconds,
         avg(ca.talk_ratio)                 AS mean_talk_ratio,
         sum(ca.interruption_count)::int    AS interruption_count
    FROM bounded b
    LEFT JOIN call_analytics ca ON ca.call_id = b.id
   GROUP BY 1, 2
)
INSERT INTO telecaller_daily_stats (
  org_id, telecaller_id, day,
  calls_total, calls_connected, total_call_seconds,
  median_gap_seconds, p90_gap_seconds, longest_gap_seconds,
  first_call_at, last_call_at, active_span_seconds,
  agent_talk_seconds, customer_talk_seconds, mean_talk_ratio,
  interruption_count, talk_sample_calls, computed_at
)
SELECT $1, a.telecaller_id, a.day,
       a.calls_total, a.calls_connected, a.total_call_seconds,
       g.median_gap_seconds, g.p90_gap_seconds, g.longest_gap_seconds,
       a.first_call_at, a.last_call_at, a.active_span_seconds,
       a.agent_talk_seconds, a.customer_talk_seconds, a.mean_talk_ratio,
       a.interruption_count, a.talk_sample_calls, now()
  FROM call_agg a
  LEFT JOIN gap_agg g
    ON g.telecaller_id = a.telecaller_id AND g.day = a.day
ON CONFLICT (org_id, telecaller_id, day) DO UPDATE SET
  calls_total           = EXCLUDED.calls_total,
  calls_connected       = EXCLUDED.calls_connected,
  total_call_seconds    = EXCLUDED.total_call_seconds,
  median_gap_seconds    = EXCLUDED.median_gap_seconds,
  p90_gap_seconds       = EXCLUDED.p90_gap_seconds,
  longest_gap_seconds   = EXCLUDED.longest_gap_seconds,
  first_call_at         = EXCLUDED.first_call_at,
  last_call_at          = EXCLUDED.last_call_at,
  active_span_seconds   = EXCLUDED.active_span_seconds,
  agent_talk_seconds    = EXCLUDED.agent_talk_seconds,
  customer_talk_seconds = EXCLUDED.customer_talk_seconds,
  mean_talk_ratio       = EXCLUDED.mean_talk_ratio,
  interruption_count    = EXCLUDED.interruption_count,
  talk_sample_calls     = EXCLUDED.talk_sample_calls,
  computed_at           = now()
  -- presence_seconds is deliberately absent: it is written by the handset
  -- presence beacon, not by this sweep, and an EXCLUDED assignment here would
  -- null it out on every tick.
`;

/**
 * Recompute one org's rollup over a window.
 *
 * `from`/`to` are instants, not dates: the day boundary is applied inside the
 * statement using the org's own reporting_timezone, so the caller does not
 * have to know what a day means for this tenant.
 */
export async function rollupOrg(org: OrgRow, from: Date, to: Date): Promise<number> {
  return withOrgContext(org.id, async (client) => {
    const res = await client.query(ROLLUP_SQL, [
      org.id,
      org.reporting_timezone,
      from.toISOString(),
      to.toISOString(),
      org.connected_call_seconds ?? DEFAULT_CONNECTED_SECONDS,
    ]);
    return res.rowCount ?? 0;
  });
}

/**
 * Recompute every active org over the given window (default: the lookback).
 *
 * The window is widened by a day at each end before it reaches the statement.
 * That is not slack for its own sake: `day` is derived in the org's local
 * timezone, so an instant window aligned to UTC midnight clips the first and
 * last local day and would write a partial count for both. Recomputing a day
 * that is already correct is free; writing a partial one is a wrong number on
 * a coaching dashboard.
 */
export async function runTelecallerStats(from?: Date, to?: Date): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<OrgRow>(
    `SELECT id, reporting_timezone, connected_call_seconds
       FROM organizations
      WHERE status = 'active'`,
  );
  if (orgs.length === 0) return 0;

  const end = to ?? new Date();
  const start = from ?? new Date(end.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const padded = {
    from: new Date(start.getTime() - 24 * 60 * 60 * 1000),
    to: new Date(end.getTime() + 24 * 60 * 60 * 1000),
  };

  let written = 0;
  for (const org of orgs) {
    try {
      written += await rollupOrg(org, padded.from, padded.to);
    } catch (err) {
      // One tenant's bad data - an unparseable timezone that got past the
      // trigger, a clock so skewed the window is empty - must not stop the
      // sweep for every other tenant. Log and carry on; the next tick retries
      // it, because this recomputes rather than accumulating.
      console.error(`telecaller stats: org ${org.id}:`, err);
    }
  }
  if (written > 0) console.log(`telecaller stats: wrote ${written} rollup row(s)`);
  return written;
}

export function startTelecallerStatsSweep(): NodeJS.Timeout {
  const interval = Number(process.env.TELECALLER_STATS_INTERVAL_MS ?? 15 * 60 * 1000);
  return setInterval(() => {
    void runTelecallerStats().catch((err) => console.error("telecaller stats sweep:", err));
  }, interval);
}
