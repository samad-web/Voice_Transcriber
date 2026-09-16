import {
  BadRequestException,
  Body,
  Controller,
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
import { BulkAssignTasksInput, TaskInput, TaskPriority, TaskUpdate, type BulkResult } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { assignInBulk } from "../../common/bulk-assign";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, scopeFilter, type CrmRecordScope } from "../../common/crm-scope";
import { assertInOrg, assertMembers } from "../../common/org-references";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { notify } from "../notifications/notify";
import { DbService } from "../../db/db.service";

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const ListQuery = z.object({
  status: z.enum(["open", "done", "cancelled"]).optional(),
  assigneeUserId: z.string().uuid().optional(),
  /** `?mine=1` - resolves to the caller, so the console needn't know its own id. */
  mine: z.coerce.boolean().optional(),
  /** Only tasks nobody has been given. */
  unassigned: z.coerce.boolean().optional(),
  dealId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  priority: TaskPriority.optional(),
  /** Title search. */
  q: z.string().max(200).optional(),
  /** Only what is already late. The manager's view, and the notification hook's. */
  overdue: z.coerce.boolean().optional(),
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
  t.assignee_user_id, t.created_by, to_char(t.due_on, 'YYYY-MM-DD') AS due_on,
  t.status, t.priority, t.completed_at, t.created_at, t.updated_at`;

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

      // `mine` resolves server-side from the principal. A caller that has no
      // resolvable uuid identity (the bare admin key) asked for "my tasks" and
      // has no "my", so it gets an empty list rather than everyone's.
      if (q.mine) {
        const me = actorUserId(req);
        if (!me) return { tasks: [], total: 0, limit: q.limit, offset: q.offset };
        add("t.assignee_user_id = $?", me);
      } else if (q.assigneeUserId) {
        add("t.assignee_user_id = $?", q.assigneeUserId);
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
      if (q.overdue) where.push("t.status = 'open' AND t.due_on IS NOT NULL AND t.due_on < current_date");

      params.push(q.limit, q.offset);
      const { rows } = await client.query(
        `SELECT ${TASK_COLUMNS},
                u.name AS assignee_name,
                d.name AS deal_name,
                c.display_name AS contact_name,
                count(*) OVER() AS total
           FROM tasks t
           LEFT JOIN users u    ON u.id = t.assignee_user_id
           LEFT JOIN deals d    ON d.id = t.deal_id
           LEFT JOIN contacts c ON c.id = t.contact_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY ${ORDER[q.sort]}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        tasks: rows.map(({ total: _total, ...row }) => row),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  @Get(":id")
  @RequireCrmPermission("task", "view")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const scoped = scopeClause("task", recordScope, 2, "t");
      const {
        rows: [task],
      } = await client.query(
        `SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!task) throw new NotFoundException("task not found");
      return { task };
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
      });
      await assertMembers(client, orgId, { assigneeUserId: p.assigneeUserId });

      const {
        rows: [task],
      } = await client.query(
        `INSERT INTO tasks
           (org_id, title, notes, contact_id, account_id, deal_id,
            assignee_user_id, created_by, due_on, priority)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${TASK_COLUMNS.replace(/t\./g, "")}`,
        [
          orgId,
          p.title,
          p.notes ?? null,
          p.contactId ?? null,
          p.accountId ?? null,
          p.dealId ?? null,
          p.assigneeUserId ?? null,
          actorUserId(req),
          p.dueOn ?? null,
          p.priority,
        ],
      );

      // Telling the assignee is the difference between a task list and a
      // to-do list somebody has to remember to check. `notify` drops it when
      // the assignee IS the creator - being told you gave yourself a task is
      // exactly the noise that teaches people to ignore the bell.
      if (task.assignee_user_id) {
        await notify(
          client,
          orgId,
          {
            userId: task.assignee_user_id,
            kind: "task_assigned",
            title: task.title,
            body: task.due_on ? `Due ${task.due_on}` : null,
            linkPath: "/owner/tasks",
            taskId: task.id,
            dealId: task.deal_id,
            contactId: task.contact_id,
          },
          actorUserId(req),
        );
      }

      await this.audit(client, orgId, "task.create", task.id, req);
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
      const updated = await assignInBulk(client, {
        orgId,
        table: "tasks",
        column: "assignee_user_id",
        value: assigneeUserId,
        ids,
        owned: scopeFilter("task", recordScope, "r"),
        audit: { targetType: "task", action: "task.reassign", actorId: req.principal?.userId ?? "dev-admin" },
      });

      if (assigneeUserId && updated.length > 0) {
        const {
          rows: [first],
        } = await client.query<{ title: string; due_on: string | null; deal_id: string | null; contact_id: string | null }>(
          `SELECT title, to_char(due_on, 'YYYY-MM-DD') AS due_on, deal_id, contact_id FROM tasks WHERE id = $1`,
          [updated[0]],
        );
        const one = updated.length === 1;
        await notify(
          client,
          orgId,
          {
            userId: assigneeUserId,
            kind: "task_assigned",
            title: one ? first.title : `${updated.length} follow-ups were assigned to you`,
            body: one ? (first.due_on ? `Due ${first.due_on}` : null) : `Starting with "${first.title.slice(0, 80)}"`,
            linkPath: "/owner/tasks",
            taskId: one ? updated[0] : null,
            dealId: one ? first.deal_id : null,
            contactId: one ? first.contact_id : null,
          },
          actorUserId(req),
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
      await assertMembers(client, orgId, { assigneeUserId: p.assigneeUserId });

      const sets: string[] = [];
      const params: unknown[] = [id];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };

      if (p.title !== undefined) set("title", p.title);
      if (p.notes !== undefined) set("notes", p.notes);
      if (p.assigneeUserId !== undefined) set("assignee_user_id", p.assigneeUserId);
      if (p.dueOn !== undefined) set("due_on", p.dueOn);
      if (p.priority !== undefined) set("priority", p.priority);
      if (p.status !== undefined) {
        set("status", p.status);
        // completed_at is derived, never client-supplied: it is the answer to
        // "when was this finished", and reopening a task must clear it rather
        // than leave a stale completion date behind.
        sets.push(p.status === "done" ? "completed_at = now()" : "completed_at = NULL");
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

      // Re-assignment notifies the new owner, on the same terms as creation.
      // Deliberately not the OLD owner: "this was taken off you" is a message
      // about somebody else's decision, and if it needs saying it needs
      // saying by a person.
      if (p.assigneeUserId) {
        await notify(
          client,
          orgId,
          {
            userId: p.assigneeUserId,
            kind: "task_assigned",
            title: task.title,
            body: task.due_on ? `Due ${task.due_on}` : null,
            linkPath: "/owner/tasks",
            taskId: task.id,
            dealId: task.deal_id,
            contactId: task.contact_id,
          },
          actorUserId(req),
        );
      }

      await this.audit(client, orgId, "task.update", id, req);
      return { task };
    });
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
       VALUES ($1, 'user', $2, $3, 'task', $4)`,
      [orgId, req.principal?.userId ?? "dev-admin", action, targetId],
    );
  }
}

/** Same validate-or-null helper merge/interactions need - see those files. */
function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
