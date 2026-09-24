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
import { isCalendarDate, parseLeadStages, parsePipelineStages } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OwnerScope, type OwnerRecordScope, ownerScopeAnd } from "../../common/owner-scope";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
import { AGING_BUCKETS, RESPONSE_BUCKETS, agingBucketFilters, responseBucketFilters } from "../reports/sla";
import { DbService } from "../../db/db.service";

/**
 * THE WINDOW, read once per statement (Build docs/29 §6.2, docs/30 R4).
 *
 * The dashboard's window is the last N CALENDAR days in the org's own zone,
 * today included - the same definition every list filter and the Reports
 * page use, so a number here can be reproduced by the list its link opens.
 * The rolling `now() - N days` it replaces could not be: no list filter takes
 * an instant, and its first "day" was a partial one.
 *
 * `prev` starts the window of equal length before it, for the KPI deltas.
 *
 * MATERIALIZED on purpose. org_window_start() and org_reporting_tz() each run
 * a subquery (migration 0132); a plain CTE is inlined, and the planner would
 * then call them once per ROW inside every FILTER below. Materialised, they
 * run once per statement.
 *
 * ── A CUSTOM RANGE ──────────────────────────────────────────────────────────
 *
 * The dashboard shares the date control every report has: the last N days, or
 * any From/To pair. A pair can end in the past, so every "in the window" test
 * below has an upper edge as well as a lower one: `>= w.cur AND < w.fin`.
 * `fin` is the org's midnight after `to`, or 'infinity' for "the last N days",
 * which keeps that window exactly what it was - open-ended at now.
 *
 * `from_d`/`to_d` are the window's own calendar days, for the day series and
 * the echo. `prev` is the same number of days immediately before `from`.
 *
 * The window is INTERPOLATED (the multi-statement protocol takes no bind
 * parameters), and it is only ever an integer day count or a calendar date -
 * both re-checked by assertWindow even though zod already has.
 */
type DashWindow = { kind: "relative"; days: number } | { kind: "fixed"; from: string; to: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertWindow(win: DashWindow): void {
  if (win.kind === "relative") {
    if (!Number.isInteger(win.days) || win.days < 1 || win.days > 366) throw new Error("invalid window days");
    return;
  }
  for (const d of [win.from, win.to]) {
    if (!ISO_DATE.test(d) || !isCalendarDate(d)) throw new Error("invalid window date");
  }
  if (win.from > win.to) throw new Error("window from is after to");
}

function windowCte(win: DashWindow): string {
  assertWindow(win);
  if (win.kind === "relative") {
    return `w AS MATERIALIZED (
            SELECT org_window_start(${win.days}) AS cur,
                   org_window_start(${win.days * 2}) AS prev,
                   'infinity'::timestamptz AS fin,
                   org_reporting_tz() AS tz,
                   org_reporting_today() AS today,
                   org_reporting_today() - ${win.days - 1} AS from_d,
                   org_reporting_today() AS to_d)`;
  }
  // Local midnight ON each date, converted with the offset in force on that
  // date - the same construction org_window_start() uses (see 0132's header).
  return `w AS MATERIALIZED (
            SELECT b.from_d::timestamp AT TIME ZONE b.tz AS cur,
                   (b.from_d - (b.to_d - b.from_d + 1))::timestamp AT TIME ZONE b.tz AS prev,
                   (b.to_d + 1)::timestamp AT TIME ZONE b.tz AS fin,
                   b.tz, b.today, b.from_d, b.to_d
              FROM (SELECT DATE '${win.from}' AS from_d, DATE '${win.to}' AS to_d,
                           org_reporting_tz() AS tz, org_reporting_today() AS today) b)`;
}

/** Days in the window, inclusive - the `days` the response echoes for a custom range. */
function windowDays(win: DashWindow): number {
  if (win.kind === "relative") return win.days;
  return Math.round((Date.parse(`${win.to}T00:00:00Z`) - Date.parse(`${win.from}T00:00:00Z`)) / 86_400_000) + 1;
}

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
function sourceBreakdownSql(win: DashWindow, scopeAnd: string): string {
  return `WITH ${windowCte(win)}
          SELECT COALESCE(l.source_channel, 'unknown') AS channel,
                 count(*)::int AS leads,
                 count(*) FILTER (WHERE l.status = 'won')::int AS won,
                 COALESCE(sum(l.value_num) FILTER (WHERE l.status = 'won'), 0)::float AS won_value
            FROM leads l, w
           WHERE l.created_at >= w.cur AND l.created_at < w.fin${scopeAnd}
           GROUP BY 1
           ORDER BY 2 DESC`;
}

function campaignBreakdownSql(win: DashWindow, scopeAnd: string): string {
  // INNER JOIN, not LEFT: a lead with no campaign is not an anonymous campaign,
  // it is a lead that did not come from one, and rolling those into a "(none)"
  // row at the top of a campaign table would bury every real campaign under
  // the organic traffic.
  return `WITH ${windowCte(win)}
          SELECT ms.id, ms.name,
                 count(*)::int AS leads,
                 count(*) FILTER (WHERE l.status = 'won')::int AS won,
                 COALESCE(sum(l.value_num) FILTER (WHERE l.status = 'won'), 0)::float AS won_value
            FROM leads l
            JOIN marketing_sources ms ON ms.id = l.marketing_source_id
           CROSS JOIN w
           WHERE l.created_at >= w.cur AND l.created_at < w.fin${scopeAnd}
           GROUP BY ms.id, ms.name
           ORDER BY 3 DESC
           LIMIT 8`;
}

/**
 * The headline record counts - leads on the legacy read, deals on the CRM
 * read - plus what the KPI row needs to be honest about its clock (docs/29
 * A4): closes IN the window and the previous window's figures.
 *
 * "Closed in the window" = terminal status with `stage_changed_at` inside it,
 * the predicate the Reports forecast already uses (reports.service.ts), so the
 * dashboard's "won" and the report's cannot disagree. There is no closed_at
 * column; moving into a terminal stage is what stamps stage_changed_at.
 *
 * `total/open/won/lost/won_value` stay ALL-TIME and keep their names - they
 * are the response contract other callers read. The page labels them "all
 * time" wherever it still shows them.
 */
function recordSummarySql(win: DashWindow, table: "leads" | "deals", valueCol: string, where: string): string {
  const inWin = "stage_changed_at >= w.cur AND stage_changed_at < w.fin";
  const inPrev = "stage_changed_at >= w.prev AND stage_changed_at < w.cur";
  return `WITH ${windowCte(win)}
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE status = 'open')::int AS open,
                 count(*) FILTER (WHERE status = 'won')::int  AS won,
                 count(*) FILTER (WHERE status = 'lost')::int AS lost,
                 count(*) FILTER (WHERE created_at >= w.cur AND created_at < w.fin)::int AS created_in_window,
                 COALESCE(sum(${valueCol}) FILTER (WHERE status = 'open'), 0)::float AS pipeline_value,
                 COALESCE(sum(${valueCol}) FILTER (WHERE status = 'won'),  0)::float AS won_value,
                 count(*) FILTER (WHERE status = 'won'  AND ${inWin})::int AS closed_won,
                 count(*) FILTER (WHERE status = 'lost' AND ${inWin})::int AS closed_lost,
                 COALESCE(sum(${valueCol}) FILTER (WHERE status = 'won' AND ${inWin}), 0)::float AS closed_won_value,
                 count(*) FILTER (WHERE created_at >= w.prev AND created_at < w.cur)::int AS prev_created,
                 count(*) FILTER (WHERE status = 'won'  AND ${inPrev})::int AS prev_won,
                 count(*) FILTER (WHERE status = 'lost' AND ${inPrev})::int AS prev_lost,
                 COALESCE(sum(${valueCol}) FILTER (WHERE status = 'won' AND ${inPrev}), 0)::float AS prev_won_value
            FROM ${table}, w${where}`;
}

/**
 * The call KPI row for the window AND the one before it, in one scan.
 *
 * The state split is the console's four-state alphabet (packages/ui
 * state.tsx) - see the long note on it in overview() below: outgoing +
 * answered + missed partition `total` exactly, and `failed` OVERLAPS them.
 * `callAnd` is the persona predicate on unaliased `calls` columns.
 */
function callSummarySql(win: DashWindow, callAnd: string): string {
  const cur = "started_at >= w.cur AND started_at < w.fin";
  const prev = "started_at < w.cur";
  return `WITH ${windowCte(win)}
          SELECT count(*) FILTER (WHERE ${cur})::int AS total,
                 count(*) FILTER (WHERE ${cur} AND status = 'COMPLETE')::int AS complete,
                 count(*) FILTER (WHERE ${cur} AND direction = 'outgoing')::int AS outgoing,
                 count(*) FILTER (WHERE ${cur} AND direction = 'incoming' AND duration_s > 0)::int AS answered,
                 count(*) FILTER (WHERE ${cur} AND direction = 'incoming' AND duration_s <= 0)::int AS missed,
                 count(*) FILTER (WHERE ${cur} AND status LIKE 'FAILED%')::int AS failed,
                 COALESCE(sum(duration_s) FILTER (WHERE ${cur}), 0)::int AS total_seconds,
                 count(*) FILTER (WHERE ${prev})::int AS prev_total,
                 count(*) FILTER (WHERE ${prev} AND direction = 'outgoing')::int AS prev_outgoing,
                 count(*) FILTER (WHERE ${prev} AND direction = 'incoming' AND duration_s > 0)::int AS prev_answered,
                 count(*) FILTER (WHERE ${prev} AND direction = 'incoming' AND duration_s <= 0)::int AS prev_missed
            FROM calls, w
           WHERE started_at >= w.prev${callAnd}`;
}

/**
 * One row per calendar day of the window, EVERY day - zero where nothing
 * happened (docs/29 A2: the old series skipped quiet days and the chart never
 * filled them, so its x-axis was not time). Days are the org's days (A1): a
 * call at 00:30 IST is on the day it happened on, not the day before.
 *
 * `day` leaves as TEXT: node-postgres would turn a `date` into a JS Date at the
 * server's local midnight, and JSON would then shift it a day on any host
 * east of Greenwich (see query-compiler.ts's note on the same trap).
 */
function byDaySql(win: DashWindow, table: "leads" | "deals", callAnd: string, recordAnd: string): string {
  // Anchored on the window's LAST day, not on today: a custom range can end
  // in the past, and the series must be its days.
  return `WITH ${windowCte(win)},
          series AS (SELECT (w.to_d - g)::date AS day FROM w, generate_series(0, w.to_d - w.from_d) AS g),
          c AS (
            SELECT (started_at AT TIME ZONE w.tz)::date AS day,
                   count(*)::int AS calls,
                   count(*) FILTER (WHERE direction = 'outgoing')::int AS outgoing,
                   count(*) FILTER (WHERE direction = 'incoming' AND duration_s > 0)::int AS answered,
                   count(*) FILTER (WHERE direction = 'incoming' AND duration_s <= 0)::int AS missed
              FROM calls, w
             WHERE started_at >= w.cur AND started_at < w.fin${callAnd}
             GROUP BY 1),
          r AS (
            SELECT (created_at AT TIME ZONE w.tz)::date AS day, count(*)::int AS leads
              FROM ${table}, w
             WHERE created_at >= w.cur AND created_at < w.fin${recordAnd}
             GROUP BY 1)
          SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
                 COALESCE(c.calls, 0) AS calls,
                 COALESCE(c.outgoing, 0) AS outgoing,
                 COALESCE(c.answered, 0) AS answered,
                 COALESCE(c.missed, 0) AS missed,
                 COALESCE(r.leads, 0) AS leads
            FROM series s
            LEFT JOIN c ON c.day = s.day
            LEFT JOIN r ON r.day = s.day
           ORDER BY s.day`;
}

/**
 * Inbound calls by weekday and hour, in the org's zone (docs/29 §3.4) - the
 * heatmap that turns "we miss calls" into "we miss calls on Tuesdays at 1 pm".
 * Only cells with inbound calls come back; the client lays out the grid.
 */
function callHeatSql(win: DashWindow, callAnd: string): string {
  return `WITH ${windowCte(win)}
          SELECT extract(isodow FROM started_at AT TIME ZONE w.tz)::int AS dow,
                 extract(hour FROM started_at AT TIME ZONE w.tz)::int AS hour,
                 count(*)::int AS inbound,
                 count(*) FILTER (WHERE duration_s <= 0)::int AS missed
            FROM calls, w
           WHERE started_at >= w.cur AND started_at < w.fin AND direction = 'incoming'${callAnd}
           GROUP BY 1, 2
           ORDER BY 1, 2`;
}

/**
 * Open records by stage, split by how long each has sat in that stage
 * (docs/29 §3.6) - the "stuck" reading a stage count alone hides. Same
 * bucket bounds as the aging report (AGING_BUCKETS), elapsed whole days.
 */
function stageAgingSql(table: "leads" | "deals", recordAnd: string): string {
  const age = "floor(EXTRACT(epoch FROM (now() - stage_changed_at)) / 86400.0)";
  return `SELECT stage, ${agingBucketFilters(age)}
            FROM ${table}
           WHERE status = 'open'${recordAnd}
           GROUP BY stage`;
}

/**
 * Speed to first response for leads that ARRIVED in the window, against the
 * org's own SLA (0109) - and the previous window's within-SLA count for the
 * delta (docs/29 §3.8).
 *
 * Measured exactly as the response-time report measures it (reports.service
 * responseTime): the source's clock where there is one, windowed on arrival -
 * never on the response, which would drop every lead nobody answered. The
 * buckets are sla.ts's, generated rather than restated.
 *
 * Aggregates with no GROUP BY, so an empty window still returns its one row.
 */
function responseSql(win: DashWindow, scopeAnd: string): string {
  const arrived = "COALESCE(l.source_created_at, l.created_at)";
  // The upper edge here bounds both windows at once: `prev` ends at `cur`,
  // which is before `fin`, so the current window's filters below only need
  // their lower edge.
  return `WITH ${windowCte(win)},
          r AS (
            SELECT ${arrived} AS arrived,
                   CASE WHEN l.first_responded_at IS NULL THEN NULL
                        ELSE EXTRACT(EPOCH FROM (l.first_responded_at - ${arrived})) / 60.0
                   END AS minutes
              FROM leads l, w
             WHERE ${arrived} >= w.prev AND ${arrived} < w.fin${scopeAnd})
          SELECT (SELECT COALESCE(response_sla_minutes, 60) FROM organizations LIMIT 1)::int AS sla_minutes,
                 count(*) FILTER (WHERE r.arrived >= w.cur)::int AS leads,
                 count(*) FILTER (WHERE r.arrived >= w.cur AND r.minutes IS NOT NULL)::int AS responded,
                 count(*) FILTER (WHERE r.arrived >= w.cur AND r.minutes IS NOT NULL
                                    AND r.minutes <= (SELECT COALESCE(response_sla_minutes, 60) FROM organizations LIMIT 1))::int AS within_sla,
                 (percentile_cont(0.5) WITHIN GROUP (ORDER BY r.minutes)
                    FILTER (WHERE r.arrived >= w.cur AND r.minutes IS NOT NULL))::float AS median_minutes,
                 ${responseBucketFilters("r.minutes", "r.arrived >= w.cur")},
                 count(*) FILTER (WHERE r.arrived < w.cur)::int AS prev_leads,
                 count(*) FILTER (WHERE r.arrived < w.cur AND r.minutes IS NOT NULL
                                    AND r.minutes <= (SELECT COALESCE(response_sla_minutes, 60) FROM organizations LIMIT 1))::int AS prev_within_sla
            FROM r, w`;
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
  // org_reporting_today() and not CURRENT_DATE (migration 0095). CURRENT_DATE
  // is the DATABASE's date - UTC on this deployment - so on an Indian floor a
  // follow-up that went late at midnight was not counted overdue until half
  // past five in the morning, and "due today" meant "due today in London".
  return `SELECT count(*)::int AS open,
                 count(*) FILTER (WHERE t.due_on < org_reporting_today())::int AS overdue,
                 count(*) FILTER (WHERE t.due_on = org_reporting_today())::int AS due_today,
                 count(*) FILTER (WHERE t.due_on > org_reporting_today())::int AS upcoming,
                 count(*) FILTER (WHERE t.due_on IS NULL)::int AS undated
            FROM tasks t
           WHERE t.status = 'open'${scopeAnd}`;
}

/**
 * The triage block: how old the open leads are, and how many nobody has
 * answered at all.
 *
 * ── WHY THIS IS ON THE DASHBOARD AND NOT ONLY IN A REPORT ───────────────────
 *
 * The aging report already computes these (reports.service.ts leadAging), and
 * a second query for the same numbers is normally the wrong instinct. It is
 * right here for one reason: the dashboard is the page people open, and the
 * report is the page people open when they already suspect something. A number
 * that appears only where you go to confirm a suspicion cannot create one.
 *
 * The BOUNDARIES are not duplicated. `agingBucketFilters` generates this SQL
 * from the same frozen array the report and its tests use, so a tile and the
 * report it links to can never draw the line in different places.
 *
 * ── NOT WINDOWED BY `days` ──────────────────────────────────────────────────
 *
 * Same reasoning as taskLoadSql, and it matters more here: the entire point of
 * an aging bucket is the leads that fell out of the reporting window months
 * ago and are still open. Applying `days` would empty the 30+ bucket, which is
 * the one that is always largest and always the problem.
 */
/**
 * The window the numbers were counted over, echoed from the database that
 * counted them - so the page prints "24 Aug – 22 Sep" from the same
 * org_reporting_today() the SQL used, never from the web tier's own clock
 * (the Reports rule: every link is built from what the report ECHOED).
 */
const WINDOW_ECHO_SQL = (win: DashWindow) => {
  assertWindow(win);
  return win.kind === "relative"
    ? `to_char(org_reporting_today() - ${win.days - 1}, 'YYYY-MM-DD') AS window_from,
       to_char(org_reporting_today(), 'YYYY-MM-DD') AS window_to,
       org_reporting_tz() AS window_timezone`
    : `'${win.from}'::text AS window_from,
       '${win.to}'::text AS window_to,
       org_reporting_tz() AS window_timezone`;
};

const n = (value: unknown): number => Number(value ?? 0);

/**
 * The KPI half of the response, from recordSummarySql + callSummarySql.
 * `leads`/`calls` keep EXACTLY their old keys (the response contract);
 * what the redesign added arrives beside them as `closed` and `previous`
 * rather than as new keys mixed into objects other callers already read.
 */
function shapeWindowed(
  org: Record<string, unknown>,
  win: DashWindow,
  rec: Record<string, unknown> = {},
  call: Record<string, unknown> = {},
) {
  return {
    // `days` is the window's length either way; `custom` says whether it was
    // a From/To pair rather than "the last N days", which the page words
    // differently ("vs the 7 days before" rather than "vs previous 7 days").
    window: {
      days: windowDays(win),
      custom: win.kind === "fixed",
      from: org.window_from,
      to: org.window_to,
      timezone: org.window_timezone,
    },
    leads: {
      total: n(rec.total),
      open: n(rec.open),
      won: n(rec.won),
      lost: n(rec.lost),
      created_in_window: n(rec.created_in_window),
      pipeline_value: n(rec.pipeline_value),
      won_value: n(rec.won_value),
    },
    calls: {
      total: n(call.total),
      complete: n(call.complete),
      outgoing: n(call.outgoing),
      answered: n(call.answered),
      missed: n(call.missed),
      failed: n(call.failed),
      total_seconds: n(call.total_seconds),
    },
    closed: { won: n(rec.closed_won), lost: n(rec.closed_lost), won_value: n(rec.closed_won_value) },
    previous: {
      calls: n(call.prev_total),
      outgoing: n(call.prev_outgoing),
      answered: n(call.prev_answered),
      missed: n(call.prev_missed),
      leads_created: n(rec.prev_created),
      won: n(rec.prev_won),
      lost: n(rec.prev_lost),
      won_value: n(rec.prev_won_value),
    },
  };
}

function shapeResponse(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    sla_minutes: n(row.sla_minutes),
    leads: n(row.leads),
    responded: n(row.responded),
    within_sla: n(row.within_sla),
    median_minutes: row.median_minutes === null || row.median_minutes === undefined ? null : Number(row.median_minutes),
    // Self-describing, so the console draws the bars from THESE bounds and
    // labels rather than a second copy of sla.ts that could drift from it.
    // JSON has no Infinity: an open-ended bucket says max_minutes null.
    buckets: RESPONSE_BUCKETS.map((b, i) => ({
      key: b.key,
      label: b.label,
      min_minutes: i === 0 || b.maxMinutes === null ? null : RESPONSE_BUCKETS[i - 1]!.maxMinutes,
      max_minutes: b.maxMinutes === null || !Number.isFinite(b.maxMinutes) ? null : b.maxMinutes,
      never: b.maxMinutes === null,
      count: n(row[b.key]),
    })),
    prev_leads: n(row.prev_leads),
    prev_within_sla: n(row.prev_within_sla),
  };
}

function leadTriageSql(scopeAnd: string): string {
  // Whole days, floored, so this agrees with agingBucket()'s Math.floor - a
  // lead that is 3.9 days old is in the 0-3 bucket on both sides.
  // COALESCE(source_created_at, created_at) (0100), matching the aging report
  // exactly. The dashboard tile links INTO that report, and two numbers that
  // disagreed because one measured the import clock would be worse than
  // either being absent.
  const ageDays =
    "floor(EXTRACT(epoch FROM (now() - COALESCE(l.source_created_at, l.created_at))) / 86400.0)";
  // The second set splits every bucket by "nobody has ever answered it" -
  // the dashboard's emphasis (docs/29 §3.7). Same bounds, same age.
  return `SELECT count(*)::int AS open_total,
                 count(*) FILTER (WHERE l.first_responded_at IS NULL)::int AS never_responded,
                 ${agingBucketFilters(ageDays)},
                 ${agingBucketFilters(ageDays, { where: "l.first_responded_at IS NULL", prefix: "never_" })}
            FROM leads l
           WHERE l.status = 'open'${scopeAnd}`;
}

const CalendarDate = z.string().refine(isCalendarDate, "dates are YYYY-MM-DD calendar dates");

const WindowQuery = z
  .object({
    /** Reporting window. 30 days matches the usage page's default period. */
    days: z.coerce.number().int().min(1).max(365).default(30),
    /** A custom range instead - both or neither, in the org's calendar. Wins over `days`. */
    from: CalendarDate.optional(),
    to: CalendarDate.optional(),
  })
  .superRefine((q, ctx) => {
    if ((q.from === undefined) !== (q.to === undefined)) {
      ctx.addIssue({ code: "custom", message: "from and to go together" });
      return;
    }
    if (q.from && q.to) {
      if (q.from > q.to) ctx.addIssue({ code: "custom", message: "from must not be after to" });
      else if (windowDays({ kind: "fixed", from: q.from, to: q.to }) > 366) {
        ctx.addIssue({ code: "custom", message: "a range covers at most 366 days" });
      }
    }
  });

/** The parsed query as the window the SQL counts over. */
function dashWindow(q: z.infer<typeof WindowQuery>): DashWindow {
  return q.from && q.to ? { kind: "fixed", from: q.from, to: q.to } : { kind: "relative", days: q.days };
}

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
    const win = dashWindow(parsed.data);

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
      // The window is interpolated because the multi-statement protocol takes
      // no bind parameters; `WindowQuery` has already pinned it to an integer
      // day count or two calendar dates, and assertWindow checks again.
      const batch = (await client.query(
        [
          `SELECT id, name, lead_stages, ${WINDOW_ECHO_SQL(win)} FROM organizations LIMIT 1`,

          recordSummarySql(win,"leads", "value_num", leadWhere),

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
          callSummarySql(win,callAnd),

          // Board shape: every stage, including the empty ones, so the funnel
          // does not silently change width as leads move. The Main board's
          // leads only (0136): the funnel's columns are the Main board's, and a
          // copied board shares its keys, so its cards would otherwise be
          // counted in columns they are not in.
          `SELECT stage, count(*)::int AS count, COALESCE(sum(value_num), 0)::float AS value
             FROM leads WHERE board_id IS NULL${leadAnd} GROUP BY stage`,

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
           *
           * `missed` per person (docs/29 G7): a manager needs WHO is missing
           * calls, not only how many the floor missed.
           */
          `WITH ${windowCte(win)}
           SELECT d.id, d.label, d.telecaller_name, d.status, d.last_seen_at,
                  COALESCE(c.calls, 0)         AS calls,
                  COALESCE(c.missed, 0)        AS missed,
                  COALESCE(c.talk_seconds, 0)  AS talk_seconds,
                  c.last_call_at,
                  COALESCE(l.leads, 0)         AS leads,
                  COALESCE(l.won, 0)           AS won,
                  COALESCE(l.pipeline_value, 0)::float AS pipeline_value
             FROM devices d
             LEFT JOIN (
               SELECT device_id, telecaller_id,
                      count(*)::int AS calls,
                      count(*) FILTER (WHERE direction = 'incoming' AND duration_s <= 0)::int AS missed,
                      COALESCE(sum(duration_s), 0)::int AS talk_seconds,
                      max(started_at) AS last_call_at
                 FROM calls
                WHERE started_at >= (SELECT cur FROM w) AND started_at < (SELECT fin FROM w)
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
                WHERE created_at >= (SELECT cur FROM w) AND created_at < (SELECT fin FROM w)
                GROUP BY telecaller_device_id
             ) l ON l.telecaller_device_id = d.id
            -- Same amnesty as the wiped exclusion: a removed handset (0087)
            -- only disappears from the leaderboard once it has nothing in
            -- this window either, so its historical rows in the totals above
            -- still reconcile against a name shown somewhere on the page.
            WHERE (d.status <> 'wiped' OR COALESCE(c.calls, 0) > 0 OR COALESCE(l.leads, 0) > 0)
              AND (d.removed_at IS NULL OR COALESCE(c.calls, 0) > 0 OR COALESCE(l.leads, 0) > 0)
              ${leaderboardAnd}
            ORDER BY COALESCE(l.leads, 0) DESC, COALESCE(c.calls, 0) DESC, d.label ASC`,

          // Every calendar day of the window, in the org's zone, with the call
          // states split out - see byDaySql.
          byDaySql(win,"leads", callAnd, leadAnd),

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
          sourceBreakdownSql(win,leadAndL),
          campaignBreakdownSql(win,leadAndL),
          taskLoadSql(taskAnd),
          // Rides in the same batch as everything else, so making the
          // dashboard a triage surface costs zero extra round trips - which
          // is the entire reason this query is one multi-statement flight.
          leadTriageSql(leadAndL),
          // The redesign's three (Build docs/29 §6), same flight again.
          callHeatSql(win,callAnd),
          // Main board only, for the funnel's reason above (0136).
          stageAgingSql("leads", ` AND board_id IS NULL${leadAnd}`),
          responseSql(win,leadAndL),
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
        triageRes,
        heatRes,
        agingRes,
        responseRes,
      ] = batch;

      const org = orgRes.rows[0];
      if (!org) throw new NotFoundException("organization not found");

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
        ...shapeWindowed(org, win, leadsRes.rows[0], callsRes.rows[0]),
        funnel,
        stages,
        telecallers,
        byDay,
        recent,
        callHeat: heatRes.rows,
        stageAging: agingRes.rows,
        agingBuckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
        response: shapeResponse(responseRes.rows[0]),
        // Present for every persona even though only some dashboards render
        // them. A response whose SHAPE depends on who is asking is a response
        // the client has to branch on twice - once for the persona and once
        // for whether the key exists - and the second branch is the one that
        // gets forgotten.
        bySource: sourceRes.rows,
        byCampaign: campaignRes.rows,
        tasks: taskRes.rows[0] ?? {
          open: 0,
          overdue: 0,
          due_today: 0,
          upcoming: 0,
          undated: 0,
        },
        // Nullable rather than zero-filled: "no open leads" and "the query did
        // not run" must not render as the same clean dashboard.
        triage: triageRes.rows[0] ?? null,
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
    const win = dashWindow(parsed.data);

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
      // bind parameters, which is why the window is interpolated - it is not
      // user text but an integer day count or a pair of calendar dates that
      // `WindowQuery` has already validated and windowCte's assertWindow
      // checks again, so there is no string here to escape.
      //
      // Deliberately NOT a jsonb_agg rewrite, which was the other way to get
      // one round trip: that would have routed every column through JSON and
      // silently changed `last_call_at` from a JS Date into a differently
      // formatted string. Batching keeps node-postgres's ordinary type
      // parsing, so every row comes back exactly as it did before.
      const batch = (await client.query(
        [
          `SELECT id, name, ${WINDOW_ECHO_SQL(win)} FROM organizations LIMIT 1`,

          `SELECT stages FROM deal_pipelines WHERE is_default = true LIMIT 1`,

          recordSummarySql(win,"deals", "amount", dealWhere),

          // Identical to overview()'s call aggregate above, including the
          // derived `missed` and the deliberately overlapping `failed` - see
          // the long note there. The two must stay in step: the dashboard
          // renders one component from whichever of them answered.
          callSummarySql(win,callAnd),

          `SELECT stage, count(*)::int AS count, COALESCE(sum(amount), 0)::float AS value
             FROM deals${dealWhere} GROUP BY stage`,

          // Same device-level call stats as overview()'s telecaller rollup, but
          // the deal aggregate joins on `telecaller_id` (a `telecallers` row -
          // what deals.telecaller_id already is, copied from the lead at
          // projection time) rather than `telecaller_device_id`, since that is
          // the identity a deal actually carries.
          `WITH ${windowCte(win)}
           SELECT d.id, d.label, d.telecaller_name, d.status, d.last_seen_at,
                  COALESCE(c.calls, 0)         AS calls,
                  COALESCE(c.missed, 0)        AS missed,
                  COALESCE(c.talk_seconds, 0)  AS talk_seconds,
                  c.last_call_at,
                  COALESCE(dl.deals, 0)        AS leads,
                  COALESCE(dl.won, 0)          AS won,
                  COALESCE(dl.pipeline_value, 0)::float AS pipeline_value
             FROM devices d
             LEFT JOIN (
               SELECT device_id, telecaller_id,
                      count(*)::int AS calls,
                      count(*) FILTER (WHERE direction = 'incoming' AND duration_s <= 0)::int AS missed,
                      COALESCE(sum(duration_s), 0)::int AS talk_seconds,
                      max(started_at) AS last_call_at
                 FROM calls
                WHERE started_at >= (SELECT cur FROM w) AND started_at < (SELECT fin FROM w)
                GROUP BY device_id, telecaller_id
             -- Reassignment-safe (0068) - see overview()'s identical join for why.
             ) c ON c.device_id = d.id AND c.telecaller_id IS NOT DISTINCT FROM d.telecaller_id
             LEFT JOIN (
               SELECT telecaller_id,
                      count(*)::int AS deals,
                      count(*) FILTER (WHERE status = 'won')::int AS won,
                      COALESCE(sum(amount) FILTER (WHERE status = 'open'), 0) AS pipeline_value
                 FROM deals
                WHERE created_at >= (SELECT cur FROM w) AND created_at < (SELECT fin FROM w)
                GROUP BY telecaller_id
             ) dl ON dl.telecaller_id = d.telecaller_id
            -- Same amnesty as the wiped exclusion, and for the same reason
            -- as overview()'s identical clause above.
            WHERE (d.status <> 'wiped' OR COALESCE(c.calls, 0) > 0 OR COALESCE(dl.deals, 0) > 0)
              AND (d.removed_at IS NULL OR COALESCE(c.calls, 0) > 0 OR COALESCE(dl.deals, 0) > 0)
              ${leaderboardAnd}
            ORDER BY COALESCE(dl.deals, 0) DESC, COALESCE(c.calls, 0) DESC, d.label ASC`,

          byDaySql(win,"deals", callAnd, dealAnd),

          `SELECT d.id, d.name AS title, d.stage, d.status, d.amount AS value_num, d.last_activity_at,
                  t.display_name AS telecaller
             FROM deals d
             LEFT JOIN telecallers t ON t.id = d.telecaller_id
            ${dealAndD ? `WHERE ${dealAndD.slice(" AND ".length)}` : ""}
            ORDER BY d.last_activity_at DESC
            LIMIT 8`,

          // The same three the legacy overview() carries, so a tenant does not
          // lose half its dashboard the day the shadow-read flag flips.
          sourceBreakdownSql(win,leadAndL),
          campaignBreakdownSql(win,leadAndL),
          taskLoadSql(taskAnd),
          // The redesign's heatmap and stage aging (docs/29 §6). Response
          // speed and triage stay null here - see the note on `triage` below.
          callHeatSql(win,callAnd),
          stageAgingSql("deals", dealAnd),
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
        heatRes,
        agingRes,
      ] = batch;

      const org = orgRes.rows[0];
      if (!org) throw new NotFoundException("organization not found");

      const pipeline = pipelineRes.rows[0] as { stages: unknown } | undefined;
      // No default pipeline yet (see crm-objects.ts's own no-op branch): the
      // KPI/telecaller/activity rows below still work off `deals` directly,
      // only the stage-shaped funnel has nothing to group by.
      const stages = pipeline ? parsePipelineStages(pipeline.stages) : [];

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
        // `leads` holds DEALS here - the shared shape this endpoint exists to keep.
        ...shapeWindowed(org, win, dealsRes.rows[0], callsRes.rows[0]),
        funnel,
        stages,
        telecallers,
        byDay,
        recent,
        callHeat: heatRes.rows,
        stageAging: agingRes.rows,
        agingBuckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
        // Deals carry no first_responded_at; see `triage` below.
        response: null,
        // Same three keys overview() returns, and the same reasoning: one
        // response shape regardless of persona or of which table the funnel
        // was read from.
        bySource: sourceRes.rows,
        byCampaign: campaignRes.rows,
        tasks: taskRes.rows[0] ?? {
          open: 0,
          overdue: 0,
          due_today: 0,
          upcoming: 0,
          undated: 0,
        },
        // Explicitly absent, not omitted. The CRM read is over deals and
        // contacts, which carry no first_responded_at - so "how long has this
        // been sitting unanswered" has no honest answer here. Returning the
        // key as null keeps the response shape identical to overview()'s,
        // which is the contract this endpoint exists to hold; computing an
        // approximation from deal.created_at would put a number on the page
        // that means something different from the one beside it.
        triage: null,
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
