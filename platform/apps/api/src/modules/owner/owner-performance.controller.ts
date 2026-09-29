import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import type {
  CampaignPerformance,
  ChannelPerformance,
  PerformanceOverview,
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
WITH w AS (
  SELECT ($1::date)::timestamp AT TIME ZONE zone       AS from_at,
         (($2::date + 1))::timestamp AT TIME ZONE zone AS to_at
    FROM (SELECT COALESCE(o.reporting_timezone, 'Asia/Kolkata') AS zone
            FROM organizations o LIMIT 1) tz
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
campaigns AS (
  SELECT ms.id,
         ms.name,
         ms.channel,
         ms.spend_amount::float                                  AS spend,
         count(*)::int                                           AS leads,
         count(*) FILTER (WHERE l.status = 'won')::int            AS won,
         COALESCE(sum(l.value_num) FILTER (WHERE l.status = 'won'), 0)::float AS won_value
    FROM leads l
    JOIN marketing_sources ms ON ms.id = l.marketing_source_id
   CROSS JOIN w
   WHERE l.created_at >= w.from_at AND l.created_at < w.to_at
   GROUP BY ms.id, ms.name, ms.channel, ms.spend_amount
),
-- Rolled up from the campaigns rather than from leads.source_channel: spend
-- lives on the campaign, so grouping any other way would put a channel's leads
-- next to a spend that does not belong to them.
channels AS (
  SELECT COALESCE(c.channel, 'unattributed') AS channel,
         sum(c.leads)::int                   AS leads,
         sum(c.won)::int                     AS won,
         sum(c.won_value)::float             AS won_value,
         sum(c.spend)::float                 AS spend
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
)
SELECT row_to_json(sales)    AS sales,
       row_to_json(velocity) AS velocity,
       campaign_rows.rows    AS campaigns,
       channel_rows.rows     AS channels,
       team_rows.rows        AS team
  FROM sales
  CROSS JOIN velocity
  CROSS JOIN campaign_rows
  CROSS JOIN channel_rows
  CROSS JOIN team_rows`;

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
      }));

      const channels: ChannelPerformance[] = (row?.channels ?? []).map((c) => ({
        channel: c.channel,
        leads: c.leads,
        won: c.won,
        wonValue: c.won_value,
        spend: c.spend,
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
        },
        team,
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
