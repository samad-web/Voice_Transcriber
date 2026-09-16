import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { parseLeadStages, parsePipelineStages } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OwnerScope, type OwnerRecordScope, ownerScopeAnd } from "../../common/owner-scope";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
import { DbService } from "../../db/db.service";

/**
 * The three aggregates the persona dashboards need and the original KPI row
 * never had (migration 0079). Built here as functions rather than written
 * twice, because `overview()` and `crmOverview()` are two readings of the same
 * dashboard and a panel that silently exists on only one of them is a page
 * that changes shape when a feature flag moves.
 *
 * All three read `leads`, including from `crmOverview()`, which otherwise
 * reads `deals`. That is not an oversight: `source_channel`,
 * `lead_source_id` and `marketing_source_id` (migration 0078) live on `leads`
 * and have no counterpart on `deals`. Attribution is a question about where
 * demand ARRIVED, which is the lead's story - a deal is what happened to it
 * afterwards.
 *
 * `scopeAnd` is the persona predicate, already rendered as ` AND <sql>` or
 * empty by ownerScopeAnd(). It is threaded through rather than recomputed so
 * these can never disagree with the statements around them about whose
 * records the page is describing.
 */
function sourceBreakdownSql(days: number, scopeAnd: string): string {
  return `SELECT COALESCE(l.source_channel, 'unknown') AS channel,
                 count(*)::int AS leads,
                 count(*) FILTER (WHERE l.status = 'won')::int AS won,
                 COALESCE(sum(l.value_num) FILTER (WHERE l.status = 'won'), 0)::float AS won_value
            FROM leads l
           WHERE l.created_at > now() - make_interval(days => ${days})${scopeAnd}
           GROUP BY 1
           ORDER BY 2 DESC`;
}

function campaignBreakdownSql(days: number, scopeAnd: string): string {
  // INNER JOIN, not LEFT: a lead with no campaign is not an anonymous campaign,
  // it is a lead that did not come from one, and rolling those into a "(none)"
  // row at the top of a campaign table would bury every real campaign under
  // the organic traffic.
  return `SELECT ms.id, ms.name,
                 count(*)::int AS leads,
                 count(*) FILTER (WHERE l.status = 'won')::int AS won,
                 COALESCE(sum(l.value_num) FILTER (WHERE l.status = 'won'), 0)::float AS won_value
            FROM leads l
            JOIN marketing_sources ms ON ms.id = l.marketing_source_id
           WHERE l.created_at > now() - make_interval(days => ${days})${scopeAnd}
           GROUP BY ms.id, ms.name
           ORDER BY 3 DESC
           LIMIT 8`;
}

/**
 * Open follow-ups, split by how late they are.
 *
 * Deliberately NOT windowed by `days` like everything else on this page. A task
 * that was due three months ago is more urgent than one due tomorrow, not less,
 * and hiding it because it fell outside the reporting window would quietly drop
 * the most overdue work off the dashboard of the person who owes it.
 *
 * `due_on` is a DATE (migration 0041 chose that over a timestamp so "due
 * Thursday" does not depend on the reader's timezone), so the comparisons are
 * against CURRENT_DATE and `overdue` is strictly before today - something due
 * today is due, not late.
 */
function taskLoadSql(scopeAnd: string): string {
  return `SELECT count(*)::int AS open,
                 count(*) FILTER (WHERE t.due_on < CURRENT_DATE)::int AS overdue,
                 count(*) FILTER (WHERE t.due_on = CURRENT_DATE)::int AS due_today,
                 count(*) FILTER (WHERE t.due_on IS NULL)::int AS undated
            FROM tasks t
           WHERE t.status = 'open'${scopeAnd}`;
}

const WindowQuery = z.object({
  /** Reporting window. 30 days matches the usage page's default period. */
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const TelecallerBody = z.object({
  /** Empty string clears it, falling the console back to the device label. */
  name: z.string().max(120),
  // True when this handset now belongs to a genuinely different person -
  // mints a new telecaller identity instead of renaming the existing one.
  // False (the default) is for correcting a typo in the current holder's
  // own name.
  reassign: z.boolean().default(false),
});

/**
 * The customer owner's view of their own instance (§4.2).
 *
 * Everything here is a rollup of data the tenant already owns - calls, leads
 * and the handsets they came from - scoped by RLS to the org on the request.
 * The owner console reads only these endpoints plus /v1/leads, which is why it
 * can be given to a customer without exposing the operator surface.
 */
@Controller("owner")
// OwnerScopeGuard is mounted on the CLASS, not per-handler, on purpose: a
// route added here later reads records for whoever is asking, and the failure
// mode of forgetting the guard is a silent whole-org leak rather than an
// error. Mounting it once means a new handler is scoped by default and has to
// opt out deliberately. It never denies - see its header.
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OwnerScopeGuard)
export class OwnerController {
  constructor(private readonly db: DbService) {}

  @Get("overview")
  async overview(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const parsed = WindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { days } = parsed.data;

    // ── The persona narrowing (migration 0079) ─────────────────────────
    //
    // `13_ROUTE_AND_GUARD_INVENTORY.md` finding 3: this route mounted
    // OwnerRoleGuard but declared no `@RequireOwnerRole`, so the guard was
    // inert on it and a telecaller read the whole floor's numbers. The fix is
    // NOT to add a persona requirement - every persona is entitled to a
    // dashboard, that is the point of one - it is to make the dashboard show
    // their own desk.
    //
    // These are `AND <predicate>` fragments, empty for owner/manager/
    // marketing. They are literals rather than bind parameters because the
    // multi-statement protocol below takes no parameters; ownerScopeLiteral
    // re-validates the uuid it interpolates and can only ever produce a
    // never-matching sentinel otherwise. See owner-scope.ts.
    const leadAnd = ownerScopeAnd("lead", scope);
    const leadAndL = ownerScopeAnd("lead", scope, "l");
    const callAnd = ownerScopeAnd("call", scope);
    // `WHERE` where there was no clause at all, so the two aggregates that
    // filter nothing today still read as ordinary SQL.
    const leadWhere = leadAnd ? ` WHERE ${leadAnd.slice(" AND ".length)}` : "";
    // The leaderboard is a list of DEVICES, and `devices.telecaller_id` (0017)
    // is the same column shape `calls` carries - so the call predicate aliased
    // to `d` is exactly the filter that reduces the floor's leaderboard to the
    // one handset this person actually holds.
    const leaderboardAnd = ownerScopeAnd("call", scope, "d");
    // Tasks scope on the USER, not the telecaller identity - see
    // ownerScopeFilter's task branch, and crm-scope.ts, which must agree with
    // it or the same task would appear on the dashboard and vanish from
    // /v1/tasks.
    const taskAnd = ownerScopeAnd("task", scope, "t");

    return this.db.withOrg(orgId, async (client) => {
      // ONE round trip for all seven reads - see crmOverview() below for the
      // full reasoning. Same shape, same trade-off: these aggregates are
      // mutually independent, so issuing them one at a time bought nothing but
      // seven sequential Mumbai→Seoul flights on the console's landing page.
      // `days` is interpolated because the multi-statement protocol takes no
      // bind parameters; `WindowQuery` has already pinned it to an integer
      // in 1..365.
      const batch = (await client.query(
        [
          `SELECT id, name, lead_stages FROM organizations LIMIT 1`,

          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status = 'open')::int AS open,
                  count(*) FILTER (WHERE status = 'won')::int  AS won,
                  count(*) FILTER (WHERE status = 'lost')::int AS lost,
                  count(*) FILTER (WHERE created_at > now() - make_interval(days => ${days}))::int AS created_in_window,
                  COALESCE(sum(value_num) FILTER (WHERE status = 'open'), 0)::float AS pipeline_value,
                  COALESCE(sum(value_num) FILTER (WHERE status = 'won'),  0)::float AS won_value
             FROM leads${leadWhere}`,

          /*
           * The call KPI row, broken out by the four states the console paints
           * (packages/ui/src/state.tsx): outgoing, answered, missed, error.
           *
           * `missed` is DERIVED, because the schema has no such status - and
           * never did. `calls.status` is the processing pipeline
           * (AWAITING_AUDIO -> ... -> COMPLETE, plus FAILED_*), so the only
           * columns that can answer "did anyone pick up" are direction and
           * duration: an inbound call that connected for zero seconds is one
           * nobody answered. Same test packages/shared's telephony intake
           * already applies to a CTI webhook's `call_status: "missed"`.
           *
           * outgoing + answered + missed = total exactly, because `direction`
           * carries a CHECK constraint admitting only those two values.
           *
           * `failed` deliberately OVERLAPS the three rather than slicing them.
           * A transcode that fell over does not un-make the phone call: the
           * handset still reports which way it went and how long it lasted, so
           * a failed outgoing call is still an outgoing call in this row, and
           * `failed` counts - separately - how many of the window's calls we
           * could not process. Making it a fifth exclusive bucket would mean
           * an owner's "missed calls" number quietly shrank whenever the
           * worker had a bad afternoon, which is the one thing a missed-call
           * number must never do.
           *
           * (A per-ROW chip resolves the same overlap the other way and shows
           * the error - see callState(). There, "you have no transcript" is
           * the fact the reader needs; here, it is not.)
           */
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status = 'COMPLETE')::int AS complete,
                  count(*) FILTER (WHERE direction = 'outgoing')::int AS outgoing,
                  count(*) FILTER (WHERE direction = 'incoming' AND duration_s > 0)::int AS answered,
                  count(*) FILTER (WHERE direction = 'incoming' AND duration_s <= 0)::int AS missed,
                  count(*) FILTER (WHERE status LIKE 'FAILED%')::int AS failed,
                  COALESCE(sum(duration_s), 0)::int AS total_seconds
             FROM calls
            WHERE started_at > now() - make_interval(days => ${days})${callAnd}`,

          // Board shape: every stage, including the empty ones, so the funnel
          // does not silently change width as leads move.
          `SELECT stage, count(*)::int AS count, COALESCE(sum(value_num), 0)::float AS value
             FROM leads${leadWhere} GROUP BY stage`,

          /*
           * Per-telecaller performance. Attribution follows the handset: a lead
           * belongs to whoever's phone first qualified it, so credit does not move
           * when a colleague later picks up the follow-up call.
           *
           * Every active device is listed even with no activity - "made no calls
           * this month" is exactly what an owner needs to see. A retired handset is
           * hidden only once it has nothing in the window either; its calls are in
           * the totals above, so dropping it unconditionally would leave the
           * leaderboard failing to add up to the KPI row.
           */
          `SELECT d.id, d.label, d.telecaller_name, d.status, d.last_seen_at,
                  COALESCE(c.calls, 0)         AS calls,
                  COALESCE(c.talk_seconds, 0)  AS talk_seconds,
                  c.last_call_at,
                  COALESCE(l.leads, 0)         AS leads,
                  COALESCE(l.won, 0)           AS won,
                  COALESCE(l.pipeline_value, 0)::float AS pipeline_value
             FROM devices d
             LEFT JOIN (
               SELECT device_id, telecaller_id,
                      count(*)::int AS calls,
                      COALESCE(sum(duration_s), 0)::int AS talk_seconds,
                      max(started_at) AS last_call_at
                 FROM calls
                WHERE started_at > now() - make_interval(days => ${days})
                GROUP BY device_id, telecaller_id
             -- Reassignment-safe (0068): a call only counts toward THIS device's
             -- row if it was made while attributed to the SAME telecaller this
             -- device currently points at - so a phone handed to a new hire
             -- stops inheriting the previous holder's history. IS NOT DISTINCT
             -- FROM (not =) so an org that has never assigned a telecaller at
             -- all still sees its devices' plain call counts, matching NULL to
             -- NULL rather than dropping them.
             ) c ON c.device_id = d.id AND c.telecaller_id IS NOT DISTINCT FROM d.telecaller_id
             LEFT JOIN (
               SELECT telecaller_device_id,
                      count(*)::int AS leads,
                      count(*) FILTER (WHERE status = 'won')::int AS won,
                      COALESCE(sum(value_num) FILTER (WHERE status = 'open'), 0) AS pipeline_value
                 FROM leads
                WHERE created_at > now() - make_interval(days => ${days})
                GROUP BY telecaller_device_id
             ) l ON l.telecaller_device_id = d.id
            WHERE (d.status <> 'wiped' OR COALESCE(c.calls, 0) > 0 OR COALESCE(l.leads, 0) > 0)
              ${leaderboardAnd}
            ORDER BY COALESCE(l.leads, 0) DESC, COALESCE(c.calls, 0) DESC, d.label ASC`,

          // Calls and leads share one series so the dashboard can draw them on
          // the same axis; days with neither are absent and the client fills
          // the gap.
          `SELECT day, sum(calls)::int AS calls, sum(leads)::int AS leads FROM (
             SELECT date_trunc('day', started_at)::date AS day, count(*)::int AS calls, 0 AS leads
               FROM calls  WHERE started_at > now() - make_interval(days => ${days})${callAnd} GROUP BY 1
             UNION ALL
             SELECT date_trunc('day', created_at)::date AS day, 0 AS calls, count(*)::int AS leads
               FROM leads  WHERE created_at > now() - make_interval(days => ${days})${leadAnd} GROUP BY 1
           ) series GROUP BY day ORDER BY day`,

          `SELECT l.id, l.title, l.stage, l.status, l.value_num, l.last_activity_at,
                  COALESCE(d.telecaller_name, d.label) AS telecaller
             FROM leads l
             LEFT JOIN devices d ON d.id = l.telecaller_device_id
            ${leadAndL ? `WHERE ${leadAndL.slice(" AND ".length)}` : ""}
            ORDER BY l.last_activity_at DESC
            LIMIT 8`,

          // Three additions for the persona dashboards (0079). They ride in
          // the SAME batch, so the marketing and telecaller views cost the
          // dashboard nothing in round trips - which is the whole reason this
          // query is shaped the way it is.
          sourceBreakdownSql(days, leadAndL),
          campaignBreakdownSql(days, leadAndL),
          taskLoadSql(taskAnd),
        ].join(";\n"),
      )) as unknown as { rows: Record<string, unknown>[] }[];

      const [
        orgRes,
        leadsRes,
        callsRes,
        stageRes,
        telecallerRes,
        byDayRes,
        recentRes,
        sourceRes,
        campaignRes,
        taskRes,
      ] = batch;

      const org = orgRes.rows[0];
      if (!org) throw new NotFoundException("organization not found");

      const leads = leadsRes.rows[0];
      const calls = callsRes.rows[0];
      const stageRows = stageRes.rows as unknown as { stage: string; count: number; value: number }[];
      const telecallers = telecallerRes.rows;
      const byDay = byDayRes.rows;
      const recent = recentRes.rows;

      const stages = parseLeadStages(org.lead_stages);
      const funnel = stages.map((s) => {
        const row = stageRows.find((r) => r.stage === s.key);
        return { ...s, count: row?.count ?? 0, value: row?.value ?? 0 };
      });

      return {
        org: { id: org.id, name: org.name },
        window: { days },
        leads,
        calls,
        funnel,
        stages,
        telecallers,
        byDay,
        recent,
        // Present for every persona even though only some dashboards render
        // them. A response whose SHAPE depends on who is asking is a response
        // the client has to branch on twice - once for the persona and once
        // for whether the key exists - and the second branch is the one that
        // gets forgotten.
        bySource: sourceRes.rows,
        byCampaign: campaignRes.rows,
        tasks: taskRes.rows[0] ?? { open: 0, overdue: 0, due_today: 0, undated: 0 },
      };
    });
  }

  /**
   * A6, Milestone 4: the same dashboard, read from `deals`/`contacts`/
   * `deal_pipelines` instead of `leads`. Deliberately returns the exact same
   * shape `overview()` does (including the `leads`/`byDay[].leads` field
   * names) so `owner/page.tsx` can call either endpoint and render with the
   * same JSX - only the data source forks, not the page. See
   * `/owner/reports` for forecast/funnel/rep-performance detail; this is
   * only the KPI-row-plus-recent-activity shape that endpoint doesn't cover.
   */
  @Get("crm-overview")
  async crmOverview(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const parsed = WindowQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { days } = parsed.data;

    // The persona narrowing, exactly as overview() applies it - see the long
    // comment there. Different columns, same rule: a deal is scoped on
    // `assigned_telecaller_id` alone, with no attribution fallback, because
    // nothing creates a deal from a call and an unassigned deal therefore
    // belongs to the shared queue rather than to whoever sourced it
    // (owner-scope.ts explains the asymmetry with leads).
    const dealAnd = ownerScopeAnd("deal", scope);
    const dealAndD = ownerScopeAnd("deal", scope, "d");
    const callAnd = ownerScopeAnd("call", scope);
    const leaderboardAnd = ownerScopeAnd("call", scope, "d");
    const dealWhere = dealAnd ? ` WHERE ${dealAnd.slice(" AND ".length)}` : "";
    const taskAnd = ownerScopeAnd("task", scope, "t");
    // Attribution reads `leads` even here - see sourceBreakdownSql's header for
    // why - so it takes the LEAD predicate, not the deal one.
    const leadAndL = ownerScopeAnd("lead", scope, "l");

    // RLS scopes every query below to `orgId`; no explicit filter is needed
    // (matches overview()'s own convention).
    return this.db.withOrg(orgId, async (client) => {
      // ONE round trip for all eight reads, not eight.
      //
      // This is the owner's landing page, so it is the first thing every
      // customer sees, and these eight aggregates are mutually independent -
      // nothing here feeds anything else's WHERE clause; the only stitching
      // (funnel = stages x stageRows) happens in JavaScript below. Issued one
      // at a time they were still eight sequential network round trips to a
      // database in AWS Seoul while this API runs in Mumbai: ~125ms each,
      // ~1s of the dashboard's load spent purely in flight.
      //
      // Postgres will accept them as a single multi-statement simple query and
      // answer with one result per statement, in order. That protocol takes no
      // bind parameters, which is why `days` is interpolated - it is not user
      // text but an integer that `WindowQuery` has already constrained to
      // 1..365 via z.coerce.number().int().min(1).max(365), so there is no
      // string here to escape.
      //
      // Deliberately NOT a jsonb_agg rewrite, which was the other way to get
      // one round trip: that would have routed every column through JSON and
      // silently changed `last_call_at` from a JS Date into a differently
      // formatted string. Batching keeps node-postgres's ordinary type
      // parsing, so every row comes back exactly as it did before.
      const batch = (await client.query(
        [
          `SELECT id, name FROM organizations LIMIT 1`,

          `SELECT stages FROM deal_pipelines WHERE is_default = true LIMIT 1`,

          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status = 'open')::int AS open,
                  count(*) FILTER (WHERE status = 'won')::int  AS won,
                  count(*) FILTER (WHERE status = 'lost')::int AS lost,
                  count(*) FILTER (WHERE created_at > now() - make_interval(days => ${days}))::int AS created_in_window,
                  COALESCE(sum(amount) FILTER (WHERE status = 'open'), 0)::float AS pipeline_value,
                  COALESCE(sum(amount) FILTER (WHERE status = 'won'),  0)::float AS won_value
             FROM deals${dealWhere}`,

          // Identical to overview()'s call aggregate above, including the
          // derived `missed` and the deliberately overlapping `failed` - see
          // the long note there. The two must stay in step: the dashboard
          // renders one component from whichever of them answered.
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE status = 'COMPLETE')::int AS complete,
                  count(*) FILTER (WHERE direction = 'outgoing')::int AS outgoing,
                  count(*) FILTER (WHERE direction = 'incoming' AND duration_s > 0)::int AS answered,
                  count(*) FILTER (WHERE direction = 'incoming' AND duration_s <= 0)::int AS missed,
                  count(*) FILTER (WHERE status LIKE 'FAILED%')::int AS failed,
                  COALESCE(sum(duration_s), 0)::int AS total_seconds
             FROM calls
            WHERE started_at > now() - make_interval(days => ${days})${callAnd}`,

          `SELECT stage, count(*)::int AS count, COALESCE(sum(amount), 0)::float AS value
             FROM deals${dealWhere} GROUP BY stage`,

          // Same device-level call stats as overview()'s telecaller rollup, but
          // the deal aggregate joins on `telecaller_id` (a `telecallers` row -
          // what deals.telecaller_id already is, copied from the lead at
          // projection time) rather than `telecaller_device_id`, since that is
          // the identity a deal actually carries.
          `SELECT d.id, d.label, d.telecaller_name, d.status, d.last_seen_at,
                  COALESCE(c.calls, 0)         AS calls,
                  COALESCE(c.talk_seconds, 0)  AS talk_seconds,
                  c.last_call_at,
                  COALESCE(dl.deals, 0)        AS leads,
                  COALESCE(dl.won, 0)          AS won,
                  COALESCE(dl.pipeline_value, 0)::float AS pipeline_value
             FROM devices d
             LEFT JOIN (
               SELECT device_id, telecaller_id,
                      count(*)::int AS calls,
                      COALESCE(sum(duration_s), 0)::int AS talk_seconds,
                      max(started_at) AS last_call_at
                 FROM calls
                WHERE started_at > now() - make_interval(days => ${days})
                GROUP BY device_id, telecaller_id
             -- Reassignment-safe (0068) - see overview()'s identical join for why.
             ) c ON c.device_id = d.id AND c.telecaller_id IS NOT DISTINCT FROM d.telecaller_id
             LEFT JOIN (
               SELECT telecaller_id,
                      count(*)::int AS deals,
                      count(*) FILTER (WHERE status = 'won')::int AS won,
                      COALESCE(sum(amount) FILTER (WHERE status = 'open'), 0) AS pipeline_value
                 FROM deals
                WHERE created_at > now() - make_interval(days => ${days})
                GROUP BY telecaller_id
             ) dl ON dl.telecaller_id = d.telecaller_id
            WHERE (d.status <> 'wiped' OR COALESCE(c.calls, 0) > 0 OR COALESCE(dl.deals, 0) > 0)
              ${leaderboardAnd}
            ORDER BY COALESCE(dl.deals, 0) DESC, COALESCE(c.calls, 0) DESC, d.label ASC`,

          `SELECT day, sum(calls)::int AS calls, sum(leads)::int AS leads FROM (
             SELECT date_trunc('day', started_at)::date AS day, count(*)::int AS calls, 0 AS leads
               FROM calls  WHERE started_at > now() - make_interval(days => ${days})${callAnd} GROUP BY 1
             UNION ALL
             SELECT date_trunc('day', created_at)::date AS day, 0 AS calls, count(*)::int AS leads
               FROM deals  WHERE created_at > now() - make_interval(days => ${days})${dealAnd} GROUP BY 1
           ) series GROUP BY day ORDER BY day`,

          `SELECT d.id, d.name AS title, d.stage, d.status, d.amount AS value_num, d.last_activity_at,
                  t.display_name AS telecaller
             FROM deals d
             LEFT JOIN telecallers t ON t.id = d.telecaller_id
            ${dealAndD ? `WHERE ${dealAndD.slice(" AND ".length)}` : ""}
            ORDER BY d.last_activity_at DESC
            LIMIT 8`,

          // The same three the legacy overview() carries, so a tenant does not
          // lose half its dashboard the day the shadow-read flag flips.
          sourceBreakdownSql(days, leadAndL),
          campaignBreakdownSql(days, leadAndL),
          taskLoadSql(taskAnd),
        ].join(";\n"),
        // pg types a query as returning a single result; a multi-statement one
        // resolves to an array of them, one per statement, in order.
      )) as unknown as { rows: Record<string, unknown>[] }[];

      const [
        orgRes,
        pipelineRes,
        dealsRes,
        callsRes,
        stageRes,
        telecallerRes,
        byDayRes,
        recentRes,
        sourceRes,
        campaignRes,
        taskRes,
      ] = batch;

      const org = orgRes.rows[0];
      if (!org) throw new NotFoundException("organization not found");

      const pipeline = pipelineRes.rows[0] as { stages: unknown } | undefined;
      // No default pipeline yet (see crm-objects.ts's own no-op branch): the
      // KPI/telecaller/activity rows below still work off `deals` directly,
      // only the stage-shaped funnel has nothing to group by.
      const stages = pipeline ? parsePipelineStages(pipeline.stages) : [];

      const deals = dealsRes.rows[0];
      const calls = callsRes.rows[0];
      const stageRows = stageRes.rows as unknown as { stage: string; count: number; value: number }[];
      const telecallers = telecallerRes.rows;
      const byDay = byDayRes.rows;
      const recent = recentRes.rows;

      const funnel = stages.map((s) => {
        const row = stageRows.find((r) => r.stage === s.key);
        return { ...s, count: row?.count ?? 0, value: row?.value ?? 0 };
      });

      return {
        org: { id: org.id, name: org.name },
        window: { days },
        leads: deals,
        calls,
        funnel,
        stages,
        telecallers,
        byDay,
        recent,
        // Same three keys overview() returns, and the same reasoning: one
        // response shape regardless of persona or of which table the funnel
        // was read from.
        bySource: sourceRes.rows,
        byCampaign: campaignRes.rows,
        tasks: taskRes.rows[0] ?? { open: 0, overdue: 0, due_today: 0, undated: 0 },
      };
    });
  }

  /**
   * Name the person behind a handset.
   *
   * The device label is hardware ("Nokia G21 #2"); this is who is holding it,
   * and it is what the dashboard ranks. Kept here rather than on the devices
   * controller because it is the one device field an owner may edit.
   *
   * Also keeps the `telecallers` identity table (0017) in sync: a device gets
   * linked to a telecaller row the first time it is named, and that row's
   * display name is updated on every rename after. Clearing the name (empty
   * string) leaves the linkage untouched - the identity persists even if the
   * label is temporarily blanked.
   *
   * `reassign: true` is for the other case - a genuinely different person now
   * holds this handset. Without it, renaming would relabel the existing
   * telecaller's identity row in place, silently moving their whole call
   * history onto the new name (0068). `reassign` always mints a fresh
   * `telecallers` row and re-points the device, leaving the old identity and
   * its history untouched.
   */
  @Patch("telecallers/:deviceId")
  @RequireOwnerRole("owner", "manager")
  async setTelecaller(
    @OrgId() orgId: string,
    @Param("deviceId", ParseUUIDPipe) deviceId: string,
    @Body() body: unknown,
  ) {
    const parsed = TelecallerBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const name = parsed.data.name.trim() || null;
    const reassign = parsed.data.reassign;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [before],
      } = await client.query(
        `SELECT telecaller_id FROM devices WHERE id = $1`,
        [deviceId],
      );
      if (!before) throw new NotFoundException("device not found in this org");

      if (name) {
        if (before.telecaller_id && !reassign) {
          await client.query(`UPDATE telecallers SET display_name = $2 WHERE id = $1`, [
            before.telecaller_id,
            name,
          ]);
        } else {
          await client.query(
            `WITH inserted AS (
               INSERT INTO telecallers (org_id, display_name) VALUES ($1, $2) RETURNING id
             )
             UPDATE devices SET telecaller_id = (SELECT id FROM inserted) WHERE id = $3`,
            [orgId, name, deviceId],
          );
        }
      }

      const {
        rows: [device],
      } = await client.query(
        `UPDATE devices SET telecaller_name = $2 WHERE id = $1
         RETURNING id, label, telecaller_name, telecaller_id`,
        [deviceId, name],
      );
      return { device };
    });
  }
}
