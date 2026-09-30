import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import {
  DEFAULT_STAGE_SLA_DAYS,
  activityHref,
  parseLeadStages,
  type ActivityEvent,
  type ActivityKind,
  type LeaderboardRow,
  type WorkloadRow,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard } from "../../common/owner-role.guard";
import { OwnerScope, type OwnerRecordScope, ownerScopeClause } from "../../common/owner-scope";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Team activity - the feed, the workload matrix and the leaderboard behind
 * `/owner/productivity`.
 *
 * ── WHY IT IS ITS OWN CONTROLLER ────────────────────────────────────────────
 *
 * It serves the same page and the same feature gate as
 * `telecaller-productivity.controller.ts`, and it is a separate file because the
 * two answer questions of different SHAPES. That one reads one rollup
 * (`telecaller_daily_stats`) and produces per-person aggregates of calls; this
 * one reads five tables across two ledgers and produces a chronology. Merged,
 * the file would have been 1,400 lines of SQL where nothing was near anything it
 * related to, and the only thing the halves share is the guard stack - which is
 * declared identically below rather than inherited, because a guard stack a
 * reader has to go and find in another file is how a route ends up unscoped.
 *
 * ── THE PERSONA RULE, WHICH IS LOAD-BEARING HERE ────────────────────────────
 *
 * No `@RequireOwnerRole`: a rep is entitled to see the floor's activity, and on
 * most floors that visibility is the point of the page. What a rep must NOT see
 * is records outside their own book, so every one of the ten reads below
 * carries `ownerScopeClause` for the object it touches - leads on the telecaller
 * identity, tasks on the user, and the roster narrowed by hand (see
 * `rosterClause`, which has no shared helper because no other query narrows a
 * list of PEOPLE rather than a list of their records).
 *
 * The failure mode is silent: a missing clause returns more rows than the reader
 * may see and renders perfectly. The scope is therefore threaded through every
 * CTE explicitly and `team-activity.spec.ts` asserts that each one carries it.
 *
 * ── AND WHY THE FEED IS NOT `audit_log` ─────────────────────────────────────
 *
 * Set out at length in @aura/shared's `team-activity.ts`: `audit_log.action` is
 * an open vocabulary of dotted strings, its actor and target are `text` with no
 * join to a name, and it records that something was updated rather than what it
 * was changed from and to. The typed ledgers carry all three, which is what lets
 * a row phrase itself.
 */

const ActivityQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
});

/**
 * How many events come back.
 *
 * Two hundred, and it is a deliberate cap rather than a page size: this is a
 * feed somebody SCANS, not a list they work through, and nobody reads the 300th
 * line of one. Each ledger is limited to the same number before the union so a
 * chatty month of lead moves cannot crowd task completions out of the merged
 * result - without those inner limits, a floor that moves a thousand cards a
 * week would have a feed with no tasks in it at all and no way to tell.
 *
 * The response reports whether it hit the cap, so the page can say the range
 * holds more rather than implying the feed is everything that happened.
 */
const FEED_LIMIT = 200;

/**
 * The roster narrowing, by hand.
 *
 * `ownerScopeClause` narrows a table of RECORDS by the telecaller who holds
 * them; this narrows the list of telecallers itself, which no shared helper
 * covers because nothing else needs it. Written here rather than added to the
 * shared module so that module keeps exactly one concept in it.
 *
 * The sentinel matters: an own-scoped persona with no telecaller identity gets a
 * predicate that matches NOTHING, never one that matches everything. That is the
 * same direction `ownerScopeFilter` fails in, and for the same reason - an empty
 * list beats everyone's list.
 */
function rosterClause(scope: OwnerRecordScope, paramIndex: number, alias: string): string | null {
  if (scope.scope !== "own") return null;
  return `${alias}.id = $${paramIndex}`;
}

/** The value `rosterClause` and the scope clauses bind - never caller text. */
const MATCHES_NOTHING = "00000000-0000-0000-0000-000000000000";

interface FeedRow {
  id: string;
  kind: ActivityKind;
  at: string;
  actor: string | null;
  actor_label: string | null;
  changed_by: string | null;
  source: string | null;
  subject: string | null;
  detail_key: string | null;
}

interface ActivityRow {
  feed: FeedRow[] | null;
  workload:
    | Array<{
        telecaller_id: string;
        display_name: string;
        user_id: string | null;
        open_leads: number;
        stalled: number;
        unanswered: number;
        open_tasks: number | null;
        overdue_tasks: number | null;
        calls: number;
        active_days: number;
      }>
    | null;
  board:
    | Array<{
        telecaller_id: string;
        display_name: string;
        user_id: string | null;
        won: number;
        won_value: number;
        leads: number;
        calls: number;
        connected: number;
        tasks_done: number | null;
      }>
    | null;
  lead_stages: unknown;
}

/**
 * Which actors are machines.
 *
 * `device` is NOT one, and that is migration 0075's rule rather than a judgement
 * made here: "a telecaller on a phone is a human, and treating their move as
 * machine output would invert the human-outranks-the-machine rule". Filing handset
 * moves as automation would empty the feed on exactly the floors that live on
 * their phones.
 */
const MACHINE_SOURCES = new Set(["automation", "pipeline", "reshape", "backfill"]);

/**
 * The statement, built. Exported and pure so the scope threading is testable
 * without a database.
 *
 * ── WHY IT IS A FUNCTION AND NOT A CONSTANT ─────────────────────────────────
 *
 * Every other read in this module graph interpolates its persona clause into a
 * template at call time, and the failure mode of that pattern is silent: a CTE
 * added without its clause returns more rows than the reader may see and renders
 * perfectly. With ten reads each needing one, "look carefully" is not a control.
 *
 * So the clauses are pushed by the five helpers below, IN THE ORDER THE CTEs
 * APPEAR, which means the bind indexes assign themselves and nobody counts
 * placeholders by hand. And because the whole thing is one pure function,
 * team-activity.spec.ts can assert that an own-scoped persona gets a predicate on
 * every one of the ten - which is the assertion that actually holds the
 * invariant, rather than a comment asking the next reader to be careful.
 */
export function buildActivitySql(
  from: string,
  to: string,
  scope: OwnerRecordScope,
): { sql: string; params: unknown[] } {
  // $1 from, $2 to, $3 the stage threshold, then one parameter per scope clause
  // that fires. No identity ever reaches the statement as text.
  const params: unknown[] = [from, to, DEFAULT_STAGE_SLA_DAYS];
  const telecallerId = scope.telecallerId ?? MATCHES_NOTHING;
  const userId = scope.userId ?? MATCHES_NOTHING;

  const leadScope = (alias: string) => {
    const clause = ownerScopeClause("lead", scope, params.length + 1, alias);
    if (!clause) return "";
    params.push(telecallerId);
    return ` AND ${clause}`;
  };
  const dealScope = (alias: string) => {
    const clause = ownerScopeClause("deal", scope, params.length + 1, alias);
    if (!clause) return "";
    params.push(telecallerId);
    return ` AND ${clause}`;
  };
  const taskScope = (alias: string) => {
    const clause = ownerScopeClause("task", scope, params.length + 1, alias);
    if (!clause) return "";
    params.push(userId);
    return ` AND ${clause}`;
  };
  const statsScope = (alias: string) => {
    const clause = ownerScopeClause("telecaller_stats", scope, params.length + 1, alias);
    if (!clause) return "";
    params.push(telecallerId);
    return ` AND ${clause}`;
  };
  const roster = (alias: string) => {
    const clause = rosterClause(scope, params.length + 1, alias);
    if (!clause) return "";
    params.push(telecallerId);
    return ` AND ${clause}`;
  };

  // Built as a template so each clause lands next to the rows it narrows. The
  // order of interpolation IS the order the parameters are pushed in.
  const sql = `
WITH org AS (
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

-- ── The feed: three ledgers, each capped before the union ──────────────────
lead_moves AS (
  SELECT 'lead:' || t.id::text AS id,
         CASE WHEN t.to_status = 'won'  THEN 'lead_won'
              WHEN t.to_status = 'lost' THEN 'lead_lost'
              ELSE 'lead_stage' END     AS kind,
         t.occurred_at                  AS at,
         u.name                         AS actor,
         t.actor_label                  AS actor_label,
         t.changed_by::text             AS changed_by,
         t.source                       AS source,
         l.title                        AS subject,
         t.to_stage                     AS detail_key
    FROM lead_stage_transitions t
    JOIN leads l ON l.id = t.lead_id
    LEFT JOIN users u ON u.id = t.changed_by
   CROSS JOIN w
   WHERE t.occurred_at >= w.from_at
     AND t.occurred_at <  w.to_at${leadScope("l")}
   ORDER BY t.occurred_at DESC
   LIMIT ${FEED_LIMIT}
),
deal_moves AS (
  SELECT 'deal:' || t.id::text AS id,
         CASE WHEN t.to_status = 'won'  THEN 'deal_won'
              WHEN t.to_status = 'lost' THEN 'deal_lost'
              ELSE 'deal_stage' END     AS kind,
         t.occurred_at                  AS at,
         u.name                         AS actor,
         t.actor_label                  AS actor_label,
         t.changed_by::text             AS changed_by,
         t.source                       AS source,
         d.name                         AS subject,
         t.to_stage                     AS detail_key
    FROM deal_stage_transitions t
    JOIN deals d ON d.id = t.deal_id
    LEFT JOIN users u ON u.id = t.changed_by
   CROSS JOIN w
   WHERE t.occurred_at >= w.from_at
     AND t.occurred_at <  w.to_at${dealScope("d")}
   ORDER BY t.occurred_at DESC
   LIMIT ${FEED_LIMIT}
),
-- Completions only. An OPENED task is not activity anybody needs in a feed -
-- creating work is not doing it - and including them would double every line.
task_dones AS (
  SELECT 'task:' || t.id::text AS id,
         'task_done'            AS kind,
         t.completed_at         AS at,
         u.name                 AS actor,
         NULL::text             AS actor_label,
         t.assignee_user_id::text AS changed_by,
         'console'              AS source,
         t.title                AS subject,
         NULL::text             AS detail_key
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_user_id
   CROSS JOIN w
   WHERE t.status = 'done'
     AND t.completed_at IS NOT NULL
     AND t.completed_at >= w.from_at
     AND t.completed_at <  w.to_at${taskScope("t")}
   ORDER BY t.completed_at DESC
   LIMIT ${FEED_LIMIT}
),
feed AS (
  SELECT * FROM lead_moves
  UNION ALL SELECT * FROM deal_moves
  UNION ALL SELECT * FROM task_dones
),
feed_rows AS (
  SELECT coalesce(json_agg(f ORDER BY f.at DESC), '[]'::json) AS rows
    FROM (SELECT * FROM feed ORDER BY at DESC LIMIT ${FEED_LIMIT}) f
),

-- ── The workload matrix: a snapshot of NOW, not of the range ───────────────
--
-- "Who is overloaded" is present tense. Narrowed to the range it would answer
-- "who was GIVEN work in the range", which on the 3rd of July would send a
-- manager to reassign away from somebody who has already cleared their board.
-- Only \`calls\` below is windowed, and the page labels it.
--
-- Grouped on COALESCE(assigned, attributed) - \`leadHeldBy\` as a grouping key,
-- so the matrix and a rep's own scorecard count the same leads as theirs.
open_leads AS (
  SELECT COALESCE(l.assigned_telecaller_id, l.telecaller_id) AS telecaller_id,
         count(*)::int AS open_leads,
         count(*) FILTER (
           WHERE l.stage_changed_at <= now() - make_interval(days => $3::int)
         )::int AS stalled,
         count(*) FILTER (
           WHERE l.first_responded_at IS NULL
             AND l.created_at <= now() - make_interval(mins => org.response_sla_minutes)
         )::int AS unanswered
    FROM leads l
   CROSS JOIN org
   WHERE l.status = 'open'
     AND COALESCE(l.assigned_telecaller_id, l.telecaller_id) IS NOT NULL${leadScope("l")}
   GROUP BY 1
),
-- Open tasks per PERSON, keyed on the user - the other half of the matrix, and
-- the half that only exists for a telecaller the tenant has linked to a login.
open_tasks AS (
  SELECT t.assignee_user_id AS user_id,
         count(*)::int AS open_tasks,
         count(*) FILTER (
           WHERE t.due_on IS NOT NULL AND t.due_on < (now() AT TIME ZONE org.zone)::date
         )::int AS overdue_tasks
    FROM tasks t
   CROSS JOIN org
   WHERE t.status = 'open'
     AND t.assignee_user_id IS NOT NULL${taskScope("t")}
   GROUP BY 1
),
calls_in_range AS (
  SELECT s.telecaller_id,
         sum(s.calls_total)::int     AS calls,
         sum(s.calls_connected)::int AS connected,
         count(*)::int               AS active_days
    FROM telecaller_daily_stats s
   WHERE s.day >= $1::date
     AND s.day <= $2::date${statsScope("s")}
   GROUP BY 1
),
-- Active people only. An archived telecaller has no capacity to balance work
-- against, and leaving them on the matrix drags the floor's median down and
-- makes everybody still working look overloaded.
roster AS (
  SELECT tc.id, tc.display_name, tc.user_id
    FROM telecallers tc
   WHERE tc.status = 'active'${roster("tc")}
),
workload_rows AS (
  SELECT coalesce(json_agg(r ORDER BY r.display_name), '[]'::json) AS rows
    FROM (
      SELECT rr.id                            AS telecaller_id,
             rr.display_name,
             rr.user_id::text                 AS user_id,
             COALESCE(ol.open_leads, 0)::int  AS open_leads,
             COALESCE(ol.stalled, 0)::int     AS stalled,
             COALESCE(ol.unanswered, 0)::int  AS unanswered,
             -- NULL, not 0, for somebody with no login: their tasks are
             -- unknowable from here and a zero would read as "nothing to do".
             CASE WHEN rr.user_id IS NULL THEN NULL
                  ELSE COALESCE(ot.open_tasks, 0) END::int    AS open_tasks,
             CASE WHEN rr.user_id IS NULL THEN NULL
                  ELSE COALESCE(ot.overdue_tasks, 0) END::int AS overdue_tasks,
             COALESCE(ci.calls, 0)::int       AS calls,
             COALESCE(ci.active_days, 0)::int AS active_days
        FROM roster rr
        LEFT JOIN open_leads ol    ON ol.telecaller_id = rr.id
        LEFT JOIN open_tasks ot    ON ot.user_id = rr.user_id
        LEFT JOIN calls_in_range ci ON ci.telecaller_id = rr.id
    ) r
),

-- ── The leaderboard: output IN the range ───────────────────────────────────
wins_in_range AS (
  SELECT COALESCE(l.assigned_telecaller_id, l.telecaller_id) AS telecaller_id,
         count(*)::int                        AS won,
         COALESCE(sum(l.value_num), 0)::float AS won_value
    FROM leads l
   CROSS JOIN w
   WHERE l.status = 'won'
     AND l.stage_changed_at >= w.from_at
     AND l.stage_changed_at <  w.to_at
     AND COALESCE(l.assigned_telecaller_id, l.telecaller_id) IS NOT NULL${leadScope("l")}
   GROUP BY 1
),
leads_in_range AS (
  SELECT COALESCE(l.assigned_telecaller_id, l.telecaller_id) AS telecaller_id,
         count(*)::int AS leads
    FROM leads l
   CROSS JOIN w
   WHERE l.created_at >= w.from_at
     AND l.created_at <  w.to_at
     AND COALESCE(l.assigned_telecaller_id, l.telecaller_id) IS NOT NULL${leadScope("l")}
   GROUP BY 1
),
tasks_in_range AS (
  SELECT t.assignee_user_id AS user_id, count(*)::int AS tasks_done
    FROM tasks t
   CROSS JOIN w
   WHERE t.status = 'done'
     AND t.completed_at >= w.from_at
     AND t.completed_at <  w.to_at
     AND t.assignee_user_id IS NOT NULL${taskScope("t")}
   GROUP BY 1
),
board_rows AS (
  SELECT coalesce(json_agg(b ORDER BY b.display_name), '[]'::json) AS rows
    FROM (
      SELECT rr.id                              AS telecaller_id,
             rr.display_name,
             rr.user_id::text                   AS user_id,
             COALESCE(wr.won, 0)::int            AS won,
             COALESCE(wr.won_value, 0)::float    AS won_value,
             COALESCE(lr.leads, 0)::int          AS leads,
             COALESCE(ci.calls, 0)::int          AS calls,
             COALESCE(ci.connected, 0)::int      AS connected,
             CASE WHEN rr.user_id IS NULL THEN NULL
                  ELSE COALESCE(tr.tasks_done, 0) END::int AS tasks_done
        FROM roster rr
        LEFT JOIN wins_in_range wr  ON wr.telecaller_id = rr.id
        LEFT JOIN leads_in_range lr ON lr.telecaller_id = rr.id
        LEFT JOIN calls_in_range ci ON ci.telecaller_id = rr.id
        LEFT JOIN tasks_in_range tr ON tr.user_id = rr.user_id
    ) b
)
SELECT feed_rows.rows     AS feed,
       workload_rows.rows AS workload,
       board_rows.rows    AS board,
       (SELECT org.lead_stages FROM org) AS lead_stages
  FROM feed_rows
  CROSS JOIN workload_rows
  CROSS JOIN board_rows`;
  return { sql, params };
}


@Controller("owner/team-activity")
// The same four guards in the same order as its sibling, declared rather than
// inherited - see the class header.
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OwnerScopeGuard, OrgFeatureGuard)
@RequireFeature("productivity")
export class TeamActivityController {
  constructor(private readonly db: DbService) {}

  @Get()
  async activity(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const parsed = ActivityQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to } = parsed.data;
    if (from > to) throw new BadRequestException("from must not be after to");

    return this.db.withOrg(orgId, async (client) => {
      const { sql, params } = buildActivitySql(from, to, scope);
      const { rows } = await client.query<ActivityRow>(sql, params);
      const row = rows[0];
      const stages = parseLeadStages(row?.lead_stages);
      const label = (key: string | null) =>
        key ? (stages.find((s) => s.key === key)?.label ?? key) : null;

      const feed: ActivityEvent[] = (row?.feed ?? []).map((f) => {
        const subject = f.subject?.trim() || "an untitled record";
        const machine = MACHINE_SOURCES.has(f.source ?? "");
        return {
          id: f.id,
          kind: f.kind,
          at: f.at,
          // The user's name where a user did it, the ledger's own actor label
          // otherwise ("Automation: Meta intake"). Never the uuid.
          actor: f.actor ?? f.actor_label ?? null,
          actorKind: f.changed_by ? "user" : machine ? "machine" : "unknown",
          subject,
          href: activityHref(f.kind, subject),
          // The tenant's label for the stage, so the feed speaks the board's
          // vocabulary - "closed as Enrolled", not "closed as won".
          detail: label(f.detail_key),
        };
      });

      const workload: WorkloadRow[] = (row?.workload ?? []).map((r) => ({
        telecallerId: r.telecaller_id,
        displayName: r.display_name,
        userId: r.user_id,
        openLeads: r.open_leads,
        stalledLeads: r.stalled,
        unansweredLeads: r.unanswered,
        openTasks: r.open_tasks,
        overdueTasks: r.overdue_tasks,
        calls: r.calls,
        activeDays: r.active_days,
      }));

      const board: LeaderboardRow[] = (row?.board ?? []).map((r) => ({
        telecallerId: r.telecaller_id,
        displayName: r.display_name,
        won: r.won,
        wonValue: r.won_value,
        leads: r.leads,
        calls: r.calls,
        connected: r.connected,
        tasksDone: r.tasks_done,
      }));

      return {
        from,
        to,
        scope: scope.scope,
        events: feed,
        /**
         * The feed hit its cap, so the range holds more than came back.
         *
         * Reported rather than paged: a scanned feed does not want a pager, and a
         * page that implied 200 lines were everything would understate a busy
         * month. The reader narrows the range instead, which is the control
         * already at the top of the page.
         */
        feedTruncated: feed.length >= FEED_LIMIT,
        /**
         * Why a quiet feed may not mean a quiet floor - stated by the API rather
         * than assumed by the page, because it is a fact about the schema.
         *
         * `calls` has no `lead_id` (the link runs the other way,
         * `leads.first_call_id`), so a lead that was RUNG but not moved leaves no
         * ledger row and cannot appear here. Migration 0093 states the same
         * limitation for first-response time. It under-reports activity and never
         * over-reports it, which is the safer direction.
         */
        callsNotInFeed: true,
        workload,
        leaderboard: board,
        stageSlaDays: DEFAULT_STAGE_SLA_DAYS,
      };
    });
  }
}

/*
 * NOT HERE, deliberately: an unbounded "all activity" endpoint.
 *
 * Every read above is bounded by the range AND by FEED_LIMIT, and the temptation
 * is a `?limit=` for somebody exporting a month. That belongs to the export
 * engine (doc 35, migration 0148), which applies this same scope predicate from
 * the same shared module and writes a file - not to a console endpoint that would
 * hold a connection open aggregating three ledgers without a ceiling.
 */
