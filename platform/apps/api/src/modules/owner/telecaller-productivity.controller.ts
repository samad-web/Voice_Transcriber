import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import {
  DEFAULT_STAGE_SLA_DAYS,
  leadHeldByParam,
  parseLeadStages,
  type AgentScorecard,
  type PeerMedians,
  type ScorecardDay,
} from "@aura/shared";
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
  org AS (
    SELECT COALESCE(o.reporting_timezone, 'Asia/Kolkata') AS zone,
           o.response_sla_minutes,
           o.lead_stages
      FROM organizations o LIMIT 1
  ),
  w AS (
    SELECT ($1::date)::timestamp AT TIME ZONE org.zone       AS from_at,
           (($2::date + 1))::timestamp AT TIME ZONE org.zone AS to_at
      FROM org
  ),
  -- Whose card this is, and whether they have a platform login behind them.
  --
  -- \`telecallers.user_id\` (0017) is the ONLY bridge between a lead (which
  -- belongs to a telecaller) and a task (which belongs to a user), and it is
  -- nullable. Everything task-shaped below is gated on it, and the response
  -- reports \`linked: false\` rather than a row of zeroes - see @aura/shared's
  -- \`TaskLoad\`. Migration 0093's header is where that split is written down.
  me AS (
    SELECT t.id, t.user_id, t.display_name FROM telecallers t WHERE t.id = $3
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

/**
 * "This lead is held by the person whose card this is", bound to $3.
 *
 * NOT `ownerScopeClause("lead", scope, …)`, which is the other question and would
 * be the wrong answer here: that one returns null for an unscoped caller, so a
 * manager opening a rep's card would have got the whole floor's leads rolled into
 * that rep's pipeline. Both spellings come from the one predicate in @aura/shared
 * so they cannot drift apart.
 */
const LEAD_HELD_BY_CALLER = leadHeldByParam(3, "l");

/**
 * What came out of the dialling: the leads this person is answerable for.
 *
 * ── THE COHORT IS LEADS CREATED IN THE WINDOW ───────────────────────────────
 *
 * Not leads WON in it. The denominator has to be a cohort for the rate to mean
 * anything, and this is the same cohort `/v1/owner/performance` uses for the
 * desk-wide conversion rate - so a rep's own 14% and their manager's desk 11%
 * are computed the same way and nobody has to reconcile them in a review. It is
 * also the pessimistic reading, because a lead created on the last day of the
 * range has had no chance to convert, and the page says so.
 *
 * ── AND WHOSE LEAD IT IS ────────────────────────────────────────────────────
 *
 * `leadHeldBy` from @aura/shared - assignment where somebody set one, the
 * write-once attribution where nobody has. That predicate is shared with the
 * persona scope filter precisely so "this person's lead" cannot come to mean two
 * things; see its own header for why the union rather than assignment alone.
 */
const SCORECARD_PIPELINE_CTE = (held: string) => `
pipeline AS (
  SELECT count(*)::int                                   AS leads_worked,
         count(*) FILTER (WHERE l.status = 'won')::int    AS won,
         count(*) FILTER (WHERE l.status = 'lost')::int   AS lost,
         count(*) FILTER (WHERE l.status = 'open')::int   AS open_count,
         COALESCE(sum(l.value_num) FILTER (WHERE l.status = 'won'), 0)::float AS won_value
    FROM leads l
   CROSS JOIN w
   WHERE l.created_at >= w.from_at
     AND l.created_at <  w.to_at
     AND ${held}
)`;

/**
 * Time in stage, over this person's WHOLE OPEN BOOK - not over the window.
 *
 * ── WHY THIS ONE IGNORES THE DATE RANGE ─────────────────────────────────────
 *
 * "Which of my leads have gone quiet" is a present-tense question. Narrowed to
 * the range, a rep reading last week would be told nothing is stuck while nine
 * leads from March sat untouched, and the number would shrink every time
 * somebody looked at a shorter period - which is the opposite of what a warning
 * should do. The page labels this panel as "now" for that reason.
 *
 * `worst_days` and `worst_stage` describe the oldest BREACHED lead, not the
 * oldest open one: the sentence they feed is inside the warning, and naming a
 * healthy lead there would make the warning wrong.
 *
 * The threshold arrives as $4 rather than being written in: @aura/shared owns
 * DEFAULT_STAGE_SLA_DAYS, the response carries the number it used, and the
 * click-through puts that same number in the URL - so the tile, the sentence and
 * the list it opens cannot disagree about which leads are stuck.
 */
const SCORECARD_SLA_CTE = (held: string) => `
stage_sla AS (
  SELECT count(*)::int AS open_count,
         count(*) FILTER (
           WHERE l.stage_changed_at <= now() - make_interval(days => $4::int)
         )::int AS breached,
         -- Never answered at all, and already past the org's response SLA
         -- (0119's response_sla_minutes). A worse failure than a stalled lead
         -- and counted separately: that one was worked and went quiet, this one
         -- was never picked up.
         count(*) FILTER (
           WHERE l.first_responded_at IS NULL
             AND l.created_at <= now() - make_interval(mins => org.response_sla_minutes)
         )::int AS unanswered,
         -- The oldest breached lead. array_agg + FILTER rather than a second
         -- ordered subquery over the same rows: one pass, and an empty filter
         -- yields NULL rather than a zero that would read as "0 days stuck".
         (array_agg((EXTRACT(EPOCH FROM (now() - l.stage_changed_at)) / 86400)::int
                    ORDER BY l.stage_changed_at)
          FILTER (WHERE l.stage_changed_at <= now() - make_interval(days => $4::int)))[1]
           AS worst_days,
         (array_agg(l.stage ORDER BY l.stage_changed_at)
          FILTER (WHERE l.stage_changed_at <= now() - make_interval(days => $4::int)))[1]
           AS worst_stage
    FROM leads l
   CROSS JOIN org
   WHERE l.status = 'open'
     AND ${held}
)`;

/**
 * Follow-ups, for the person behind this card.
 *
 * ── WHY A TASK IS "THEIRS" TWO DIFFERENT WAYS ───────────────────────────────
 *
 * `tasks.assignee_user_id` is the PRIMARY assignee and is what reminders, the
 * SLA and the compliance report read (0135 says so explicitly). But 0135 also
 * made a task shareable: a rep can be the second name on one and never appear in
 * that column. Counting the column alone would tell somebody they have no
 * follow-ups while three sat on their list.
 *
 * So a task counts when they are on `task_assignees` and have not declined, OR
 * when they are the primary and the task has NO assignee rows at all - which is
 * 0135's own rule for a pre-migration task and for anything the worker's
 * automation routed, where there was nobody to ask. Declined is excluded: coming
 * off a task is the point of declining it.
 *
 * ── AND WHY completed IS WINDOWED WHILE THE REST IS NOT ─────────────────────
 *
 * "How many did I finish in this period" and "how far behind am I" are both
 * questions a rep opens the page with, and only the first is about the window.
 * Windowing `overdue` would report a clean slate to somebody carrying nine
 * missed follow-ups from March. The page labels which is which.
 */
const SCORECARD_TASKS_CTE = `
tasks_load AS (
  SELECT (SELECT user_id FROM me) IS NOT NULL AS linked,
         count(*) FILTER (
           WHERE t.status = 'done'
             AND t.completed_at >= w.from_at
             AND t.completed_at <  w.to_at
         )::int AS completed,
         count(*) FILTER (
           WHERE t.status = 'open'
             AND t.due_on IS NOT NULL
             AND t.due_on < (SELECT day FROM today_row)
         )::int AS overdue,
         count(*) FILTER (
           WHERE t.status = 'open' AND t.due_on = (SELECT day FROM today_row)
         )::int AS due_today,
         count(*) FILTER (WHERE t.status = 'open')::int AS open_total
    FROM tasks t
   CROSS JOIN w
   WHERE (SELECT user_id FROM me) IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM task_assignees ta
          WHERE ta.task_id = t.id
            AND ta.user_id = (SELECT user_id FROM me)
            AND ta.status <> 'declined'
       )
       OR (
         t.assignee_user_id = (SELECT user_id FROM me)
         AND NOT EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id)
       )
     )
)`;

/**
 * Today, in the ORG's calendar - for the progress tracker and for deciding what
 * "overdue" means above.
 *
 * `now() AT TIME ZONE org.zone` and never this server's date, which is UTC and
 * the wrong day for five and a half hours of every Indian evening. A LEFT JOIN
 * so a rep who has not dialled yet gets a real 0 rather than no row, which is
 * the whole point of a tracker read at 9 AM.
 */
const SCORECARD_TODAY_CTE = `
today_row AS (
  SELECT (now() AT TIME ZONE org.zone)::date        AS day,
         COALESCE(s.calls_total, 0)::int            AS calls,
         COALESCE(s.calls_connected, 0)::int        AS connected
    FROM org
    LEFT JOIN telecaller_daily_stats s
      ON s.telecaller_id = $3
     AND s.day = (now() AT TIME ZONE org.zone)::date
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
         sum(s.total_call_seconds)::int AS talk_seconds,
         -- Days WORKED, not days elapsed: the rollup only writes a day somebody
         -- made a call on, so this is the right denominator for "calls on a
         -- typical day" and a weekend does not halve it.
         count(*)::int                  AS active_days
    FROM telecaller_daily_stats s
   WHERE s.day >= $1::date AND s.day <= $2::date
   GROUP BY s.telecaller_id
),
-- The floor's conversion, for the rep's own rate to be read against.
--
-- Grouped on COALESCE(assigned, attributed), which is \`leadHeldBy\` expressed as
-- a grouping key rather than as a predicate: assignment where somebody set one,
-- attribution where nobody has. Writing it any other way here would put a rep's
-- own numerator (which uses the union) over a floor median that used only one of
-- the two columns, and every rep would read as off the median on a metric where
-- half of them must be on either side of it.
leads_per_person AS (
  SELECT COALESCE(l.assigned_telecaller_id, l.telecaller_id) AS telecaller_id,
         count(*)::int                                  AS leads,
         count(*) FILTER (WHERE l.status = 'won')::int   AS won
    FROM leads l
   CROSS JOIN w
   WHERE l.created_at >= w.from_at
     AND l.created_at <  w.to_at
     AND COALESCE(l.assigned_telecaller_id, l.telecaller_id) IS NOT NULL
   GROUP BY 1
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
       )::float AS fcr_rate,
       -- Only people who actually held leads contribute: NULLIF drops a rep with
       -- no book out of the ordering rather than entering them as a 0% converter
       -- and dragging the floor's midpoint down for everyone else.
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY lp.won::float / NULLIF(lp.leads, 0)
       )::float AS conversion_rate,
       -- The tracker's pace. A median over PEOPLE, each one's own calls-per-worked-
       -- day - not total calls over total days, which is a floor average weighted
       -- by whoever dialled most and is not a typical day for anybody.
       percentile_cont(0.5) WITHIN GROUP (
         ORDER BY p.calls::float / NULLIF(p.active_days, 0)
       )::float AS calls_per_active_day
  FROM per_person p
  LEFT JOIN quality_per_person q  ON q.telecaller_id = p.telecaller_id
  LEFT JOIN fcr_per_person f      ON f.telecaller_id = p.telecaller_id
  LEFT JOIN leads_per_person lp   ON lp.telecaller_id = p.telecaller_id
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
  today: { day: string; calls: number; connected: number } | null;
  pipeline: {
    leads_worked: number;
    won: number;
    lost: number;
    open_count: number;
    won_value: number;
  } | null;
  stage_sla: {
    open_count: number;
    breached: number;
    unanswered: number;
    worst_days: number | null;
    worst_stage: string | null;
  } | null;
  tasks_load: {
    linked: boolean;
    completed: number;
    overdue: number;
    due_today: number;
    open_total: number;
  } | null;
  lead_stages: unknown;
  peers: {
    floor_size: number;
    calls: number | null;
    connect_rate: number | null;
    avg_call_seconds: number | null;
    qa_score: number | null;
    csat: number | null;
    fcr_rate: number | null;
    conversion_rate: number | null;
    calls_per_active_day: number | null;
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
  conversionRate: null,
  callsPerActiveDay: null,
};

/**
 * The card for somebody with no calls attributed to them.
 *
 * Every count is a real 0 and every rate is absent, which is the honest
 * reading: we know they made no calls, and we cannot know what their quality
 * was. The derivations in @aura/shared turn these into dashes rather than
 * zeroes because each one tests its sample size first.
 */
function emptyScorecard(from: string, to: string, today = ""): AgentScorecard {
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
    // Real zeroes for the counts and `linked: false` for the bridge, which is the
    // honest reading: somebody with no telecaller identity holds no leads and
    // their tasks cannot be found from here. `linked: false` and 0 completed are
    // NOT the same claim, and the page words them differently.
    pipeline: { leadsWorked: 0, won: 0, lost: 0, open: 0, wonValue: 0 },
    tasks: { linked: false, completed: 0, overdue: 0, dueToday: 0, openTotal: 0 },
    sla: {
      breached: 0,
      open: 0,
      worstDays: null,
      worstStage: null,
      thresholdDays: DEFAULT_STAGE_SLA_DAYS,
      unanswered: 0,
    },
    // `inRange: false` keeps the tracker off a card that has nothing to track.
    today: { day: today, calls: 0, connected: 0, pace: null, paceSource: null, inRange: false },
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
${SCORECARD_TODAY_CTE.trim()},
${SCORECARD_PIPELINE_CTE(LEAD_HELD_BY_CALLER).trim()},
${SCORECARD_SLA_CTE(LEAD_HELD_BY_CALLER).trim()},
${SCORECARD_TASKS_CTE.trim()},
${SCORECARD_PEERS_CTE.trim()}
SELECT (SELECT m.display_name FROM me m) AS display_name,
       row_to_json(totals)       AS totals,
       row_to_json(sop)          AS sop,
       row_to_json(quality)      AS quality,
       row_to_json(fcr)          AS fcr,
       fcr_configured.configured AS fcr_configured,
       days.series               AS days,
       row_to_json(today_row)    AS today,
       row_to_json(pipeline)     AS pipeline,
       row_to_json(stage_sla)    AS stage_sla,
       row_to_json(tasks_load)   AS tasks_load,
       row_to_json(peers)        AS peers,
       -- The tenant's own stage vocabulary, so worst_stage (a key) can be
       -- printed as the label the reader sees on the board. Resolved in
       -- TypeScript with parseLeadStages rather than by a lateral join here:
       -- one shared parser, and a malformed jsonb falls back to the defaults
       -- instead of taking the page down.
       (SELECT org.lead_stages FROM org) AS lead_stages
  FROM totals
  CROSS JOIN sop
  CROSS JOIN quality
  CROSS JOIN fcr
  CROSS JOIN fcr_configured
  CROSS JOIN days
  CROSS JOIN today_row
  CROSS JOIN pipeline
  CROSS JOIN stage_sla
  CROSS JOIN tasks_load
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
      const { rows } = await client.query<ScorecardRow>(SCORECARD_SQL, [
        from,
        to,
        telecallerId,
        // The stage threshold. @aura/shared owns the number; it travels in the
        // response and again in the click-through URL, so the tile, the warning
        // sentence and the list it opens all apply the same one. When a
        // per-workspace threshold exists this is the single line that changes.
        DEFAULT_STAGE_SLA_DAYS,
      ]);
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
      const today = row.today?.day ?? "";

      /**
       * The tracker's pace: what a typical day looks like, and whose typical day
       * it is.
       *
       * The floor's median first, because "is 40 calls a normal day here" is the
       * question a rep actually has. Their OWN median when the floor is too small
       * to publish one - the same MIN_PEER_FLOOR threshold that withholds every
       * other comparison, for the same reason: on a floor of three, a median plus
       * your own number is a colleague's number.
       *
       * Null when neither exists (a rep's first day), and the page then prints
       * the count with no bar rather than a bar measured against nothing.
       */
      const ownPerDay =
        (row.totals?.active_days ?? 0) > 0
          ? Math.round((row.totals?.calls ?? 0) / (row.totals?.active_days ?? 1))
          : null;
      const floorPerDay =
        !smallFloor && peers?.calls_per_active_day != null
          ? Math.round(peers.calls_per_active_day)
          : null;
      const pace: { pace: number | null; paceSource: "floor" | "own" | null } =
        floorPerDay != null
          ? { pace: floorPerDay, paceSource: "floor" }
          : ownPerDay != null
            ? { pace: ownPerDay, paceSource: "own" }
            : { pace: null, paceSource: null };

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

          pipeline: {
            leadsWorked: row.pipeline?.leads_worked ?? 0,
            won: row.pipeline?.won ?? 0,
            lost: row.pipeline?.lost ?? 0,
            open: row.pipeline?.open_count ?? 0,
            wonValue: row.pipeline?.won_value ?? 0,
          },

          tasks: {
            linked: row.tasks_load?.linked ?? false,
            completed: row.tasks_load?.completed ?? 0,
            overdue: row.tasks_load?.overdue ?? 0,
            dueToday: row.tasks_load?.due_today ?? 0,
            openTotal: row.tasks_load?.open_total ?? 0,
          },

          sla: {
            breached: row.stage_sla?.breached ?? 0,
            open: row.stage_sla?.open_count ?? 0,
            worstDays: row.stage_sla?.worst_days ?? null,
            // The tenant's own label for the stage, not its key. Falls back to
            // the key rather than to "unknown": a stage that was renamed after
            // the lead landed in it still reads as something.
            worstStage: stageLabel(row.lead_stages, row.stage_sla?.worst_stage ?? null),
            thresholdDays: DEFAULT_STAGE_SLA_DAYS,
            unanswered: row.stage_sla?.unanswered ?? 0,
          },

          today: {
            day: today,
            calls: row.today?.calls ?? 0,
            connected: row.today?.connected ?? 0,
            ...pace,
            // The range is inclusive calendar dates in the org's zone and `today`
            // came from the same zone, so this is a string comparison and not a
            // clock: no chance of the tracker appearing on a June range because
            // the server happened to be in a different day.
            inRange: today >= from && today <= to,
          },

          peer: smallFloor
            ? NO_PEERS
            : {
                calls: peers?.calls ?? null,
                connectRate: peers?.connect_rate ?? null,
                avgCallSeconds: peers?.avg_call_seconds ?? null,
                qaScore: peers?.qa_score ?? null,
                csat: peers?.csat ?? null,
                fcrRate: peers?.fcr_rate ?? null,
                conversionRate: peers?.conversion_rate ?? null,
                callsPerActiveDay: peers?.calls_per_active_day ?? null,
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

/**
 * A stage KEY as the label the reader sees on their board.
 *
 * Stage names are tenant data (`organizations.lead_stages`, 0010) and every
 * report that prints one has to go through the tenant's own list or it will say
 * "negotiation" at somebody whose board says "Site visit booked".
 *
 * Falls back to the key when the list does not contain it, which happens when a
 * stage is deleted while leads are still sitting in it - `leads.stage` is a key
 * and not a foreign key, exactly so that case does not lose the lead. The key is
 * at least true; "Unknown" would be a claim about the data rather than about the
 * configuration.
 */
function stageLabel(raw: unknown, key: string | null): string | null {
  if (!key) return null;
  return parseLeadStages(raw).find((s) => s.key === key)?.label ?? key;
}
