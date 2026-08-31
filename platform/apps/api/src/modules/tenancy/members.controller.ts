import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgRoleGuard, RequireOrgRole } from "../../common/org-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

// Platform_admin is reserved for internal staff - tenant self-service is limited
// to these four roles (design doc §3.4).
const Role = z.enum(["org_admin", "workspace_admin", "workspace_member", "viewer"]);

const CreateMemberBody = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200).optional(),
  role: Role,
  workspaceId: z.string().uuid().optional(),
  recordingsListen: z.boolean().optional(),
  recordingsExport: z.boolean().optional(),
});

const UpdateMemberBody = z.object({
  role: Role.optional(),
  /**
   * Assign a `roles` row (migration 0039) - including a CUSTOM one, which the
   * legacy `role` enum above cannot express. Null clears it, which falls the
   * member back to the grants of whatever system role `role` names.
   *
   * Sent on its own this leaves `role` untouched, so the legacy enum every
   * existing guard still reads is never changed as a side effect of granting
   * someone a custom CRM role.
   */
  roleId: z.string().uuid().nullable().optional(),
  recordingsListen: z.boolean().optional(),
  recordingsExport: z.boolean().optional(),
});

/** Members (§3.4): users + their org/workspace membership, roles, and the two
 * orthogonal privacy-weight permissions (recordings_listen / recordings_export). */
@Controller("members")
@UseGuards(AdminKeyGuard, TenantGuard)
export class MembersController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      // memberships is RLS-scoped to the org; users is a global platform table.
      const { rows } = await client.query(
        `SELECT u.id AS "userId", u.email, u.name, m.role,
                m.role_id AS "roleId", r.name AS "roleName",
                m.recordings_listen AS "recordingsListen",
                m.recordings_export AS "recordingsExport",
                m.scope_type AS "scopeType", m.scope_id AS "scopeId"
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN roles r ON r.id = m.role_id
          ORDER BY u.email`,
      );
      return { members: rows };
    });
  }

  @Post()
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateMemberBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { email, name, role, workspaceId, recordingsListen, recordingsExport } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      if (workspaceId) {
        const ws = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
        if (ws.rowCount === 0) throw new NotFoundException("workspace not found in this org");
      }

      // Users are global; upsert by their unique email.
      const {
        rows: [user],
      } = await client.query(
        `INSERT INTO users (email, name)
         VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
         RETURNING id, email, name`,
        [email, name ?? null],
      );

      const scopeType = workspaceId ? "workspace" : "org";
      // scope_id is a uuid column; keep it a distinct param from org_id.
      const scopeId = workspaceId ?? orgId;

      const {
        rows: [membership],
      } = await client.query(
        // `role_id` mirrors `role` onto the 0039 roles table. 0039 backfilled
        // the memberships that existed when it ran; without this every member
        // created afterwards would keep a NULL role_id forever and hold no CRM
        // grants at all. The subselect matches on the same (org_id, key) pair
        // that backfill used.
        `INSERT INTO memberships
           (org_id, user_id, scope_type, scope_id, role, role_id,
            recordings_listen, recordings_export)
         VALUES ($1, $2, $3, $4, $5,
                 (SELECT id FROM roles WHERE org_id = $1 AND key = $5), $6, $7)
         ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE SET
           role = EXCLUDED.role,
           role_id = EXCLUDED.role_id,
           recordings_listen = EXCLUDED.recordings_listen,
           recordings_export = EXCLUDED.recordings_export
         RETURNING id, scope_type AS "scopeType", scope_id AS "scopeId", role,
                   role_id AS "roleId",
                   recordings_listen AS "recordingsListen",
                   recordings_export AS "recordingsExport"`,
        [orgId, user.id, scopeType, scopeId, role, recordingsListen ?? false, recordingsExport ?? false],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'member.create', 'user', $3)`,
        [orgId, req.principal?.userId ?? "dev-admin", user.id],
      );

      return { userId: user.id, email: user.email, name: user.name, ...membership };
    });
  }

  @Patch(":userId")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async update(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdateMemberBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      // An explicit roleId must name a role in THIS org. Checked up front rather
      // than left to the FK, which would only catch a wholly non-existent id -
      // a real role belonging to a DIFFERENT tenant would satisfy the constraint
      // while granting this member another org's permission grid.
      if (p.roleId != null) {
        const role = await client.query("SELECT 1 FROM roles WHERE id = $1 AND org_id = $2", [
          p.roleId,
          orgId,
        ]);
        if (role.rowCount === 0) throw new NotFoundException("role not found in this org");
      }

      const { rows } = await client.query(
        // `org_id = $5` is defence in depth, not the primary control. Today the
        // primary control is RLS: withOrg runs on getPool() as `aura_app`, which
        // 0001 creates NOBYPASSRLS, and memberships carries FORCE ROW LEVEL
        // SECURITY with both USING and WITH CHECK on org_id - so the statement is
        // already narrowed to the current tenant and cannot reach another org's
        // row. What it did NOT have was any org predicate of its own, and a
        // person's membership set is inherently cross-org: the same user_id is
        // the same human in every tenant they belong to. Swap `withOrg` for
        // `adminPool()` here for any reason (a debugging change, a pre-tenant
        // flow, a copy-paste) and this single statement silently regrades that
        // human's role in EVERY org at once, with no error and a 200 response.
        // One line makes that impossible independently of the database's
        // configuration, which is where a control this consequential belongs.
        //
        // Still no scope_type/scope_id filter, and that is deliberate: a user may
        // hold an org-scope row and workspace-scope rows in the same tenant, and
        // "set this person's role here" means all of them. The plural
        // `{ memberships: rows }` response is that intent. See 0018's header,
        // which is why owner_role is a separate column rather than a reuse of
        // `role` - an operator's team edit must never regrade a live owner
        // console login.
        //
        // role_id has three cases, in priority order: an explicit roleId wins
        // (including an explicit null, which is why the "was it supplied?" flag
        // is a separate parameter from the value - COALESCE cannot tell "clear
        // it" from "leave it alone"); otherwise a role change re-syncs it to the
        // matching system role; otherwise it is left exactly as it was.
        `UPDATE memberships SET
           role = COALESCE($2, role),
           role_id = CASE
             WHEN $6::boolean THEN $7::uuid
             WHEN $2::text IS NOT NULL THEN (SELECT id FROM roles WHERE org_id = $5 AND key = $2)
             ELSE role_id
           END,
           recordings_listen = COALESCE($3, recordings_listen),
           recordings_export = COALESCE($4, recordings_export)
         WHERE user_id = $1
           AND org_id = $5
         RETURNING id, user_id AS "userId", scope_type AS "scopeType", scope_id AS "scopeId",
                   role, role_id AS "roleId", recordings_listen AS "recordingsListen",
                   recordings_export AS "recordingsExport"`,
        [
          userId,
          p.role ?? null,
          p.recordingsListen ?? null,
          p.recordingsExport ?? null,
          orgId,
          p.roleId !== undefined,
          p.roleId ?? null,
        ],
      );
      if (rows.length === 0) throw new NotFoundException("member not found in this org");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'member.update', 'user', $3, $4::jsonb)`,
        [orgId, req.principal?.userId ?? "dev-admin", userId, JSON.stringify(p)],
      );
      return { memberships: rows };
    });
  }

  @Delete(":userId")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async remove(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // RLS scopes this DELETE to the current org; the global user row is left
      // intact. `org_id = $2` restates that in the statement itself for the same
      // reason as the PATCH above - an unqualified `WHERE user_id = $1` on
      // memberships is one pool swap away from deleting a human's access to
      // every tenant they belong to.
      const res = await client.query("DELETE FROM memberships WHERE user_id = $1 AND org_id = $2", [
        userId,
        orgId,
      ]);
      if ((res.rowCount ?? 0) === 0) throw new NotFoundException("member not found in this org");

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'member.delete', 'user', $3)`,
        [orgId, req.principal?.userId ?? "dev-admin", userId],
      );
      return { deleted: res.rowCount ?? 0 };
    });
  }
}
