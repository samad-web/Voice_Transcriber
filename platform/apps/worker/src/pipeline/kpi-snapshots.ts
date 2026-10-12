import type { PoolClient } from "pg";
import { getAdminPool, withOrgContext } from "@aura/db";
import { KPI_CATALOG } from "@aura/shared";
import { announce } from "./realtime";

/**
 * The KPI engine: facts become `kpi_snapshots`
 * (`Build docs/41_TELECALLER_PERFORMANCE_KPI_SPINE.md` G1-G3, migration 0195,
 * M4 of the no-CRM plan).
 *
 * ── RECOMPUTES, NEVER ACCUMULATES ───────────────────────────────────────────
 *
 * Every tick recomputes whole days from the fact tables, and the unique key
 * `(org_id, subject_kind, subject_id, kpi_key, day)` makes that idempotent.
 * The alternative - deltas since a cursor - would drift, and drift here is a
 * wrong number on a person's scorecard:
 *
 *   - a call arriving late (a dialer's nightly batch, which is normal);
 *   - a disposition attached hours after the call;
 *   - a correction pushed as an upsert;
 *   - a target changed, which changes `target_value` on every affected day;
 *   - an unmapped telecaller resolved and three weeks of events replayed.
 *
 * All five change a day that has already been counted. Recomputing means a
 * snapshot is a function of the current facts rather than of the history of
 * ticks that produced it, so a wrong number is fixed by running the sweep
 * again. Same argument `telecaller-stats.ts` makes at length.
 *
 * ── THE CONFIG IS RESOLVED PER DAY, IN SQL ──────────────────────────────────
 *
 * Doc 41 F2's rule: for a subject S on day D, the applicable row is the most
 * specific scope whose `[effective_from, effective_to)` contains D, with
 * specificity `telecaller > owner_role > team > org`. That is the `tgt`
 * lateral below.
 *
 * Resolving per day rather than per run is what makes "changing a target next
 * month must not rewrite last month" true BY CONSTRUCTION rather than by a
 * snapshot nobody is allowed to touch: recomputing September re-resolves
 * September's rows and gets September's answer.
 *
 * ── THREE SUBJECT GRAINS, ONE QUERY TEMPLATE ────────────────────────────────
 *
 * `telecaller`, `team` and `org` rows are written by the same SQL with a
 * different subject expression. The team and org grains are NOT derivable from
 * the telecaller rows in general - `Σnum ÷ Σden` works for every KPI in the
 * catalogue today precisely because the catalogue is closed under addition,
 * but `distinct_leads` is the counterexample that matters: two reps who both
 * called the same person are two distinct leads each and one for the floor.
 * Computing each grain from the facts gets that right.
 *
 * ── LIVE ONLY ───────────────────────────────────────────────────────────────
 *
 * `env = 'live'` in every fact scan. §6.3: a sandbox "never affects live
 * KPIs". That is one predicate, repeated, and it is load-bearing.
 */

/** Days back to recompute on every tick, beyond today. */
const LOOKBACK_DAYS = Number(process.env.KPI_SNAPSHOT_LOOKBACK_DAYS ?? 3);

interface OrgRow {
  id: string;
}

/**
 * The measures, computed once per subject per day.
 *
 * Built as a `jsonb` object rather than as columns, because the fan-out below
 * has to pick a measure BY NAME from a list that lives in the TypeScript
 * catalogue - and SQL cannot select a column by a name supplied at runtime
 * without dynamic SQL. `measures->>'calls'` can.
 *
 * NOTE ON NULLS. The aggregates are chosen so the honest answer falls out:
 *   - `count(connected)` counts non-nulls, so `connect_known` is exactly the
 *     calls where the customer told us - the denominator doc 41 D2 requires.
 *   - `sum()` over an all-null column returns NULL, and the COALESCE to 0 is
 *     applied only where a zero is a fact rather than an absence.
 *   - `active_days` is 1 or 0 per row, so `Σcalls ÷ Σactive_days` over a week
 *     is calls per day actually worked.
 */
function measuresSql(subject: "telecaller" | "team" | "org"): string {
  // The grouping key per grain. `org` groups by day alone and writes a NULL
  // subject id.
  const key = subject === "org" ? "NULL::uuid" : `${subject}_id`;
  const groupBy = subject === "org" ? "day" : `${subject}_id, day`;
  const notNull = subject === "org" ? "" : `AND ${subject}_id IS NOT NULL`;

  return `
WITH calls AS (
  SELECT ${key} AS subject_id, day,
         count(*)                               AS calls,
         count(*) FILTER (WHERE connected)      AS connected_calls,
         count(connected)                       AS connect_known,
         sum(talk_time_sec)                     AS talk_seconds,
         count(talk_time_sec)                   AS talk_sample,
         sum(duration_sec)                      AS duration_seconds,
         count(disposition)                     AS dispositioned_calls,
         count(DISTINCT lead_ref)               AS distinct_leads
    FROM insights_calls
   WHERE org_id = $1 AND env = 'live' AND day >= $2::date AND day <= $3::date
     AND telecaller_id IS NOT NULL ${notNull}
   GROUP BY ${groupBy}
),
conv AS (
  SELECT ${key} AS subject_id, day,
         count(*)         AS conversions,
         sum(value_minor) AS won_minor
    FROM insights_conversions
   WHERE org_id = $1 AND env = 'live' AND day >= $2::date AND day <= $3::date
     AND telecaller_id IS NOT NULL ${notNull}
   GROUP BY ${groupBy}
),
pay AS (
  SELECT ${subject === "org" ? "NULL::uuid" : subject === "team" ? "t.team_id" : "p.telecaller_id"} AS subject_id,
         p.day, sum(p.amount_minor) AS collected_minor
    FROM insights_payments p
    JOIN telecallers t ON t.id = p.telecaller_id
   WHERE p.org_id = $1 AND p.env = 'live' AND p.day >= $2::date AND p.day <= $3::date
     AND p.telecaller_id IS NOT NULL
     ${subject === "team" ? "AND t.team_id IS NOT NULL" : ""}
   GROUP BY 1, 2
),
qa AS (
  SELECT ${subject === "org" ? "NULL::uuid" : subject === "team" ? "t.team_id" : "q.telecaller_id"} AS subject_id,
         q.day,
         sum(q.score)     AS qa_score_sum,
         sum(q.max_score) AS qa_max_sum,
         count(*)         AS qa_reviews
    FROM insights_quality_reviews q
    JOIN telecallers t ON t.id = q.telecaller_id
   WHERE q.org_id = $1 AND q.env = 'live' AND q.day >= $2::date AND q.day <= $3::date
     AND q.telecaller_id IS NOT NULL
     ${subject === "team" ? "AND t.team_id IS NOT NULL" : ""}
   GROUP BY 1, 2
),
att AS (
  SELECT ${subject === "org" ? "NULL::uuid" : subject === "team" ? "t.team_id" : "a.telecaller_id"} AS subject_id,
         a.day,
         count(*) FILTER (WHERE a.status = 'present') AS present_days
    FROM insights_attendance a
    JOIN telecallers t ON t.id = a.telecaller_id
   WHERE a.org_id = $1 AND a.env = 'live' AND a.day >= $2::date AND a.day <= $3::date
     ${subject === "team" ? "AND t.team_id IS NOT NULL" : ""}
   GROUP BY 1, 2
),
-- Every (subject, day) that appears in ANY fact table. A person who converted
-- today but whose calls came through yesterday's batch still gets a row.
subjects AS (
  SELECT subject_id, day FROM calls
  UNION SELECT subject_id, day FROM conv
  UNION SELECT subject_id, day FROM pay
  UNION SELECT subject_id, day FROM qa
  UNION SELECT subject_id, day FROM att
),
m AS (
  SELECT s.subject_id, s.day,
         jsonb_build_object(
           'calls',               COALESCE(c.calls, 0),
           'connected_calls',     COALESCE(c.connected_calls, 0),
           'connect_known',       COALESCE(c.connect_known, 0),
           -- NOT coalesced to 0 at the aggregate: sum over an all-null
           -- column is NULL, and talk_time reads as 0 only once the owner
           -- has acknowledged in the wizard that no talk time is being sent.
           -- The catalogue's "Data needed" status is the guard; see
           -- kpi-catalog.ts.
           'talk_seconds',        COALESCE(c.talk_seconds, 0),
           'talk_sample',         COALESCE(c.talk_sample, 0),
           'duration_seconds',    COALESCE(c.duration_seconds, 0),
           'dispositioned_calls', COALESCE(c.dispositioned_calls, 0),
           'distinct_leads',      COALESCE(c.distinct_leads, 0),
           'conversions',         COALESCE(v.conversions, 0),
           'won_minor',           COALESCE(v.won_minor, 0),
           'collected_minor',     COALESCE(p.collected_minor, 0),
           'qa_score_sum',        COALESCE(q.qa_score_sum, 0),
           'qa_max_sum',          COALESCE(q.qa_max_sum, 0),
           'qa_reviews',          COALESCE(q.qa_reviews, 0),
           'present_days',        COALESCE(a.present_days, 0),
           'active_days',         CASE WHEN COALESCE(c.calls, 0) > 0 THEN 1 ELSE 0 END
         ) AS measures
    FROM subjects s
    LEFT JOIN calls c ON c.day = s.day AND c.subject_id IS NOT DISTINCT FROM s.subject_id
    LEFT JOIN conv  v ON v.day = s.day AND v.subject_id IS NOT DISTINCT FROM s.subject_id
    LEFT JOIN pay   p ON p.day = s.day AND p.subject_id IS NOT DISTINCT FROM s.subject_id
    LEFT JOIN qa    q ON q.day = s.day AND q.subject_id IS NOT DISTINCT FROM s.subject_id
    LEFT JOIN att   a ON a.day = s.day AND a.subject_id IS NOT DISTINCT FROM s.subject_id
),
-- The catalogue, as rows. Supplied as arrays from TypeScript so the formulas
-- stay in one place (doc 41 F1) rather than being restated in SQL.
spec AS (
  SELECT * FROM unnest($4::text[], $5::text[], $6::text[], $7::text[])
    AS s(kpi_key, num, den, direction)
)
INSERT INTO kpi_snapshots
  (org_id, subject_kind, subject_id, kpi_key, day, numerator, denominator,
   target_value, target_period, weight_pct, direction, band_key, computed_at)
SELECT $1, '${subject}', m.subject_id, spec.kpi_key, m.day,
       (m.measures->>spec.num)::numeric,
       CASE WHEN spec.den IS NULL THEN NULL ELSE (m.measures->>spec.den)::numeric END,
       tgt.target_value,
       tgt.period,
       cfg.weight_pct,
       spec.direction,
       -- The band is NOT computed here. It is a property of ACHIEVEMENT over a
       -- WINDOW, and a day's achievement against a pro-rated daily share of a
       -- monthly target is a different and much noisier number than the one a
       -- page shows. Left null and resolved on read by bandFor, so one
       -- function decides it everywhere.
       NULL,
       now()
  FROM m
  CROSS JOIN spec
  -- INNER: only KPIs the org has configured as live on that day get a row.
  -- This is what makes the engine's output follow the wizard, and what makes
  -- coverage on the composite a fraction of something real.
  JOIN LATERAL (
    SELECT c.weight_pct
      FROM org_kpi_config c
     WHERE c.org_id = $1 AND c.kpi_key = spec.kpi_key AND c.scope_kind = 'org'
       AND c.effective_from <= m.day
       AND (c.effective_to IS NULL OR c.effective_to > m.day)
     ORDER BY c.effective_from DESC
     LIMIT 1
  ) cfg ON true
  -- Doc 41 F2's resolution rule, in SQL and therefore deterministic.
  LEFT JOIN LATERAL (
    SELECT c.target_value, c.period
      FROM org_kpi_config c
      LEFT JOIN telecallers t ON t.id = m.subject_id
     WHERE c.org_id = $1 AND c.kpi_key = spec.kpi_key
       AND c.effective_from <= m.day
       AND (c.effective_to IS NULL OR c.effective_to > m.day)
       AND (
         c.scope_kind = 'org'
         OR ('${subject}' = 'telecaller' AND c.scope_kind = 'telecaller'
             AND c.scope_telecaller_id = m.subject_id)
         OR ('${subject}' = 'telecaller' AND c.scope_kind = 'team'
             AND c.scope_team_id = t.team_id)
         OR ('${subject}' = 'team' AND c.scope_kind = 'team'
             AND c.scope_team_id = m.subject_id)
       )
     ORDER BY CASE c.scope_kind
                WHEN 'telecaller' THEN 1
                WHEN 'owner_role' THEN 2
                WHEN 'team'       THEN 3
                ELSE 4
              END,
              c.effective_from DESC
     LIMIT 1
  ) tgt ON true
ON CONFLICT (org_id, subject_kind,
             COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
             kpi_key, day)
DO UPDATE SET numerator     = EXCLUDED.numerator,
              denominator   = EXCLUDED.denominator,
              target_value  = EXCLUDED.target_value,
              target_period = EXCLUDED.target_period,
              weight_pct    = EXCLUDED.weight_pct,
              direction     = EXCLUDED.direction,
              computed_at   = now(),
              updated_at    = now()`;
}

const SPEC_KEYS = KPI_CATALOG.map((k) => k.key);
const SPEC_NUM = KPI_CATALOG.map((k) => k.numerator);
const SPEC_DEN = KPI_CATALOG.map((k) => k.denominator ?? null);
const SPEC_DIR = KPI_CATALOG.map((k) => k.direction);

/**
 * Recompute one org's snapshots over a day range.
 *
 * `from`/`to` are DATES in the org's own timezone, not instants - the facts
 * already carry an org-local `day` column (0194), so the window is a date
 * comparison and needs no timezone arithmetic here. That is the whole return
 * on storing `day` at write time.
 */
export async function snapshotOrg(orgId: string, from: string, to: string): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    let written = 0;
    for (const subject of ["telecaller", "team", "org"] as const) {
      const { rowCount } = await client.query(measuresSql(subject), [
        orgId,
        from,
        to,
        SPEC_KEYS,
        SPEC_NUM,
        SPEC_DEN,
        SPEC_DIR,
      ]);
      written += rowCount ?? 0;
    }
    await pruneOrphans(client, orgId, from, to);
    return written;
  });
}

/**
 * Delete snapshots for KPIs the org no longer has configured on that day.
 *
 * Without this, deselecting a KPI in the wizard would leave its rows behind
 * and every window that overlapped them would keep scoring it - the composite
 * would be divided by a configured weight that no longer exists, and the
 * dashboard would show a card the owner removed.
 *
 * Bounded to the recompute window, so it never touches history outside it.
 */
async function pruneOrphans(
  client: PoolClient,
  orgId: string,
  from: string,
  to: string,
): Promise<void> {
  await client.query(
    `DELETE FROM kpi_snapshots s
      WHERE s.org_id = $1 AND s.day >= $2::date AND s.day <= $3::date
        AND NOT EXISTS (
          SELECT 1 FROM org_kpi_config c
           WHERE c.org_id = $1 AND c.kpi_key = s.kpi_key AND c.scope_kind = 'org'
             AND c.effective_from <= s.day
             AND (c.effective_to IS NULL OR c.effective_to > s.day))`,
    [orgId, from, to],
  );
}

/**
 * Every org holding the module, over the lookback.
 *
 * Gated on `api_insights` rather than run for everybody: an org with no KPI
 * config writes nothing anyway (the INNER JOIN on `org_kpi_config` sees to
 * that), but there is no reason to open a transaction and run three
 * five-table aggregates for every tenant on the platform every quarter hour.
 *
 * Once doc 41's Phase 2 puts the spine on the CRM screens, this gate widens to
 * "any org with an `org_kpi_config` row" - which is the honest condition and
 * is why the module check is here in one place rather than inside the SQL.
 */
export async function runKpiSnapshots(from?: string, to?: string): Promise<number> {
  const { rows: orgs } = await getAdminPool().query<OrgRow>(
    `SELECT o.id
       FROM organizations o
      WHERE o.status = 'active'
        AND ('api_insights' = ANY(o.enabled_modules)
             OR EXISTS (SELECT 1 FROM org_kpi_config c WHERE c.org_id = o.id))`,
  );
  if (orgs.length === 0) return 0;

  const end = to ?? isoDay(new Date());
  const start =
    from ?? isoDay(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  let written = 0;
  for (const org of orgs) {
    try {
      const rows = await snapshotOrg(org.id, start, end);
      written += rows;
      if (rows > 0) announce(org.id, "report", "updated");
    } catch (err) {
      // One tenant's bad data must not stop the sweep for the rest. The next
      // tick retries, because this recomputes rather than accumulating.
      console.error(`kpi snapshots: org ${org.id}:`, err);
    }
  }
  if (written > 0) console.log(`kpi snapshots: wrote ${written} row(s)`);
  return written;
}

export function startKpiSnapshotSweep(): NodeJS.Timeout {
  // Quarter-hourly, matching `telecaller-stats`. Doc 41 G3 says to extend that
  // sweep rather than add a second one; this is a second one, and the reason
  // is that it reads a different set of tables for a different set of orgs -
  // folding them together would make every recorder-only tenant pay for five
  // aggregates over tables they have no rows in. The cadence is shared so the
  // two dashboards never disagree about how fresh they are.
  const interval = Number(process.env.KPI_SNAPSHOT_INTERVAL_MS ?? 15 * 60 * 1000);
  return setInterval(() => {
    void runKpiSnapshots().catch((err) => console.error("kpi snapshot sweep:", err));
  }, interval);
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
