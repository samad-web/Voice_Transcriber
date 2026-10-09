import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type {
  CampaignPerformance,
  ChannelPerformance,
  FunnelStep,
  OverviewDay,
  PerformanceOverview,
  SpendBasis,
  TeamMemberLine,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * The command centre - the sales desk, the marketing spend and the floor, over
 * one window, for management.
 *
 * ── WHY IT IS NOT A SIXTH PERSONA ON /owner/overview ────────────────────────
 *
 * The dashboard (0079) composes itself from the reader's persona and answers
 * "how is MY department doing". This answers "are the departments pulling in
 * the same direction", and the difference is structural rather than
 * presentational: every figure here is only meaningful beside one from another
 * department. Cost per lead is a marketing number until it sits next to the
 * win rate on the leads it bought. Adding it to the dashboard would mean the
 * marketing persona's view silently containing per-rep quality scores, or the
 * shape of the response varying by who asked - which is exactly the trap
 * owner.controller.ts warns about for `bySource`.
 *
 * ── OWNER AND MANAGER ONLY ──────────────────────────────────────────────────
 *
 * Narrower than Sales overview, which marketing may also open. This response
 * carries a per-person team roll-up with quality scores in it, and that is the
 * staff scorecard's restriction for the staff scorecard's reason: who reads
 * the table naming colleagues is a management decision, not a default. A
 * marketing lead wanting campaign returns has them on the dashboard and in
 * Reports; a rep's own numbers are on /owner/my-performance.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * Target attainment. `GET /targets/attainment` already computes it - including
 * `pace`, which is the only thing that makes a mid-period target readable -
 * and the console composes the two responses. Re-deriving attainment here
 * would put a second implementation of "what has been closed against this
 * quarter" in the codebase, and the first one somebody edits is the one the
 * other page keeps disagreeing with.
 */

const RangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
});

/**
 * ONE statement, one round trip - the rule staff-performance.controller.ts
 * sets out. Six independent aggregates over five tables, issued separately,
 * would be six Mumbai→Seoul exchanges before Postgres does any work.
 *
 * ── THE WINDOW ──────────────────────────────────────────────────────────────
 *
 * Calendar dates in the org's reporting zone, converted to instants once, the
 * same way every other ranged read on this platform does it.
 *
 * ── NOW vs IN THE WINDOW ────────────────────────────────────────────────────
 *
 * Every figure is one or the other and never a muddle of both (docs/29 A4):
 * leads CREATED in the window, deals CLOSED in the window (terminal status
 * with `stage_changed_at` inside it - the predicate Reports and the dashboard
 * both use, so the three cannot disagree), and open pipeline as it stands NOW,
 * because a pipeline is a present-tense fact and windowing it would describe
 * something nobody has.
 */
const PERFORMANCE_SQL = `
WITH org AS (
  SELECT COALESCE(o.reporting_timezone, 'Asia/Kolkata') AS zone,
         o.lead_stages
    FROM organizations o LIMIT 1
),
w AS (
  SELECT ($1::date)::timestamp AT TIME ZONE org.zone       AS from_at,
         (($2::date + 1))::timestamp AT TIME ZONE org.zone AS to_at
    FROM org
),
-- ── The funnel's columns: the tenant's own OPEN stages, in board order ──────
--
-- Terminal stages are excluded, the same rule the deals funnel follows: "Lost"
-- is not a position in a funnel, it is what happened to leads that stopped at
-- one. Won is handled as a high-water mark below rather than as a column, so the
-- funnel's last bar is the last real stage before the sale.
--
-- WITH ORDINALITY is what gives each stage its position. The jsonb array's ORDER
-- is the board's order - there is no explicit rank column - so the position has
-- to come from the array itself.
stages AS (
  SELECT (s.ordinality - 1)::int AS position,
         s.value ->> 'key'       AS key,
         s.value ->> 'label'     AS label
    FROM org,
         jsonb_array_elements(org.lead_stages) WITH ORDINALITY AS s(value, ordinality)
   WHERE s.value ->> 'terminal' IS NULL
),
-- ── How far each lead in the cohort ever got ────────────────────────────────
--
-- The furthest OPEN stage, as a high-water mark, so the funnel is monotonic: a
-- lead now in Negotiation counts at every stage up to it, and one that was moved
-- backwards still counts at its furthest.
--
-- THREE SOURCES, and all three are load-bearing:
--
--   the ledger        lead_stage_transitions (0075) - every stage it was in.
--   its current stage because nothing wrote that ledger until the 2026-09-21
--                     fix. On any workspace older than that most leads have NO
--                     transitions, and a funnel built on the ledger alone would
--                     collapse every one of them onto the entry stage - drawing
--                     a catastrophic drop-off that is an artefact of when the
--                     ledger started, not of anything the floor did.
--   status = 'won'    a win reached everything. Its own stage is the terminal
--                     one, which is not a position, and its transitions may go
--                     straight from New to Won.
--
-- Floored at 0: every lead that exists entered the pipeline. Dropping the
-- unknowns would make the top of the funnel smaller than the number of leads
-- created, shrinking every denominator below it and flattering every rate.
lead_reach AS (
  SELECT l.id,
         CASE
           WHEN l.status = 'won' THEN (SELECT max(position) FROM stages)
           ELSE GREATEST(COALESCE(max(hist.position), 0), COALESCE(max(cur.position), 0))
         END AS furthest
    FROM leads l
   CROSS JOIN w
    LEFT JOIN lead_stage_transitions t ON t.lead_id = l.id
    LEFT JOIN stages hist ON hist.key = t.to_stage
    LEFT JOIN stages cur  ON cur.key  = l.stage
   WHERE l.created_at >= w.from_at
     AND l.created_at <  w.to_at
   GROUP BY l.id, l.status
),
funnel AS (
  SELECT st.position,
         st.key,
         st.label,
         count(lr.id)::int AS reached
    FROM stages st
    LEFT JOIN lead_reach lr ON lr.furthest >= st.position
   GROUP BY st.position, st.key, st.label
),
-- ── The daily series behind the sparklines ──────────────────────────────────
--
-- DENSE: one row per calendar day in the range whether anything happened or not.
-- A sparkline that omits quiet days compresses a fortnight of nothing into one
-- flat step and reads as steady activity - and unlike a rep's call rollup, where
-- an absent day is a weekend rather than a zero, a day on which the business
-- acquired no leads genuinely is a zero.
--
-- Bucketed in the ORG's zone, so a lead that arrived at 11 PM in Mumbai lands on
-- the day the floor would say it did rather than on the UTC day after.
calendar AS (
  SELECT gs::date AS day
    FROM generate_series($1::date, $2::date, interval '1 day') gs
),
leads_by_day AS (
  SELECT (l.created_at AT TIME ZONE org.zone)::date AS day, count(*)::int AS leads
    FROM leads l CROSS JOIN org CROSS JOIN w
   WHERE l.created_at >= w.from_at AND l.created_at < w.to_at
   GROUP BY 1
),
wins_by_day AS (
  SELECT (l.stage_changed_at AT TIME ZONE org.zone)::date AS day,
         count(*)::int                                   AS won,
         COALESCE(sum(l.value_num), 0)::float            AS won_value
    FROM leads l CROSS JOIN org CROSS JOIN w
   WHERE l.status = 'won'
     AND l.stage_changed_at >= w.from_at
     AND l.stage_changed_at <  w.to_at
   GROUP BY 1
),
sales AS (
  SELECT
    count(*) FILTER (
      WHERE l.created_at >= w.from_at AND l.created_at < w.to_at
    )::int AS leads_created,
    count(*) FILTER (
      WHERE l.status = 'won' AND l.stage_changed_at >= w.from_at AND l.stage_changed_at < w.to_at
    )::int AS won,
    count(*) FILTER (
      WHERE l.status = 'lost' AND l.stage_changed_at >= w.from_at AND l.stage_changed_at < w.to_at
    )::int AS lost,
    COALESCE(sum(l.value_num) FILTER (
      WHERE l.status = 'won' AND l.stage_changed_at >= w.from_at AND l.stage_changed_at < w.to_at
    ), 0)::float AS won_value,
    -- NOW, not in the window. See the header.
    COALESCE(sum(l.value_num) FILTER (WHERE l.status = 'open'), 0)::float AS pipeline_value,
    count(*) FILTER (WHERE l.status = 'open')::int AS open_count
  FROM leads l CROSS JOIN w
),
-- How long a win took: created to the moment it went terminal. Median as well
-- as mean because one enterprise deal drags a mean far enough to make it
-- useless for the thing it is read for, which is "how long is our cycle".
velocity AS (
  SELECT count(*)::int AS won_deals,
         avg(EXTRACT(EPOCH FROM (l.stage_changed_at - l.created_at)) / 86400)::float AS avg_days,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (l.stage_changed_at - l.created_at)) / 86400
         )::float AS median_days
    FROM leads l CROSS JOIN w
   WHERE l.status = 'won'
     AND l.stage_changed_at >= w.from_at
     AND l.stage_changed_at < w.to_at
     -- A win stamped before the lead existed is a data fault, not a zero-day
     -- cycle, and averaging it in would quietly shorten the reported cycle.
     AND l.stage_changed_at >= l.created_at
),
-- INNER JOIN, not LEFT: a lead with no campaign is not an anonymous campaign,
-- it is a lead that did not come from one. The same reasoning
-- owner.controller.ts gives for the dashboard's campaign table.
-- ── What the window's spend actually was (migration 0171) ───────────────────
--
-- marketing_sources.spend_amount is a LIFETIME total, so dividing it into a
-- week's leads understates the return of anything long-running. 0171 records
-- spend per calendar month, and this CTE turns those months into the part of
-- them that falls inside the reporting window.
--
-- PRO-RATED BY OVERLAPPING DAYS: a window covering 8 of October's 31 days takes
-- 8/31 of October. The assumption (spend is even across a month) is stated in
-- 0171's header and is a far smaller one than the lifetime figure it replaces.
--
-- The arithmetic is deliberately explicit rather than a date-range intersection
-- helper: GREATEST(month_start, from) to LEAST(month_end, to) inclusive, +1
-- so a single-day overlap counts as one day and not as zero.
window_spend AS (
  SELECT sp.source_id,
         sum(
           sp.amount
           * (
               (LEAST((sp.month + interval '1 month' - interval '1 day')::date, $2::date)
                - GREATEST(sp.month, $1::date) + 1)::numeric
               / EXTRACT(DAY FROM (sp.month + interval '1 month' - interval '1 day'))::numeric
             )
         )::float AS spend
    FROM marketing_source_spend sp
   WHERE sp.month <= $2::date
     AND (sp.month + interval '1 month' - interval '1 day')::date >= $1::date
   GROUP BY sp.source_id
),
-- Which campaigns have ANY monthly spend at all, which is a different question
-- from how much of it lands in this window. A campaign whose months are all
-- outside the range has period-basis spend of zero - a real answer - and must
-- NOT silently fall back to its lifetime total, or the fallback would reappear
-- exactly when somebody narrows the date range.
has_period_spend AS (
  SELECT DISTINCT source_id FROM marketing_source_spend
),
-- INNER JOIN, not LEFT: a lead with no campaign is not an anonymous campaign,
-- it is a lead that did not come from one. The same reasoning
-- owner.controller.ts gives for the dashboard's campaign table.
campaigns AS (
  SELECT ms.id,
         ms.name,
         ms.channel,
         CASE
           WHEN hps.source_id IS NOT NULL THEN COALESCE(ws.spend, 0)
           ELSE ms.spend_amount::float
         END AS spend,
         CASE
           WHEN hps.source_id IS NOT NULL   THEN 'period'
           WHEN ms.spend_amount IS NOT NULL THEN 'lifetime'
           ELSE 'none'
         END AS spend_basis,
         count(*)::int                                           AS leads,
         count(*) FILTER (WHERE l.status = 'won')::int            AS won,
         COALESCE(sum(l.value_num) FILTER (WHERE l.status = 'won'), 0)::float AS won_value
    FROM leads l
    JOIN marketing_sources ms ON ms.id = l.marketing_source_id
    LEFT JOIN window_spend ws     ON ws.source_id  = ms.id
    LEFT JOIN has_period_spend hps ON hps.source_id = ms.id
   CROSS JOIN w
   WHERE l.created_at >= w.from_at AND l.created_at < w.to_at
   GROUP BY ms.id, ms.name, ms.channel, ms.spend_amount, ws.spend, hps.source_id
),
-- Rolled up from the campaigns rather than from leads.source_channel: spend
-- lives on the campaign, so grouping any other way would put a channel's leads
-- next to a spend that does not belong to them.
--
-- The channel's basis is the WEAKEST of its campaigns': one lifetime figure in
-- the sum makes the total a mixture, and a reader told "period" has to be able
-- to rely on that. Campaigns with no spend at all do not weaken it - they
-- contribute nothing to the sum, so they cannot make it wrong.
channels AS (
  SELECT COALESCE(c.channel, 'unattributed') AS channel,
         sum(c.leads)::int                   AS leads,
         sum(c.won)::int                     AS won,
         sum(c.won_value)::float             AS won_value,
         sum(c.spend)::float                 AS spend,
         CASE
           WHEN count(*) FILTER (WHERE c.spend_basis = 'lifetime') > 0 THEN 'lifetime'
           WHEN count(*) FILTER (WHERE c.spend_basis = 'period')   > 0 THEN 'period'
           ELSE 'none'
         END AS spend_basis
    FROM campaigns c
   GROUP BY 1
),
team AS (
  SELECT s.telecaller_id,
         t.display_name,
         sum(s.calls_total)::int     AS calls,
         sum(s.calls_connected)::int AS connected
    FROM telecaller_daily_stats s
    JOIN telecallers t ON t.id = s.telecaller_id
   WHERE s.day >= $1::date AND s.day <= $2::date
   GROUP BY 1, 2
),
team_quality AS (
  SELECT c.telecaller_id,
         avg(a.quality_score)::float  AS qa_score,
         count(a.quality_score)::int  AS scored
    FROM calls c
    CROSS JOIN w
    LEFT JOIN call_analytics a ON a.call_id = c.id
   WHERE c.telecaller_id IS NOT NULL
     AND c.started_at >= w.from_at
     AND c.started_at <  w.to_at
   GROUP BY 1
),
-- Attributed on the lead's write-once telecaller snapshot (0017), so a handset
-- changing hands does not move last quarter's leads to whoever holds it now.
team_leads AS (
  SELECT l.telecaller_id,
         count(*)::int                                 AS leads,
         count(*) FILTER (WHERE l.status = 'won')::int  AS won
    FROM leads l CROSS JOIN w
   WHERE l.telecaller_id IS NOT NULL
     AND l.created_at >= w.from_at
     AND l.created_at <  w.to_at
   GROUP BY 1
),
team_rows AS (
  SELECT coalesce(json_agg(r ORDER BY r.calls DESC), '[]'::json) AS rows
    FROM (
      SELECT t.telecaller_id,
             t.display_name,
             t.calls,
             t.connected,
             q.qa_score,
             q.scored,
             COALESCE(tl.leads, 0) AS leads,
             COALESCE(tl.won, 0)   AS won
        FROM team t
        LEFT JOIN team_quality q  ON q.telecaller_id = t.telecaller_id
        LEFT JOIN team_leads  tl  ON tl.telecaller_id = t.telecaller_id
    ) r
),
campaign_rows AS (
  SELECT coalesce(json_agg(c ORDER BY c.leads DESC), '[]'::json) AS rows FROM campaigns c
),
channel_rows AS (
  SELECT coalesce(json_agg(c ORDER BY c.leads DESC), '[]'::json) AS rows FROM channels c
),
funnel_rows AS (
  SELECT coalesce(json_agg(f ORDER BY f.position), '[]'::json) AS rows FROM funnel f
),
daily_rows AS (
  SELECT coalesce(json_agg(d ORDER BY d.day), '[]'::json) AS rows
    FROM (
      SELECT c.day::text                     AS day,
             COALESCE(lb.leads, 0)::int      AS leads,
             COALESCE(wb.won, 0)::int        AS won,
             COALESCE(wb.won_value, 0)::float AS won_value
        FROM calendar c
        LEFT JOIN leads_by_day lb ON lb.day = c.day
        LEFT JOIN wins_by_day  wb ON wb.day = c.day
    ) d
)
SELECT row_to_json(sales)    AS sales,
       row_to_json(velocity) AS velocity,
       campaign_rows.rows    AS campaigns,
       channel_rows.rows     AS channels,
       team_rows.rows        AS team,
       funnel_rows.rows      AS funnel,
       daily_rows.rows       AS daily
  FROM sales
  CROSS JOIN velocity
  CROSS JOIN campaign_rows
  CROSS JOIN channel_rows
  CROSS JOIN team_rows
  CROSS JOIN funnel_rows
  CROSS JOIN daily_rows`;

/**
 * Below this many scored calls a person's quality average is withheld from the
 * roll-up. Matches `MIN_QUALITY_SAMPLE` in @aura/shared, so a manager reading
 * the team table and the rep reading their own scorecard see a number appear
 * at the same moment - and never a figure on one page and a dash on the other.
 */
const MIN_TEAM_QUALITY_SAMPLE = 8;

interface RawRow {
  sales: {
    leads_created: number;
    won: number;
    lost: number;
    won_value: number;
    pipeline_value: number;
    open_count: number;
  } | null;
  velocity: { won_deals: number; avg_days: number | null; median_days: number | null } | null;
  campaigns: Array<{
    id: string;
    name: string;
    channel: string | null;
    spend: number | null;
    spend_basis: SpendBasis;
    leads: number;
    won: number;
    won_value: number;
  }> | null;
  channels: Array<{
    channel: string;
    leads: number;
    won: number;
    won_value: number;
    spend: number | null;
    spend_basis: SpendBasis;
  }> | null;
  team: Array<{
    telecaller_id: string;
    display_name: string;
    calls: number;
    connected: number;
    qa_score: number | null;
    scored: number;
    leads: number;
    won: number;
  }> | null;
  funnel: Array<{ position: number; key: string; label: string; reached: number }> | null;
  daily: Array<{ day: string; leads: number; won: number; won_value: number }> | null;
}

@Controller("owner/performance")
// Same order as every other owner-console route. OwnerRoleGuard is NOT inert
// here: the handler declares a real requirement below.
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
@RequireFeature("reports")
export class OwnerPerformanceController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireOwnerRole("owner", "manager")
  async performance(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = RangeQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to } = parsed.data;
    if (from > to) throw new BadRequestException("from must not be after to");

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<RawRow>(PERFORMANCE_SQL, [from, to]);
      const row = rows[0];

      const campaigns: CampaignPerformance[] = (row?.campaigns ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        channel: c.channel,
        leads: c.leads,
        won: c.won,
        wonValue: c.won_value,
        spend: c.spend,
        spendBasis: c.spend_basis,
      }));

      const channels: ChannelPerformance[] = (row?.channels ?? []).map((c) => ({
        channel: c.channel,
        leads: c.leads,
        won: c.won,
        wonValue: c.won_value,
        spend: c.spend,
        spendBasis: c.spend_basis,
      }));

      const team: TeamMemberLine[] = (row?.team ?? []).map((t) => ({
        telecallerId: t.telecaller_id,
        displayName: t.display_name,
        calls: t.calls,
        connected: t.connected,
        // Withheld below the sample floor rather than rounded - see the note
        // on MIN_TEAM_QUALITY_SAMPLE.
        qaScore: t.scored >= MIN_TEAM_QUALITY_SAMPLE && t.qa_score != null
          ? Math.round(t.qa_score)
          : null,
        leads: t.leads,
        won: t.won,
      }));

      const spends = campaigns.map((c) => c.spend).filter((s): s is number => s != null && s > 0);

      /**
       * The funnel, with each step's conversion from the one before it.
       *
       * Computed here rather than in SQL because `conversionFromPrevious` needs
       * the previous ROW, and a window function over the funnel CTE would put a
       * second place where "what share got through" is defined - the one thing
       * @aura/shared's header for these derivations says must not happen. The SQL
       * produces monotonic counts; this turns them into rates.
       *
       * `droppedBefore` is the absolute count that stopped at the previous step,
       * which is what the page leads with: "38% drop-off" and "eleven people"
       * prompt different conversations and only the second one can be worked.
       */
      const steps = row?.funnel ?? [];
      const funnel: FunnelStep[] = steps.map((s, i) => {
        const previous = i === 0 ? null : (steps[i - 1]?.reached ?? 0);
        return {
          stage: s.key,
          label: s.label,
          reached: s.reached,
          conversionFromPrevious:
            previous === null || previous === 0
              ? null
              : Number((s.reached / previous).toFixed(4)),
          droppedBefore: previous === null ? 0 : Math.max(0, previous - s.reached),
        };
      });

      const daily: OverviewDay[] = (row?.daily ?? []).map((d) => ({
        day: d.day,
        leads: d.leads,
        won: d.won,
        wonValue: d.won_value,
      }));

      const overview: PerformanceOverview = {
        from,
        to,
        sales: {
          leadsCreated: row?.sales?.leads_created ?? 0,
          won: row?.sales?.won ?? 0,
          lost: row?.sales?.lost ?? 0,
          pipelineValue: row?.sales?.pipeline_value ?? 0,
          wonValue: row?.sales?.won_value ?? 0,
          velocity: {
            wonDeals: row?.velocity?.won_deals ?? 0,
            avgDaysToWin: round1(row?.velocity?.avg_days),
            medianDaysToWin: round1(row?.velocity?.median_days),
            openValue: row?.sales?.pipeline_value ?? 0,
            openCount: row?.sales?.open_count ?? 0,
          },
        },
        marketing: {
          campaigns,
          channels,
          totalSpend: spends.length > 0 ? spends.reduce((a, b) => a + b, 0) : null,
          spendRecorded: spends.length > 0,
          // Counted over campaigns that HAVE a spend: one with none is not on
          // the old basis, it is simply unrecorded, and folding the two
          // together would tell a workspace that has entered nothing that
          // everything needs migrating.
          campaignsOnLifetimeSpend: campaigns.filter((c) => c.spendBasis === "lifetime").length,
        },
        team,
        funnel,
        daily,
        // Composed by the console from GET /targets/attainment - see the
        // class header for why it is not re-derived here.
        goals: [],
      };

      return overview;
    });
  }
}

/** One decimal. A cycle length quoted to four is a false claim about precision. */
function round1(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(1));
}
