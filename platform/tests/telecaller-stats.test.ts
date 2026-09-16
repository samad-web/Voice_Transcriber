import { beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./setup/migrate.js";
import { TENANT_A, TENANT_B, queryRows, seedTenants } from "./setup/tenants.js";

/**
 * The productivity rollup's SQL (migration 0088), against a real Postgres.
 *
 * ── WHY THIS IS AN INTEGRATION TEST AND NOT A UNIT TEST ─────────────────────
 *
 * Every decision worth testing here lives in the SQL: `percentile_cont` over an
 * empty set, `sum()` over an all-null column, a `LEAD()` window partitioned by
 * a timezone-derived date, and the `gap_s >= 0` filter. A mocked pg client
 * proves only that the string was sent. The failure this guards against -
 * a coaching number that is confidently wrong - is precisely the class that a
 * mock reproduces perfectly and a database does not.
 *
 * The sibling unit test (apps/worker/src/pipeline/talk-metrics-gate.test.ts)
 * covers the same hazard one layer up, for the same reason.
 *
 * Seeded underneath the application as the superuser, like tenants.ts, so the
 * fixture is an independent statement of what happened rather than something
 * the write path agreed with itself about.
 */

/** Fixed instants so the assertions are arithmetic, not "roughly". */
const DAY = "2026-03-04";
const AT = (hhmm: string) => `${DAY}T${hhmm}:00+05:30`;

const TELECALLER_A = TENANT_A.telecallerId;
const TELECALLER_B = TENANT_B.telecallerId;

/**
 * A second telecaller in tenant A, for the single-call-day case. Kept separate
 * from the fixture's own telecaller so the busy day and the quiet day can both
 * be asserted from one seeding pass.
 */
const QUIET_TELECALLER = "00000000-0000-4000-8000-00000000f0a2";

/**
 * The statement under test, copied from
 * apps/worker/src/pipeline/telecaller-stats.ts.
 *
 * DUPLICATED ON PURPOSE, and the duplication is the point of the test rather
 * than a shortcut: importing the worker's constant would let a change to the
 * SQL and a change to the expectations land in the same commit and still pass.
 * Copied, a drift shows up as this file failing, which is when somebody has to
 * decide whether the new behaviour is the intended one.
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
`;

interface StatsRow extends Record<string, unknown> {
  telecaller_id: string;
  day: Date;
  calls_total: number;
  calls_connected: number;
  total_call_seconds: number;
  median_gap_seconds: number | null;
  p90_gap_seconds: number | null;
  longest_gap_seconds: number | null;
  active_span_seconds: number | null;
  agent_talk_seconds: number | null;
  mean_talk_ratio: string | null;
  talk_sample_calls: number;
}

async function seedCall(
  tenant: typeof TENANT_A,
  telecallerId: string,
  id: string,
  startsAt: string,
  durationS: number,
): Promise<void> {
  await queryRows(
    `INSERT INTO calls (id, org_id, workspace_id, device_id, telecaller_id,
                        direction, started_at, duration_s, status)
     VALUES ($1, $2, $3, $4, $5, 'outgoing', $6::timestamptz, $7, 'COMPLETE')
     ON CONFLICT (id) DO UPDATE
       SET started_at = EXCLUDED.started_at,
           duration_s = EXCLUDED.duration_s,
           telecaller_id = EXCLUDED.telecaller_id`,
    [id, tenant.orgId, tenant.workspaceId, tenant.deviceId, telecallerId, startsAt, durationS],
  );
}

async function rollup(orgId: string): Promise<void> {
  await queryRows(ROLLUP_SQL, [
    orgId,
    "Asia/Kolkata",
    `${DAY}T00:00:00+05:30`,
    `2026-03-06T00:00:00+05:30`,
    15,
  ]);
}

async function statsFor(orgId: string, telecallerId: string): Promise<StatsRow | undefined> {
  const rows = await queryRows<StatsRow>(
    `SELECT * FROM telecaller_daily_stats
      WHERE org_id = $1 AND telecaller_id = $2 AND day = $3::date`,
    [orgId, telecallerId, DAY],
  );
  return rows[0];
}

describe("telecaller productivity rollup (0088)", () => {
  beforeAll(async () => {
    // Both calls are this file standing on its own feet rather than on the
    // order vitest happens to pick. `setup.test.ts` drops and rebuilds the
    // schema inside a test of its own, and `seedTenants` DELETEs the two
    // organizations before re-inserting them - which cascades through `calls`
    // and `telecaller_daily_stats`. Either one running first would otherwise
    // leave this file asserting against a fixture that is not there.
    //
    // Seeded once in beforeAll rather than per-test, unlike isolation.test.ts:
    // the cases here deliberately BUILD on each other (a partially-diarized
    // day, then an overlapping call), each re-running the rollup over what it
    // just added. Re-seeding between them would delete the day being built.
    await runMigrations();
    await seedTenants();

    // A second telecaller for the quiet-day case.
    await queryRows(
      `INSERT INTO telecallers (id, org_id, display_name)
       VALUES ($1, $2, 'Quiet Rep') ON CONFLICT (id) DO NOTHING`,
      [QUIET_TELECALLER, TENANT_A.orgId],
    );

    // Tenant A's busy rep. Four calls, three gaps: 600s, 1800s, 300s.
    //   09:00 + 300s  -> ends 09:05, next starts 09:15  => gap 600
    //   09:15 + 600s  -> ends 09:25, next starts 09:55  => gap 1800
    //   09:55 + 300s  -> ends 10:00, next starts 10:05  => gap 300
    //   10:05 + 10s   -> ends 10:05:10, last call of the day => no gap
    await seedCall(
      TENANT_A,
      TELECALLER_A,
      "00000000-0000-4000-8000-0000000c0a01",
      AT("09:00"),
      300,
    );
    await seedCall(
      TENANT_A,
      TELECALLER_A,
      "00000000-0000-4000-8000-0000000c0a02",
      AT("09:15"),
      600,
    );
    await seedCall(
      TENANT_A,
      TELECALLER_A,
      "00000000-0000-4000-8000-0000000c0a03",
      AT("09:55"),
      300,
    );
    // Ten seconds: under the 15s connected threshold, so it counts toward
    // calls_total and not calls_connected.
    await seedCall(TENANT_A, TELECALLER_A, "00000000-0000-4000-8000-0000000c0a04", AT("10:05"), 10);

    // The quiet rep: exactly one call, so there is no gap to take a median of.
    await seedCall(
      TENANT_A,
      QUIET_TELECALLER,
      "00000000-0000-4000-8000-0000000c0a05",
      AT("11:00"),
      120,
    );

    await rollup(TENANT_A.orgId);
  });

  it("computes the median gap between calls from the call rows alone", async () => {
    const row = await statsFor(TENANT_A.orgId, TELECALLER_A);
    // Gaps are 600, 1800, 300 -> sorted 300, 600, 1800 -> median 600.
    expect(row?.median_gap_seconds).toBe(600);
    expect(row?.longest_gap_seconds).toBe(1800);
  });

  it("counts calls and connected calls separately", async () => {
    const row = await statsFor(TENANT_A.orgId, TELECALLER_A);
    expect(row?.calls_total).toBe(4);
    // The ten-second call reached nobody.
    expect(row?.calls_connected).toBe(3);
    expect(row?.total_call_seconds).toBe(300 + 600 + 300 + 10);
  });

  it("reports the active span from the first call to the last", async () => {
    const row = await statsFor(TENANT_A.orgId, TELECALLER_A);
    // 09:00:00 to 10:05:10 = 3910s. A span, not time worked - see 0088.
    expect(row?.active_span_seconds).toBe(3910);
  });

  it("leaves the median gap NULL on a day with a single call, never 0", async () => {
    // The whole reason percentile_cont is used over an empty set rather than
    // COALESCE'd: a rep who took one call did not have a zero-second gap
    // between calls, and a 0 on a coaching page reads as relentless efficiency.
    const row = await statsFor(TENANT_A.orgId, QUIET_TELECALLER);
    expect(row?.calls_total).toBe(1);
    expect(row?.median_gap_seconds).toBeNull();
    expect(row?.longest_gap_seconds).toBeNull();
  });

  it("leaves every talk column NULL when no call carried talk metrics", async () => {
    // The diarization gate, at the aggregate level. `sum()` over an all-null
    // column is NULL rather than 0, which is what stops a non-diarized floor
    // reporting that nobody spoke all day.
    const row = await statsFor(TENANT_A.orgId, TELECALLER_A);
    expect(row?.agent_talk_seconds).toBeNull();
    expect(row?.mean_talk_ratio).toBeNull();
    expect(row?.talk_sample_calls).toBe(0);
  });

  it("counts only the calls that actually carried talk metrics", async () => {
    // One of the four calls gets analytics, as a partially-diarized day would.
    await queryRows(
      `INSERT INTO call_analytics (org_id, call_id, agent_talk_seconds,
                                   customer_talk_seconds, talk_ratio, interruption_count)
       VALUES ($1, $2, 180, 120, 0.600, 2)
       ON CONFLICT (call_id) DO UPDATE SET agent_talk_seconds = EXCLUDED.agent_talk_seconds`,
      [TENANT_A.orgId, "00000000-0000-4000-8000-0000000c0a01"],
    );
    await rollup(TENANT_A.orgId);

    const row = await statsFor(TENANT_A.orgId, TELECALLER_A);
    expect(row?.agent_talk_seconds).toBe(180);
    // 1 of 4 - the console reads the talk figures against this rather than
    // against calls_total, so a partial sample cannot masquerade as the day.
    expect(row?.talk_sample_calls).toBe(1);
    expect(Number(row?.mean_talk_ratio)).toBeCloseTo(0.6, 3);
  });

  it("excludes overlapping calls rather than recording a negative gap", async () => {
    // Two calls from one handset cannot genuinely overlap; when it happens it
    // is clock skew between the device and the server. Counting it would drag
    // the median below zero, which is the kind of number nobody can explain.
    await seedCall(
      TENANT_A,
      QUIET_TELECALLER,
      "00000000-0000-4000-8000-0000000c0a06",
      // Starts 60s BEFORE the 11:00 call ends.
      AT("11:01"),
      120,
    );
    await rollup(TENANT_A.orgId);

    const row = await statsFor(TENANT_A.orgId, QUIET_TELECALLER);
    expect(row?.calls_total).toBe(2);
    // The one gap available was negative, so it was dropped - leaving no gaps
    // at all rather than a negative median.
    expect(row?.median_gap_seconds).toBeNull();
  });

  it("writes nothing for a tenant whose calls it did not read", async () => {
    // The rollup runs inside withOrgContext in production, so RLS scopes it.
    // Here it runs as the superuser with an explicit org_id, which is the
    // weaker case - and it still must not manufacture a row for tenant B.
    await rollup(TENANT_A.orgId);
    const leaked = await queryRows(
      `SELECT 1 FROM telecaller_daily_stats WHERE org_id = $1 AND telecaller_id = $2`,
      [TENANT_A.orgId, TELECALLER_B],
    );
    expect(leaked).toHaveLength(0);
  });
});
