import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  BulkAssignTasksInput,
  TaskInput,
  TaskPriority,
  TaskRespondInput,
  TaskUpdate,
  type BulkResult,
  type TaskAssignee,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { assignInBulk } from "../../common/bulk-assign";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, scopeFilter, type CrmRecordScope } from "../../common/crm-scope";
import { assertInOrg, assertMembers } from "../../common/org-references";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { notify } from "../notifications/notify";
import { DbService } from "../../db/db.service";
import {
  assigneesSql,
  awaitingSql,
  materializePrimary,
  onTaskSql,
  replaceAssignees,
  withMyStatus,
} from "./task-assignees";
import { auditActor } from "../../common/audit-actor";

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const ListQuery = z.object({
  status: z.enum(["open", "done", "cancelled"]).optional(),
  assigneeUserId: z.string().uuid().optional(),
  /** `?mine=1` - resolves to the caller, so the console needn't know its own id. */
  mine: z.coerce.boolean().optional(),
  /** Only tasks nobody has been given. */
  unassigned: z.coerce.boolean().optional(),
  /** Only tasks waiting for the CALLER to accept or decline (0135). */
  awaiting: z.coerce.boolean().optional(),
  dealId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  priority: TaskPriority.optional(),
  /** Title search. */
  q: z.string().max(200).optional(),
  /** Only what is already late. The manager's view, and the notification hook's. */
  overdue: z.coerce.boolean().optional(),
  /** The follow-up queue's tab. Supersedes `overdue`, which it also expresses. */
  bucket: z.enum(["all", "overdue", "today", "upcoming", "completed"]).optional(),
  /**
   * A due-date window, inclusive, in the VIEWER's calendar. The console sends
   * the dates rather than a word like "today" because "today" is the browser's
   * date (lib/next-actions.ts), and this server's midnight is not the rep's.
   */
  dueFrom: DateOnly.optional(),
  dueTo: DateOnly.optional(),
  /** Only tasks with no due date. */
  undated: z.coerce.boolean().optional(),
  sort: z.enum(["due", "created", "priority"]).default("due"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * `due_on` is rendered with to_char, NOT returned raw.
 *
 * node-postgres parses a `date` column into a JS Date at the SERVER PROCESS's
 * local midnight, and JSON.stringify then emits it as UTC - so on any
 * positive-offset host (this platform runs in IST, +05:30) a task due
 * 2026-08-01 goes out as "2026-07-31T18:30:00.000Z" and every due date reads
 * a day early. Caught live; a typecheck cannot see it, because the types are
 * identical either way. slots.controller.ts uses the same to_char convention
 * for the same reason.
 */
const TASK_COLUMNS = `t.id, t.workspace_id, t.title, t.notes, t.contact_id, t.account_id, t.deal_id,
  t.lead_id, t.assignee_user_id, t.created_by, to_char(t.due_on, 'YYYY-MM-DD') AS due_on,
  t.due_at, t.status, t.priority, t.completed_at, t.completed_by, t.reminders_sent,
  t.created_at, t.updated_at`;

/**
 * The five buckets the follow-up queue is worked in, as SQL.
 *
 * `org_reporting_today()` (0095) and never `current_date`: the database runs
 * in UTC and this platform's floors are UTC+5:30, so between midnight and half
 * past five in the morning `current_date` still reads yesterday - and a
 * follow-up that went late at midnight would not be reported late until
 * breakfast. That was the behaviour before 0095.
 *
 * `overdue` deliberately excludes completed work, however late it was closed:
 * a queue answers "what do I still owe", and a task finished three days late
 * is a compliance fact (the report has it) rather than an outstanding one.
 *
 * `all` is open work of any date, NOT literally every row - a tab called All
 * that includes six months of completed follow-ups is a log, and the four tabs
 * beside it are then subsets of something nobody is working.
 */
const BUCKETS: Record<string, string> = {
  all: "t.status = 'open'",
  overdue: "t.status = 'open' AND t.due_on IS NOT NULL AND t.due_on < org_reporting_today()",
  today: "t.status = 'open' AND t.due_on = org_reporting_today()",
  upcoming: "t.status = 'open' AND t.due_on IS NOT NULL AND t.due_on > org_reporting_today()",
  completed: "t.status = 'done'",
};

/**
 * Follow-up tasks (Track A3, migration 0041) - "call Priya back on Thursday".
 *
 * Gated on the `task` object type, which joined `PermissionObjectType` with
 * this change; 0041 seeds every system role's task grants to match its
 * contact grants, so no existing user loses access when these routes appear.
 *
 * Sorting is a whitelisted map, never caller SQL - same pattern as
 * owner/leads.controller.ts. `due` puts undated tasks last rather than first:
 * a task with no date is not the most urgent thing on the list, which is what
 * a plain ASC would claim.
 */
const ORDER: Record<string, string> = {
  due: "t.due_on ASC NULLS LAST, t.created_at DESC",
  created: "t.created_at DESC",
  // Explicit rank, because 'high' | 'low' | 'normal' sorts alphabetically into
  // exactly the wrong order.
  priority:
    "CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.due_on ASC NULLS LAST",
};

@Controller("tasks")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class TasksController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireCrmPermission("task", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        // Global replace: the `task` owned-scope clause has two `$?`
        // placeholders bound to the same value (assignee OR creator) - see
        // scopeFilter() in common/crm-scope.ts. A single-occurrence replace
        // left the second one as a literal "$?", a Postgres syntax error.
        where.push(clause.replace(/\$\?/g, `$${params.length}`));
      };

      if (q.status) add("t.status = $?", q.status);
      if (q.dealId) add("t.deal_id = $?", q.dealId);
      if (q.contactId) add("t.contact_id = $?", q.contactId);
      if (q.accountId) add("t.account_id = $?", q.accountId);
      if (q.leadId) add("t.lead_id = $?", q.leadId);

      // `mine` resolves server-side from the principal. A caller that has no
      // resolvable uuid identity (the bare admin key) asked for "my tasks" and
      // has no "my", so it gets an empty list rather than everyone's.
      // "Assigned to X" includes tasks X was asked to share (0135) and has not
      // declined, not only the ones where X is the primary.
      const me = actorUserId(req);
      if (q.awaiting) {
        if (!me) return { tasks: [], total: 0, limit: q.limit, offset: q.offset };
        add(awaitingSql("t"), me);
      }
      if (q.mine) {
        if (!me) return { tasks: [], total: 0, limit: q.limit, offset: q.offset };
        add(onTaskSql("t"), me);
      } else if (q.assigneeUserId) {
        add(onTaskSql("t"), q.assigneeUserId);
      } else if (q.unassigned) {
        where.push("t.assignee_user_id IS NULL");
      }
      if (q.priority) add("t.priority = $?", q.priority);
      if (q.q) add("t.title ILIKE $?", `%${q.q}%`);
      if (q.dueFrom) add("t.due_on >= $?::date", q.dueFrom);
      if (q.dueTo) add("t.due_on <= $?::date", q.dueTo);
      if (q.undated) where.push("t.due_on IS NULL");

      // The `owned` half of the permission grid. For a task that means either
      // END of it - assignee or creator - because a rep who asked a colleague
      // to do something still needs to see it. See common/crm-scope.ts.
      const owned = scopeFilter("task", recordScope, "t");
      if (owned) add(owned.sql, owned.value);

      // Overdue means open AND past due - a completed task that was late is
      // not something anyone still needs to act on.
      // `bucket` wins where both are given: it is the newer, more expressive
      // parameter and `?overdue=1&bucket=today` is a caller contradicting
      // itself, which should resolve deterministically rather than by AND-ing
      // into a filter that matches nothing.
      if (q.bucket) where.push(BUCKETS[q.bucket]);
      else if (q.overdue) where.push(BUCKETS.overdue);

      params.push(q.limit, q.offset);
      const { rows } = await client.query(
        `SELECT ${TASK_COLUMNS},
                u.name AS assignee_name,
                d.name AS deal_name,
                c.display_name AS contact_name,
                l.title AS lead_title, l.stage AS lead_stage,
                ${assigneesSql("t")},
                count(*) OVER() AS total
           FROM tasks t
           LEFT JOIN users u    ON u.id = t.assignee_user_id
           LEFT JOIN deals d    ON d.id = t.deal_id
           LEFT JOIN contacts c ON c.id = t.contact_id
           LEFT JOIN leads l    ON l.id = t.lead_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY ${ORDER[q.sort]}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        tasks: rows.map(({ total: _total, ...row }) => withMyStatus(row, me)),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  /**
   * The five tab counts, in one round trip.
   *
   * One statement with FILTER clauses rather than five queries, for the reason
   * that governs every aggregate on this platform: the database is ~125ms away
   * and node-postgres does not pipeline, so five counts for one row of tabs
   * would be most of a second of latency, forever.
   *
   * Declared above `@Get(":id")` on purpose - Nest matches in declaration
   * order, and after it "counts" would be parsed as a task id and 400 on the
   * uuid pipe.
   *
   * Scoped exactly like the list: a telecaller's tabs must count the same rows
   * their list shows, or the badge says 12 and the page shows 3.
   */
  @Get("counts")
  @RequireCrmPermission("task", "view")
  async counts(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
    @Query("mine") mine?: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace(/\$\?/g, `$${params.length}`));
      };

      const me = actorUserId(req);
      if (mine === "1" || mine === "true") {
        if (!me) return { all: 0, overdue: 0, today: 0, upcoming: 0, completed: 0, awaiting: 0 };
        add(onTaskSql("t"), me);
      }
      const owned = scopeFilter("task", recordScope, "t");
      if (owned) add(owned.sql, owned.value);

      // What is waiting for the reader's own answer (0135) - the Tasks page's
      // banner. Always the caller's, whatever `mine` says: nobody accepts a
      // task on somebody else's behalf.
      let awaiting = "0";
      if (me) {
        params.push(me);
        awaiting = `count(*) FILTER (WHERE t.status = 'open' AND ${awaitingSql("t").replace(/\$\?/g, `$${params.length}`)})`;
      }

      const {
        rows: [counts],
      } = await client.query(
        `SELECT ${Object.entries(BUCKETS)
          .map(([key, predicate]) => `count(*) FILTER (WHERE ${predicate})::int AS ${key}`)
          .join(", ")}, ${awaiting}::int AS awaiting
           FROM tasks t
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
        params,
      );
      return counts ?? { all: 0, overdue: 0, today: 0, upcoming: 0, completed: 0, awaiting: 0 };
    });
  }

  @Get(":id")
  @RequireCrmPermission("task", "view")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const scoped = scopeClause("task", recordScope, 2, "t");
      const {
        rows: [task],
      } = await client.query(
        `SELECT ${TASK_COLUMNS}, ${assigneesSql("t")} FROM tasks t WHERE t.id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!task) throw new NotFoundException("task not found");
      return { task: withMyStatus(task, actorUserId(req)) };
    });
  }

  @Post()
  @RequireCrmPermission("task", "create")
  // No @RecordScope() here, deliberately: `created_by` is stamped with the
  // actor and a task counts as "owned" via EITHER end, so a scoped user always
  // sees the task they just created without anything extra being stamped.
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = TaskInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // FK checks bypass RLS, so every referenced row is confirmed to be in
      // THIS org first - and the assignee a MEMBER of it, since `users` has
      // no RLS and an existence check alone accepted another tenant's user.
      await assertInOrg(client, orgId, {
        contactId: p.contactId,
        accountId: p.accountId,
        dealId: p.dealId,
        leadId: p.leadId,
      });
      const people = p.assigneeUserIds ?? (p.assigneeUserId ? [p.assigneeUserId] : []);
      await assertMembers(client, orgId, memberRefs(people));
      const me = actorUserId(req);

      const {
        rows: [task],
      } = await client.query(
        // due_on is passed as given and may be null even when due_at is set:
        // the BEFORE trigger 0095 installs derives it from due_at in the org's
        // timezone. Computing it here as well would be a second definition of
        // the same date, in a process that does not know the org's timezone.
        `INSERT INTO tasks
           (org_id, title, notes, contact_id, account_id, deal_id, lead_id,
            assignee_user_id, created_by, due_on, due_at, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING ${TASK_COLUMNS.replace(/t\./g, "")}`,
        [
          orgId,
          p.title,
          p.notes ?? null,
          p.contactId ?? null,
          p.accountId ?? null,
          p.dealId ?? null,
          p.leadId ?? null,
          people[0] ?? null,
          me,
          p.dueOn ?? null,
          p.dueAt ?? null,
          p.priority,
        ],
      );

      // Everyone on it gets a row, pending until they answer - except the
      // creator, if they put themselves on it (accepted on the spot).
      const asked = await replaceAssignees(client, orgId, [task.id], people, me);
      await this.askToAccept(client, orgId, task, asked.map((a) => a.user_id), me);

      await this.audit(client, orgId, "task.create", task.id, req);
      return { task: await this.load(client, task.id, me) };
    });
  }

  /**
   * An assignee's answer: accept, or decline and come off the task (0135).
   *
   * `task:view` rather than `task:edit`: being asked to do something must not
   * depend on being allowed to rewrite it, and the only row this can change is
   * the caller's own answer - the UPDATE is keyed on their id from the session,
   * never on anything in the body.
   *
   * On a decline, if they were the primary assignee, the next person still on
   * the task (someone who accepted first, else the earliest asked) takes that
   * place; if nobody is left the task returns to the unassigned queue. Either
   * way the creator is told, which is the point of asking.
   */
  @Post(":id/respond")
  @RequireCrmPermission("task", "view")
  async respond(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = TaskRespondInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { response, reason } = parsed.data;
    const me = actorUserId(req);
    if (!me) throw new ForbiddenException("only a signed-in person can answer a task");
    const status = response === "accept" ? "accepted" : "declined";

    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE task_assignees
            SET status = $3, responded_at = now(),
                decline_reason = CASE WHEN $3 = 'declined' THEN $4 END
          WHERE org_id = $5 AND task_id = $1 AND user_id = $2 AND status = 'pending'`,
        [id, me, status, reason || null, orgId],
      );
      if (!rowCount) {
        const {
          rows: [row],
        } = await client.query<{ status: string }>(
          `SELECT status FROM task_assignees WHERE org_id = $1 AND task_id = $2 AND user_id = $3`,
          [orgId, id, me],
        );
        if (row) throw new ConflictException(`you have already ${row.status} this task`);
        throw new NotFoundException("this task is not waiting for your answer");
      }

      if (status === "declined") {
        await client.query(
          `UPDATE tasks
              SET assignee_user_id = (
                SELECT ta.user_id FROM task_assignees ta
                 WHERE ta.task_id = $1 AND ta.status <> 'declined'
                 ORDER BY (ta.status = 'accepted') DESC, ta.assigned_at
                 LIMIT 1)
            WHERE id = $1 AND org_id = $3 AND assignee_user_id = $2`,
          [id, me, orgId],
        );
      }

      const task = await this.load(client, id, me);
      if (task.created_by) {
        const {
          rows: [who],
        } = await client.query<{ name: string | null; email: string }>(
          `SELECT name, email FROM users WHERE id = $1`,
          [me],
        );
        const name = who?.name || who?.email || "Someone";
        await notify(
          client,
          orgId,
          {
            userId: task.created_by,
            kind: "task_response",
            title: `${name} ${status} "${String(task.title).slice(0, 120)}"`,
            body: status === "declined" ? (reason ? `Reason: ${reason}` : "No reason given") : null,
            linkPath: "/owner/tasks",
            taskId: task.id,
            dealId: task.deal_id,
            contactId: task.contact_id,
          },
          me,
        );
      }

      await this.audit(client, orgId, status === "accepted" ? "task.accept" : "task.decline", id, req);
      return { task };
    });
  }

  /**
   * Hand many follow-ups to one person - the Tasks list's bulk "Reassign".
   *
   * `task:edit` and the task scope (assignee OR creator) in the UPDATE, as the
   * single PATCH. The new assignee is told ONCE, not once per task: forty
   * "task assigned" rows for one click is the noise that teaches people to
   * ignore the bell. `notify` still drops it when they gave the tasks to
   * themselves.
   */
  @Post("reassign")
  @RequireCrmPermission("task", "edit")
  async reassign(
    @OrgId() orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ): Promise<BulkResult> {
    const parsed = BulkAssignTasksInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { ids, assigneeUserId } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // `tasks` isn't in org-references' table map; the org filter in
      // assignInBulk's UPDATE is what keeps another tenant's ids untouched,
      // and an id that is not this org's is simply skipped.
      await assertMembers(client, orgId, { assigneeUserId });
      const me = actorUserId(req);
      // Before assignInBulk overwrites the column it reads - see materializePrimary.
      await materializePrimary(client, orgId, ids);
      const updated = await assignInBulk(client, {
        orgId,
        table: "tasks",
        column: "assignee_user_id",
        value: assigneeUserId,
        ids,
        owned: scopeFilter("task", recordScope, "r"),
        audit: { targetType: "task", action: "task.reassign", actorId: auditActor(req).id },
      });

      // Only the tasks the scoped UPDATE actually moved - a skipped id keeps
      // its people. The new person is pending on each unless it is the caller.
      const asked = await replaceAssignees(client, orgId, updated, assigneeUserId ? [assigneeUserId] : [], me);

      if (assigneeUserId && asked.length > 0) {
        const {
          rows: [first],
        } = await client.query<{ title: string; due_on: string | null; deal_id: string | null; contact_id: string | null }>(
          `SELECT title, to_char(due_on, 'YYYY-MM-DD') AS due_on, deal_id, contact_id FROM tasks WHERE id = $1`,
          [asked[0].task_id],
        );
        const one = asked.length === 1;
        await notify(
          client,
          orgId,
          {
            userId: assigneeUserId,
            kind: "task_assigned",
            title: one ? first.title : `${asked.length} follow-ups were assigned to you`,
            body: one
              ? `Accept or decline it on your Tasks page${first.due_on ? ` · due ${first.due_on}` : ""}`
              : `Accept or decline them on your Tasks page, starting with "${first.title.slice(0, 80)}"`,
            linkPath: "/owner/tasks?who=awaiting",
            taskId: one ? asked[0].task_id : null,
            dealId: one ? first.deal_id : null,
            contactId: one ? first.contact_id : null,
          },
          me,
        );
      }

      return { updated: updated.length, skipped: ids.length - updated.length };
    });
  }

  @Patch(":id")
  @RequireCrmPermission("task", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = TaskUpdate.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await assertInOrg(client, orgId, { leadId: p.leadId ?? undefined });
      // One person (the row picker, older callers) or the whole set (the
      // dialog). Either way it REPLACES everyone on the task.
      const people =
        p.assigneeUserIds ?? (p.assigneeUserId !== undefined ? (p.assigneeUserId ? [p.assigneeUserId] : []) : undefined);
      if (people) await assertMembers(client, orgId, memberRefs(people));
      const me = actorUserId(req);
      // Before the UPDATE below overwrites the column it reads.
      if (people) await materializePrimary(client, orgId, [id]);

      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };

      if (p.title !== undefined) set("title", p.title);
      if (p.notes !== undefined) set("notes", p.notes);
      if (people) set("assignee_user_id", people[0] ?? null);
      if (p.leadId !== undefined) set("lead_id", p.leadId);
      if (p.dueOn !== undefined) set("due_on", p.dueOn);
      if (p.dueAt !== undefined) set("due_at", p.dueAt);
      if (p.priority !== undefined) set("priority", p.priority);
      if (p.status !== undefined) {
        set("status", p.status);
        // completed_at is derived, never client-supplied: it is the answer to
        // "when was this finished", and reopening a task must clear it rather
        // than leave a stale completion date behind.
        sets.push(p.status === "done" ? "completed_at = now()" : "completed_at = NULL");
        // And WHO finished it (0095), from the principal rather than the body.
        // Not always the assignee: a manager clearing a rep's list is the
        // ordinary case, and a compliance report that cannot tell them apart
        // credits the wrong person. Cleared on reopen for the same reason
        // completed_at is.
        if (p.status === "done") set("completed_by", actorUserId(req));
        else sets.push("completed_by = NULL");
      }
      if (sets.length === 0) throw new BadRequestException("no fields to update");

      // A scoped user editing a task that is neither theirs to do nor theirs
      // to have asked for matches no row - same 404-not-403 contract the other
      // CRM objects use.
      const scopedUpdate = scopeClause("task", recordScope, params.length + 1);
      if (scopedUpdate) params.push(recordScope.userId);
      const {
        rows: [task],
      } = await client.query(
        `UPDATE tasks SET ${sets.join(", ")}
          WHERE id = $1 ${scopedUpdate ? `AND ${scopedUpdate}` : ""}
         RETURNING ${TASK_COLUMNS.replace(/t\./g, "")}`,
        params,
      );
      if (!task) throw new NotFoundException("task not found");

      // Re-assignment asks the NEW people, on the same terms as creation.
      // Deliberately not the people taken off: "this was taken off you" is a
      // message about somebody else's decision, and if it needs saying it
      // needs saying by a person.
      if (people) {
        const asked = await replaceAssignees(client, orgId, [id], people, me);
        await this.askToAccept(client, orgId, task, asked.map((a) => a.user_id), me);
      }

      await this.audit(client, orgId, "task.update", id, req);
      return { task: await this.load(client, id, me) };
    });
  }

  /** One task as the list returns it - names, record labels and everyone on it. */
  private async load(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: LoadedTask[] }> },
    id: string,
    me: string | null,
  ) {
    const {
      rows: [task],
    } = await client.query(
      `SELECT ${TASK_COLUMNS},
              u.name AS assignee_name,
              d.name AS deal_name,
              c.display_name AS contact_name,
              l.title AS lead_title, l.stage AS lead_stage,
              ${assigneesSql("t")}
         FROM tasks t
         LEFT JOIN users u    ON u.id = t.assignee_user_id
         LEFT JOIN deals d    ON d.id = t.deal_id
         LEFT JOIN contacts c ON c.id = t.contact_id
         LEFT JOIN leads l    ON l.id = t.lead_id
        WHERE t.id = $1`,
      [id],
    );
    if (!task) throw new NotFoundException("task not found");
    return withMyStatus(task, me);
  }

  /**
   * Tell each newly-asked person there is a task waiting for their answer.
   *
   * One notification per person, never one per person per edit: `asked` is
   * only who was ADDED (or asked again after declining), so re-saving the
   * dialog with the same people rings nobody. `notify` still drops the actor,
   * who never needs to accept their own task.
   */
  private async askToAccept(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    task: { id: string; title: string; due_on: string | null; deal_id: string | null; contact_id: string | null },
    userIds: string[],
    actor: string | null,
  ) {
    for (const userId of userIds) {
      await notify(
        client as Parameters<typeof notify>[0],
        orgId,
        {
          userId,
          kind: "task_assigned",
          title: String(task.title).slice(0, 200),
          body: `Accept or decline it on your Tasks page${task.due_on ? ` · due ${task.due_on}` : ""}`,
          linkPath: "/owner/tasks?who=awaiting",
          taskId: task.id,
          dealId: task.deal_id,
          contactId: task.contact_id,
        },
        actor,
      );
    }
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
    req: PrincipalRequest,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, $5, $2, $3, 'task', $4)`,
      [orgId, auditActor(req).id, action, targetId, auditActor(req).type],
    );
  }
}

/** The columns load() is read for by name; the rest pass through to the console. */
type LoadedTask = {
  id: string;
  title: string;
  due_on: string | null;
  deal_id: string | null;
  contact_id: string | null;
  created_by: string | null;
  assignees?: TaskAssignee[] | null;
  [column: string]: unknown;
};

/** assertMembers' shape for a list of people - the key is what its error names. */
function memberRefs(ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id, i) => [`assigneeUserIds[${i}]`, id]));
}

/** Same validate-or-null helper merge/interactions need - see those files. */
function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
