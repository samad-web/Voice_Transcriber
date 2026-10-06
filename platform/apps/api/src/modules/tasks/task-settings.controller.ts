import { BadRequestException, Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { resolveOwnerRole } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const TaskSettingsInput = z.object({ ownerSelfTasks: z.boolean() });

export interface TaskSettingsView {
  /** May an owner or manager put a task on themselves (migration 0156). */
  ownerSelfTasks: boolean;
  /** Whether THIS reader may flip it - owners only. The page says so rather than guessing. */
  canEdit: boolean;
}

/**
 * Task settings (migration 0156) - today, one switch: whether an owner or a
 * manager may give themselves a task.
 *
 * ── WHY THE SWITCH IS OWNER-ONLY AND THE PAGE IS NOT ────────────────────────
 *
 * The same split the escalation settings make, for the same reason. The page
 * is owner and manager, because a manager running the floor needs to know
 * whether tasks land on them. Flipping it is the business deciding how the
 * tool is used by the people at the top of it, which is an owner's call - and
 * a manager who could switch it on for themselves would be deciding it for
 * every owner in the workspace too, since the column is one per org.
 *
 * `canEdit` rides on the payload rather than being re-derived in the browser,
 * so the control that is disabled and the write that would be refused are
 * decided by the same thing.
 */
@Controller("owner/task-settings")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class TaskSettingsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async get(@Req() req: PrincipalRequest, @OrgId() orgId: string): Promise<TaskSettingsView> {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{
        owner_self_tasks: boolean;
        viewer_role: string | null;
        is_member: boolean;
      }>(
        // The viewer's persona from `memberships`, not from the request: on an
        // admin-key call - which is how the web tier reaches this API -
        // `principal.ownerRole` is the caller's own claim and is informational
        // only (see OwnerRoleGuard's note). `canEdit` has to agree with what
        // the PUT will actually allow.
        //
        // `is_member` rides along because a NULL `owner_role` means two
        // different things: the pre-persona owner (0153), and no membership row
        // found at all. Without it, "nobody we recognise" would read as "owner"
        // and light up a control the PUT would refuse.
        `SELECT o.owner_self_tasks, m.owner_role AS viewer_role, (m.id IS NOT NULL) AS is_member
           FROM organizations o
           LEFT JOIN LATERAL (
             SELECT id, owner_role FROM memberships
              WHERE org_id = o.id AND user_id::text = $2
              LIMIT 1
           ) m ON true
          WHERE o.id = $1`,
        [orgId, req.principal?.userId ?? ""],
      );
      return {
        ownerSelfTasks: row?.owner_self_tasks ?? false,
        // NULL is the pre-persona owner (0153), which is why this is not a
        // bare `=== "owner"` on the column.
        canEdit: Boolean(row?.is_member) && resolveOwnerRole(row?.viewer_role ?? null) === "owner",
      };
    });
  }

  @Put()
  @RequireOwnerRole("owner")
  async put(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Body() body: unknown,
  ): Promise<TaskSettingsView> {
    const parsed = TaskSettingsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { ownerSelfTasks } = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      await client.query(`UPDATE organizations SET owner_self_tasks = $2 WHERE id = $1`, [
        orgId,
        ownerSelfTasks,
      ]);
      // Audited like every other workspace switch: "why can I suddenly assign
      // myself tasks again" has to be answerable, and the answer is a person.
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'org.task_settings', 'organization', $1, $4::jsonb)`,
        [orgId, actor.type, actor.id, JSON.stringify({ ownerSelfTasks })],
      );
      // Switching OFF deliberately leaves existing tasks where they are. An
      // owner mid-way through something they assigned themselves keeps it, can
      // still complete it, and is not left holding a row the API now refuses
      // to let anybody touch. The switch governs the write, not the rows.
      return { ownerSelfTasks, canEdit: true };
    });
  }
}
