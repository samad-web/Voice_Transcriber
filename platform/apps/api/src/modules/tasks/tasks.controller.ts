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
import { TaskInput, TaskUpdate } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, scopeFilter, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { notify } from "../notifications/notify";
import { DbService } from "../../db/db.service";

const ListQuery = z.object({
  status: z.enum(["open", "done", "cancelled"]).optional(),
  assigneeUserId: z.string().uuid().optional(),
  /** `?mine=1` - resolves to the caller, so the console needn't know its own id. */
  mine: z.coerce.boolean().optional(),
  dealId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  /** Only what is already late. The manager's view, and the notification hook's. */
  overdue: z.coerce.boolean().optional(),
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
      }

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
      // FK violations bypass RLS and would surface as a 500, so every
      // referenced object is confirmed visible in THIS org first.
      await assertVisible(client, "contacts", p.contactId);
      await assertVisible(client, "accounts", p.accountId);
      await assertVisible(client, "deals", p.dealId);
      await assertVisible(client, "users", p.assigneeUserId);

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
      await assertVisible(client, "users", p.assigneeUserId ?? undefined);

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

/** No-op when the id is absent - every reference on a task is optional. */
async function assertVisible(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  table: "contacts" | "accounts" | "deals" | "users",
  id: string | null | undefined,
): Promise<void> {
  if (!id) return;
  // `users` is not an org-scoped table, so RLS does not constrain this one;
  // it is a existence check against a real FK, which is what stops a 500.
  const found = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  if (!found.rowCount) throw new BadRequestException(`${table.replace(/s$/, "")} not found`);
}

/** Same validate-or-null helper merge/interactions need - see those files. */
function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
