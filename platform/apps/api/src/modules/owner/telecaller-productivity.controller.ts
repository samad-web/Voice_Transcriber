import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type { AgentScorecard, PeerMedians, ScorecardDay } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard } from "../../common/owner-role.guard";
import { OwnerScope, type OwnerRecordScope, ownerScopeClause } from "../../common/owner-scope";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Telecaller productivity - talk time, call volume and the idle gap between
 * calls, read from the daily rollup (migration 0090).
 *
 * ── WHY THIS IS ITS OWN CONTROLLER ──────────────────────────────────────────
 *
 * owner.controller.ts already has a per-telecaller leaderboard, and this is
 * deliberately not merged into it. That one is a list of DEVICES joined
 * through `devices.telecaller_id` - it answers "which handset is producing
 * leads". This one is a list of PEOPLE keyed on the write-once
 * `calls.telecaller_id` snapshot (0068) - it answers "how did this person
 * spend their day", and has to stay correct across a handset being reassigned,
 * which is precisely what the device-joined version cannot do.
 *
 * ── THE PERSONA RULE ────────────────────────────────────────────────────────
 *
 * No `@RequireOwnerRole` on the read, and that is the considered choice rather
 * than an omission. Every persona is entitled to see their own numbers - a
 * telecaller looking at their own talk time is the feature working. What must
 * never happen is a telecaller reading the floor's, so the row filter comes
 * from `ownerScopeGuard` and is applied in the SQL below.
 *
 * That is the same shape, and the same trap, as
 * 13_ROUTE_AND_GUARD_INVENTORY.md finding 3: a route that mounts
 * OwnerRoleGuard and declares no requirement leaves the guard INERT. Here the
 * narrowing is done by OwnerScopeGuard instead, which is never inert - it
 * writes a scope for every request and defaults to matching nothing when an
 * own-scoped persona has no telecaller identity.
 */

const RangeQuery = z.object({
  /**
   * Calendar dates in the org's `reporting_timezone`, not instants. The rollup
   * stores a `date`, so a range expressed as timestamps would need a timezone
   * the caller does not have and would silently clip a day at each end.
   */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
  /** Ranked worst-first when set, for a manager triaging who needs coaching. */
  sort: z.enum(["name", "calls", "talk", "gap", "sop"]).default("calls"),
});

const ScorecardQuery = RangeQuery.pick({ from: true, to: true }).extend({
  /**
   * Whose card to draw. Omitted means the caller's own, which is what a
   * telecaller always gets - the scope guard overrules this parameter below,
   * so passing somebody else's id as a telecaller reads your own card rather
   * than 403-ing. A manager coaching a rep passes it.
   *
   * NOT `.default()`: `undefined` and "my own" have to stay distinguishable
   * here, and a default would make the two the same value. (The Zod trap where
   * `.partial()` keeps `.default()` is the same edge, seen from the other
   * side.)
   */
  telecaller: z.string().uuid().optional(),
});

/**
 * The one read.
 *
 * Aggregates the daily rows into a per-person total over the range, because a
 * manager compares people, not people-days. The daily rows stay available for
 * a trend line later - that is why the rollup is stored per day rather than
 * per range in the first place.
 *
 * Every talk figure is guarded by `talk_sample_calls`: an org that switched
 * diarization on midway through the range (or off) otherwise reports a partial
 * sample as if it were the whole period. Rather than hide that, the response
 * carries the sample size and lets the page say so.
 */
const SUMMARY_SQL = (scopeAnd: string) => `
  SELECT s.telecaller_id,
         t.display_name,
         t.status,
         sum(s.calls_total)::int        AS calls_total,
         sum(s.calls_connected)::int    AS calls_connected,
         sum(s.total_call_seconds)::int AS total_call_seconds,
         count(*)::int                  AS active_days,
         -- Median of the daily medians. Not a median of every gap in the
         -- range: that would let one busy day dominate a quiet week, and the
         -- question this answers is "on a typical day, how long does this
         -- person sit between calls".
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY s.median_gap_seconds
         )::int AS median_gap_seconds,
         max(s.longest_gap_seconds)::int AS longest_gap_seconds,
         sum(s.active_span_seconds)::int AS active_span_seconds,
         sum(s.presence_seconds)::int    AS presence_seconds,
         -- Talk. NULL across the board for a non-diarized org, by construction
         -- of the rollup - see 0090's header.
         sum(s.agent_talk_seconds)::int    AS agent_talk_seconds,
         sum(s.customer_talk_seconds)::int AS customer_talk_seconds,
         sum(s.interruption_count)::int    AS interruption_count,
         sum(s.talk_sample_calls)::int     AS talk_sample_calls,
         -- Weighted by the calls each day contributed, not a mean of daily
         -- means: a day with two calls must not count as much as a day with
         -- forty when describing how much of the range this person talked.
         CASE WHEN sum(s.talk_sample_calls) > 0
              THEN sum(s.mean_talk_ratio * s.talk_sample_calls) / sum(s.talk_sample_calls)
         END AS mean_talk_ratio,
         -- SOP adherence (0091), as scalar subqueries rather than a join.
         --
         -- A join would have to be pre-aggregated (call_sop_results is one row
         -- per CALL, this query is one row per PERSON) and would then need both
         -- its columns in GROUP BY. Two index seeks on
         -- call_sop_results_telecaller, once per person, is simpler to read and
         -- costs less than the reader has to spend understanding the join.
         --
         -- Ranged on call_started_at, never created_at: see 0091.
         (SELECT round(avg(r.adherence_pct))::int
            FROM call_sop_results r
           WHERE r.telecaller_id = s.telecaller_id
             AND r.adherence_pct IS NOT NULL
             AND r.call_started_at >= $1::date
             AND r.call_started_at < ($2::date + 1)) AS mean_adherence_pct,
         (SELECT count(*)::int
            FROM call_sop_results r
           WHERE r.telecaller_id = s.telecaller_id
             AND r.adherence_pct IS NOT NULL
             AND r.call_started_at >= $1::date
             AND r.call_started_at < ($2::date + 1)) AS sop_scored_calls
    FROM telecaller_daily_stats s
    JOIN telecallers t ON t.id = s.telecaller_id
   WHERE s.day >= $1::date AND s.day <= $2::date${scopeAnd}
   GROUP BY 1, 2, 3`;

/**
 * The window every scorecard statement shares: calendar dates in the org's own
 * reporting zone, turned into the instants `calls.started_at` is stored in.
 * Lifted verbatim from staff-performance.controller.ts so "1st to 7th" means
 * the same seven days on both pages.
 */
const SCORECARD_WINDOW = `
  w AS (
    SELECT ($1::date)::timestamp AT TIME ZONE zone     AS from_at,
           (($2::date + 1))::timestamp AT TIME ZONE zone AS to_at
      FROM (SELECT COALESCE(o.reporting_timezone, 'Asia/Kolkata') AS zone
              FROM organizations o LIMIT 1) tz
  )`;

/**
 * One person's quality half: the AI's read of their calls in the range.
 *
 * ── WHY jsonb_typeof GUARDS EVERY CRITERION ─────────────────────────────────
 *
 * `quality_criteria` is written from an LLM reply. packages/llm coerces it
 * before it is stored, so the fields SHOULD be numbers - but this column has
 * existed since 0069 across model and provider changes, and a single row where
 * `scriptAdherence` came back as "8" rather than 8 would make a bare
 * `::numeric` cast throw and take the whole page down with a 500. Checking the
 * type costs nothing and turns a bad row into a row that does not contribute.
 *
 * ── AND WHY THE CONSENT RATE IS avg() OF 1s AND 0s ──────────────────────────
 *
 * Over the calls where consent was READ, not over every call. A call the model
 * could not judge is absent from both halves of the fraction, so the rate says
 * "of the calls we can speak to, this many disclosed" rather than quietly
 * counting unreadable calls as violations.
 */
const SCORECARD_QUALITY_CTE = `
analysed AS (
  SELECT a.quality_score, a.quality_criteria, ci.sentiment
    FROM calls c
    CROSS JOIN w
    LEFT JOIN call_analytics a ON a.call_id = c.id
    LEFT JOIN LATERAL (
      SELECT t.intelligence ->> 'sentiment' AS sentiment
        FROM transcripts t
       WHERE t.call_id = c.id
       LIMIT 1
    ) ci ON true
   WHERE c.telecaller_id = $3
     AND c.started_at >= w.from_at
     AND c.started_at <  w.to_at
),
quality AS (
SELECT count(quality_score)::int                                   AS qa_scored_calls,
       round(avg(quality_score))::int                              AS qa_score,
       avg(CASE WHEN jsonb_typeof(quality_criteria -> 'scriptAdherence') = 'number'
                THEN (quality_criteria ->> 'scriptAdherence')::numeric END)::float
                                                                   AS script_adherence,
       avg(CASE WHEN jsonb_typeof(quality_criteria -> 'professionalism') = 'number'
                THEN (quality_criteria ->> 'professionalism')::numeric END)::float
                                                                   AS professionalism,
       avg(CASE WHEN jsonb_typeof(quality_criteria -> 'conversionSignal') = 'number'
                THEN (quality_criteria ->> 'conversionSignal')::numeric END)::float
                                                                   AS conversion_signal,
       avg(CASE WHEN jsonb_typeof(quality_criteria -> 'consentDisclosed') = 'boolean'
                THEN CASE WHEN (quality_criteria ->> 'consentDisclosed')::boolean
                          THEN 1 ELSE 0 END END)::float            AS consent_rate,
       count(sentiment)::int                                       AS sentiment_read_calls,
       count(*) FILTER (WHERE sentiment = 'positive')::int          AS positive,
       count(*) FILTER (WHERE sentiment = 'neutral')::int           AS neutral,
       count(*) FILTER (WHERE sentiment = 'negative')::int          AS negative
  FROM analysed
)`;

/**
 * First-call resolution for one person (0144).
 *
 * ── WHAT MAKES A CALL ELIGIBLE ──────────────────────────────────────────────
 *
 * It connected, a person dispositioned it, and it was the FIRST time this org
 * spoke to that number. The last clause is what makes the metric first-call
 * resolution rather than plain resolution, and it is the reason the query
 * needs `remote_number_key` (0133) rather than `remote_number_hash`: the hash
 * is over whatever digits the handset reported, so the same customer reached
 * on "+919876543210" and dialled back as "9876543210" is two different
 * customers to it, and every callback would count as a fresh first contact.
 *
 * ── THE 90-DAY LOOKBACK ─────────────────────────────────────────────────────
 *
 * "First ever" would have to scan the whole history of the number on every
 * row. Ninety days bounds it to an index range on
 * `calls (org_id, remote_number_key, started_at)` (0133), and is long enough
 * that a genuine repeat customer is not counted as new. It is deliberately
 * longer than any range the page offers, so the answer for a given call does
 * not change with the window the reader happens to be looking at.
 *
 * ── AND WHY THE JOIN IS ON THE KEY ──────────────────────────────────────────
 *
 * `calls.disposition_key` is a key and not a foreign key (0097), so a retired
 * disposition still reads back. A call filed under a key that has since been
 * DELETED joins to nothing and drops out of both halves of the fraction -
 * correct, because nobody can now say whether that outcome resolved anything.
 */
const SCORECARD_FCR_CTE = `
fcr AS (
SELECT count(*)::int                                          AS eligible,
       count(*) FILTER (WHERE d.resolves_on_first_call)::int   AS resolved
  FROM calls c
  CROSS JOIN w
  JOIN call_dispositions d
    ON d.org_id = c.org_id AND d.key = c.disposition_key
 WHERE c.telecaller_id = $3
   AND c.started_at >= w.from_at
   AND c.started_at <  w.to_at
   AND c.duration_s > 0
   AND c.remote_number_key IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM calls p
      WHERE p.org_id = c.org_id
        AND p.remote_number_key = c.remote_number_key
        AND p.started_at < c.started_at
        AND p.started_at >= c.started_at - interval '90 days'
   )
)`;

/**
 * Whether ANY outcome in this tenant's vocabulary asserts resolution (0144).
 *
 * Read separately from the rate itself because the two answer different
 * questions and only one of them is about the rep: `eligible = 0` means this
 * person dispositioned no first contacts, and `configured = false` means
 * nobody has told the system what "resolved" is. The page words them
 * differently, and collapsing them would put an unconfigured setting on a
 * rep's record as a 0%.
 */
const SCORECARD_FCR_CONFIGURED_CTE = `
fcr_configured AS (
  SELECT EXISTS (
    SELECT 1 FROM call_dispositions WHERE resolves_on_first_call
  ) AS configured
)`;

/** The daily strip, oldest first - the rollup already holds exactly this. */
const SCORECARD_DAYS_CTE = `
days AS (
  SELECT coalesce(json_agg(d ORDER BY d.day), '[]'::json) AS series
    FROM (
      SELECT s.day::text            AS day,
             s.calls_total::int     AS calls,
             s.calls_connected::int AS connected,
             s.total_call_seconds::int AS talk_seconds
        FROM telecaller_daily_stats s
       WHERE s.telecaller_id = $3
         AND s.day >= $1::date
         AND s.day <= $2::date
    ) d
)`;

/**
 * The floor's midpoints, for the rep to read their own numbers against.
 *
 * ── WHY THIS IS NOT NARROWED TO THE READER ──────────────────────────────────
 *
 * The productivity list next door computes its medians over the rows the
 * persona could see, which for a telecaller is their own row - so the
 * "benchmark" is their own number and the comparison is knowingly
 * meaningless. That is right for a LIST that names colleagues. It is wrong
 * here: a rep asking "is 40 calls a normal day" is the entire reason this page
 * exists, and answering it with their own 40 is answering nothing.
 *
 * A median over the floor names nobody. But on a SMALL floor it effectively
 * does - with two reps, the median of two numbers and your own gives you your
 * colleague's exactly - so the whole block is withheld below
 * MIN_PEER_FLOOR active people. The page then simply shows no comparison,
 * which is honest, rather than a comparison that is a colleague's payslip.
 */
const SCORECARD_PEERS_CTE = `
-- ── VOLUME COMES FROM THE ROLLUP, NOT FROM \`calls\` ─────────────────────────
--
-- The obvious way to write this is to count \`calls\` rows per person, and it is
-- wrong in a way that would have been very hard to see on the page. The
-- rollup's \`calls_connected\` (0090) counts a call as connected once it passes
-- the org's threshold - 15 seconds by default - because anything shorter could
-- only have been a ring-out. A raw \`duration_s > 0\` count has no such floor.
--
-- Mixing them would put the rep's own connect rate (rollup, thresholded) next
-- to a floor median (raw, unthresholded) that is systematically higher, and
-- EVERY rep would read as below median on a metric where half of them must be
-- above it by construction. Both sides of the comparison therefore come from
-- the same rollup the rest of the page already uses.
per_person AS (
  SELECT s.telecaller_id,
         sum(s.calls_total)::int        AS calls,
         sum(s.calls_connected)::int    AS connected,
         sum(s.total_call_seconds)::int AS talk_seconds
    FROM telecaller_daily_stats s
   WHERE s.day >= $1::date AND s.day <= $2::date
   GROUP BY s.telecaller_id
),
-- The quality half has no rollup to read, so it is aggregated from \`calls\`
-- per person - the same shape the single-person \`analysed\` CTE above uses, so
-- the rep's own QA number and the floor's median are computed identically.
quality_per_person AS (
  SELECT c.telecaller_id,
         -- ::float here and not at the percentile below: avg() over an int
         -- returns numeric, and percentile_cont takes double precision. The
         -- implicit cast would resolve, but pinning it at the source keeps the
         -- floor's median and the rep's own mean on the same type.
         avg(a.quality_score)::float                            AS qa_score,
         count(ci.sentiment)::int                               AS sentiment_read,
         count(*) FILTER (WHERE ci.sentiment = 'positive')::int  AS positive,
         count(*) FILTER (WHERE ci.sentiment = 'neutral')::int   AS neutral
    FROM calls c
    CROSS JOIN w
    LEFT JOIN call_analytics a ON a.call_id = c.id
    LEFT JOIN LATERAL (
      SELECT t.intelligence ->> 'sentiment' AS sentiment
        FROM transcripts t WHERE t.call_id = c.id LIMIT 1
    ) ci ON true
   WHERE c.telecaller_id IS NOT NULL
     AND c.started_at >= w.from_at
     AND c.started_at <  w.to_at
   GROUP BY c.telecaller_id
),
fcr_per_person AS (
  SELECT c.telecaller_id,
         count(*)::int                                        AS eligible,
         count(*) FILTER (WHERE d.resolves_on_first_call)::int AS resolved
    FROM calls c
    CROSS JOIN w
    JOIN call_dispositions d ON d.org_id = c.org_id AND d.key = c.disposition_key
   WHERE c.telecaller_id IS NOT NULL
     AND c.started_at >= w.from_at
     AND c.started_at <  w.to_at
     AND c.duration_s > 0
     AND c.remote_number_key IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM calls p
        WHERE p.org_id = c.org_id
          AND p.remote_number_key = c.remote_number_key
          AND p.started_at < c.started_at
          AND p.started_at >= c.started_at - interval '90 days'
     )
   GROUP BY c.telecaller_id
),
peers AS (
SELECT count(*)::int AS floor_size,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY p.calls)::int AS calls,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY p.connected::float / NULLIF(p.calls, 0)
       )::float AS connect_rate,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY p.talk_seconds::float / NULLIF(p.connected, 0)
       )::float AS avg_call_seconds,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY q.qa_score)::float AS qa_score,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY (q.positive * 100 + q.neutral * 50)::float / NULLIF(q.sentiment_read, 0)
       )::float AS csat,
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY f.resolved::float / NULLIF(f.eligible, 0)
       )::float AS fcr_rate
  FROM per_person p
  LEFT JOIN quality_per_person q ON q.telecaller_id = p.telecaller_id
  LEFT JOIN fcr_per_person f     ON f.telecaller_id = p.telecaller_id
)`;

/**
 * Below this many people with calls in the range, no floor comparison is
 * returned at all. Five, so that knowing the median and your own row still
 * leaves four numbers unaccounted for.
 */
const MIN_PEER_FLOOR = 5;

/** What `SCORECARD_SQL` gives back - one row, most of it nested json. */
interface ScorecardRow {
  display_name: string | null;
  totals: { calls: number; connected: number; talk_seconds: number; active_days: number } | null;
  sop: { adherence: number | null; scored_calls: number } | null;
  quality: {
    qa_scored_calls: number;
    qa_score: number | null;
    script_adherence: number | null;
    professionalism: number | null;
    conversion_signal: number | null;
    consent_rate: number | null;
    sentiment_read_calls: number;
    positive: number;
    neutral: number;
    negative: number;
  } | null;
  fcr: { eligible: number; resolved: number } | null;
  fcr_configured: boolean | null;
  days: ScorecardDay[] | null;
  peers: {
    floor_size: number;
    calls: number | null;
    connect_rate: number | null;
    avg_call_seconds: number | null;
    qa_score: number | null;
    csat: number | null;
    fcr_rate: number | null;
  } | null;
}

/** No comparison available. A shared constant so the two paths cannot drift. */
const NO_PEERS: PeerMedians = {
  calls: null,
  connectRate: null,
  avgCallSeconds: null,
  qaScore: null,
  csat: null,
  fcrRate: null,
};

/**
 * The card for somebody with no calls attributed to them.
 *
 * Every count is a real 0 and every rate is absent, which is the honest
 * reading: we know they made no calls, and we cannot know what their quality
 * was. The derivations in @aura/shared turn these into dashes rather than
 * zeroes because each one tests its sample size first.
 */
function emptyScorecard(from: string, to: string): AgentScorecard {
  return {
    telecallerId: "",
    displayName: "You",
    from,
    to,
    calls: 0,
    connected: 0,
    talkSeconds: 0,
    activeDays: 0,
    days: [],
    qaScore: null,
    qaScoredCalls: 0,
    qaCriteria: {
      consentRate: null,
      scriptAdherence: null,
      professionalism: null,
      conversionSignal: null,
    },
    sopAdherence: null,
    sopScoredCalls: 0,
    sentiment: { positive: 0, neutral: 0, negative: 0 },
    sentimentReadCalls: 0,
    fcrEligibleCalls: 0,
    fcrResolvedCalls: 0,
    fcrConfigured: false,
    peer: NO_PEERS,
  };
}

/**
 * ONE statement, one round trip.
 *
 * The five blocks above are independent reads - the rollup, the AI's analysis,
 * the FCR fraction, the tenant's disposition settings, and the floor's
 * medians - and issuing them separately would be five Mumbai→Seoul exchanges
 * for one page load, over half a second of pure flight time before Postgres
 * does any work. `staff-performance.controller.ts` makes the same trade for
 * the same reason and states it at length.
 *
 * They compose as CTEs rather than a multi-statement batch because this query
 * takes bind parameters ($1 from, $2 to, $3 the telecaller) and the
 * multi-statement protocol does not - the same constraint owner.controller.ts
 * documents where it pays that price.
 *
 * Each CTE produces exactly one row (they are all unfiltered aggregates), so
 * the CROSS JOIN below is a one-row join and not a fan-out.
 */
const SCORECARD_SQL = `
WITH ${SCORECARD_WINDOW},
-- This person's output, from the same rollup the floor's median is taken from
-- and the same one /owner/productivity reads. \`active_days\` is a count of
-- rows and not a span: the rollup only writes a day on which somebody made a
-- call, so "20 active days" means twenty days worked, not twenty elapsed.
totals AS (
  SELECT coalesce(sum(s.calls_total), 0)::int        AS calls,
         coalesce(sum(s.calls_connected), 0)::int    AS connected,
         coalesce(sum(s.total_call_seconds), 0)::int AS talk_seconds,
         count(*)::int                               AS active_days
    FROM telecaller_daily_stats s
   WHERE s.telecaller_id = $3 AND s.day >= $1::date AND s.day <= $2::date
),
-- SOP adherence (0091). Ranged on call_started_at and never created_at, the
-- rule 0091 sets out: a reprocess months later would otherwise drop a quarter
-- of adherence scores onto whatever day the worker happened to run.
sop AS (
  SELECT round(avg(r.adherence_pct))::int AS adherence,
         count(r.adherence_pct)::int      AS scored_calls
    FROM call_sop_results r
   WHERE r.telecaller_id = $3
     AND r.adherence_pct IS NOT NULL
     AND r.call_started_at >= $1::date
     AND r.call_started_at <  ($2::date + 1)
),
${SCORECARD_QUALITY_CTE.trim()},
${SCORECARD_FCR_CTE.trim()},
${SCORECARD_FCR_CONFIGURED_CTE.trim()},
${SCORECARD_DAYS_CTE.trim()},
${SCORECARD_PEERS_CTE.trim()}
SELECT (SELECT t.display_name FROM telecallers t WHERE t.id = $3) AS display_name,
       row_to_json(totals)       AS totals,
       row_to_json(sop)          AS sop,
       row_to_json(quality)      AS quality,
       row_to_json(fcr)          AS fcr,
       fcr_configured.configured AS fcr_configured,
       days.series               AS days,
       row_to_json(peers)        AS peers
  FROM totals
  CROSS JOIN sop
  CROSS JOIN quality
  CROSS JOIN fcr
  CROSS JOIN fcr_configured
  CROSS JOIN days
  CROSS JOIN peers`;

@Controller("owner/productivity")
// Same four guards, same order, mounted on the class rather than per-handler -
// a new endpoint added below is scoped by default and has to opt out
// deliberately.
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OwnerScopeGuard, OrgFeatureGuard)
@RequireFeature("productivity")
export class TelecallerProductivityController {
  constructor(private readonly db: DbService) {}

  @Get()
  async productivity(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const parsed = RangeQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to, sort } = parsed.data;
    if (from > to) throw new BadRequestException("from must not be after to");

    return this.db.withOrg(orgId, async (client) => {
      const params: unknown[] = [from, to];
      // $3 when the persona narrows, absent when it does not - so an owner's
      // query is byte-for-byte the query it was before personas existed.
      const clause = ownerScopeClause("telecaller_stats", scope, params.length + 1, "s");
      if (clause) params.push(scope.telecallerId ?? null);

      const { rows } = await client.query(SUMMARY_SQL(clause ? ` AND ${clause}` : ""), params);

      // Sorted here rather than in SQL: the comparators differ in direction
      // (more calls is better, a longer gap is worse) and expressing that as
      // an interpolated ORDER BY would put caller-influenced text into the
      // statement for no gain on a result set this size.
      const sorted = [...rows].sort((a, b) => {
        switch (sort) {
          case "name":
            return String(a.display_name).localeCompare(String(b.display_name));
          case "talk":
            return (b.agent_talk_seconds ?? -1) - (a.agent_talk_seconds ?? -1);
          case "gap":
            // Worst first - the longest idle gap is the one worth looking at.
            return (b.median_gap_seconds ?? -1) - (a.median_gap_seconds ?? -1);
          case "sop":
            // LOWEST adherence first: this sort exists to find who needs
            // coaching, not to rank the top of the floor. Unscored people sort
            // last rather than first - an absent score is not a bad one.
            return (a.mean_adherence_pct ?? 101) - (b.mean_adherence_pct ?? 101);
          default:
            return (b.calls_total ?? 0) - (a.calls_total ?? 0);
        }
      });

      /**
       * The floor's midpoint, so a number on the page has something to be
       * read against. An individual figure with no reference invites the
       * reader to supply their own, which on a coaching screen is how "42
       * calls" becomes "not enough" without anyone checking.
       *
       * Computed over whatever rows this persona could see: for a telecaller
       * that is their own row alone, and the comparison is correctly
       * meaningless rather than a leak of the floor's distribution.
       */
      const median = (key: string): number | null => {
        const values = sorted
          .map((r) => r[key])
          .filter((v): v is number => typeof v === "number")
          .sort((a, b) => a - b);
        if (values.length === 0) return null;
        const mid = Math.floor(values.length / 2);
        return values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2);
      };

      return {
        from,
        to,
        scope: scope.scope,
        telecallers: sorted,
        benchmarks: {
          calls_total: median("calls_total"),
          total_call_seconds: median("total_call_seconds"),
          agent_talk_seconds: median("agent_talk_seconds"),
          median_gap_seconds: median("median_gap_seconds"),
          mean_adherence_pct: median("mean_adherence_pct"),
        },
        /**
         * Whether talk metrics are available at all for this org, so the page
         * can say "not enabled" rather than rendering a column of dashes that
         * reads like missing data. Diarization is a per-instance cost decision
         * (0083), not a fault.
         */
        talk_metrics_available: sorted.some((r) => (r.talk_sample_calls ?? 0) > 0),
        /**
         * Whether any call in the range was scored against an SOP, so the page
         * can distinguish "no SOP defined" from "nobody followed it". The two
         * look identical in a column of dashes and mean opposite things.
         */
        sop_scoring_available: sorted.some((r) => (r.sop_scored_calls ?? 0) > 0),
      };
    });
  }

  /**
   * One person's scorecard - their output beside the quality of it.
   *
   * ── WHOSE CARD YOU GET ──────────────────────────────────────────────────
   *
   * The `telecaller` parameter is a REQUEST, not an authorisation. An
   * own-scoped persona (a telecaller, a sales rep) always reads their own
   * card whatever they pass, because the scope guard's answer overrules the
   * query string below - so the parameter cannot be walked through ids to
   * read the floor one card at a time. Only a caller the guard left unscoped,
   * which is an owner or a manager, can point it at somebody else.
   *
   * Note the shape: this never throws on a telecaller who asks for a
   * colleague. Refusing would confirm that the id exists, and there is no
   * reason to answer that question at all when the right answer - your own
   * card - is the one they are entitled to.
   *
   * ── A PERSON WITH NO HANDSET IDENTITY ───────────────────────────────────
   *
   * Returns 200 with `telecallerId: null` and empty figures, not a 404. A
   * manager who has never held a phone opening their own scorecard is not an
   * error, and the page says "no calls are attributed to you" - the same
   * distinction the staff scorecard draws between an unlinked identity and a
   * zero.
   */
  @Get("scorecard")
  async scorecard(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const parsed = ScorecardQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to, telecaller } = parsed.data;
    if (from > to) throw new BadRequestException("from must not be after to");

    // The guard's answer wins for a narrowed persona. See the header.
    const telecallerId = scope.scope === "own" ? scope.telecallerId : (telecaller ?? scope.telecallerId);

    if (!telecallerId) {
      return {
        from,
        to,
        scope: scope.scope,
        scorecard: emptyScorecard(from, to),
      };
    }

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<ScorecardRow>(SCORECARD_SQL, [from, to, telecallerId]);
      const row = rows[0];
      if (!row) return { from, to, scope: scope.scope, scorecard: emptyScorecard(from, to) };

      const peers = row.peers;
      /**
       * The floor is withheld entirely below MIN_PEER_FLOOR - see the peers
       * CTE. Withheld as a block and never field by field: releasing the ones
       * that happen to be non-null on a floor of three would leak exactly the
       * colleague the threshold exists to protect.
       */
      const smallFloor = (peers?.floor_size ?? 0) < MIN_PEER_FLOOR;

      return {
        from,
        to,
        scope: scope.scope,
        scorecard: {
          telecallerId,
          displayName: row.display_name ?? "You",
          from,
          to,

          calls: row.totals?.calls ?? 0,
          connected: row.totals?.connected ?? 0,
          talkSeconds: row.totals?.talk_seconds ?? 0,
          activeDays: row.totals?.active_days ?? 0,
          days: row.days ?? [],

          qaScore: row.quality?.qa_score ?? null,
          qaScoredCalls: row.quality?.qa_scored_calls ?? 0,
          qaCriteria: {
            consentRate: row.quality?.consent_rate ?? null,
            scriptAdherence: row.quality?.script_adherence ?? null,
            professionalism: row.quality?.professionalism ?? null,
            conversionSignal: row.quality?.conversion_signal ?? null,
          },
          sopAdherence: row.sop?.adherence ?? null,
          sopScoredCalls: row.sop?.scored_calls ?? 0,

          sentiment: {
            positive: row.quality?.positive ?? 0,
            neutral: row.quality?.neutral ?? 0,
            negative: row.quality?.negative ?? 0,
          },
          sentimentReadCalls: row.quality?.sentiment_read_calls ?? 0,

          fcrEligibleCalls: row.fcr?.eligible ?? 0,
          fcrResolvedCalls: row.fcr?.resolved ?? 0,
          fcrConfigured: row.fcr_configured ?? false,

          peer: smallFloor
            ? NO_PEERS
            : {
                calls: peers?.calls ?? null,
                connectRate: peers?.connect_rate ?? null,
                avgCallSeconds: peers?.avg_call_seconds ?? null,
                qaScore: peers?.qa_score ?? null,
                csat: peers?.csat ?? null,
                fcrRate: peers?.fcr_rate ?? null,
              },
        } satisfies AgentScorecard,
      };
    });
  }

  /*
   * NO RECOMPUTE ENDPOINT, deliberately.
   *
   * The obvious next route is POST /recompute for a range, and it is not here
   * because there is nothing honest for it to do yet: the API process does not
   * import worker code, and a range recompute belongs on the worker's clock.
   * A route that accepted the request and returned 202 without anything
   * reading it would be the `startFollowUpDrain` bug again - a console
   * reporting "queued" for work nothing drains.
   *
   * The sweep already recomputes the last TELECALLER_STATS_LOOKBACK_DAYS every
   * 15 minutes, which covers every case anyone has asked for. Backfilling
   * history after a bulk reprocess is `runTelecallerStats(from, to)` on the
   * worker, the same way the other backfills in scripts/ work. Wire a route
   * when there is a queue behind it.
   */
}
