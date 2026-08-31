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
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { RoleInput, RolePermissionGrant } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgRoleGuard, RequireOrgRole } from "../../common/org-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Roles & permissions (CRM Phase 1, E0.4) - additive to `memberships.role`/
 * `memberships.owner_role`, not a replacement. Schema: packages/db/
 * migrations/0039.
 *
 * SCHEMA ONLY, deliberately: nothing here is wired into PermissionsGuard/
 * OwnerRoleGuard/principalHasPermission, and there is no endpoint that
 * assigns a role to a membership - memberships.role stays the live 5-value
 * CHECK enum every authorization call site reads today. See 0039's header
 * for why widening that is out of scope for a "foundation" phase. This
 * module lets an operator define custom roles and edit ANY role's (including
 * a system role's) permission grid - that's the point of the feature - but
 * a system role's identity (key/is_system) can't be renamed or archived,
 * since other code assumes the 5 seeded rows exist per org.
 */

const UpdateRoleBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const PermissionsBody = z.object({
  grants: z.array(RolePermissionGrant).max(64),
});

const ROLE_COLUMNS = `id, key, name, description, is_system, status, created_at, updated_at`;

@Controller("roles")
@UseGuards(AdminKeyGuard, TenantGuard)
export class RolesController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${ROLE_COLUMNS} FROM roles ORDER BY is_system DESC, key ASC`,
      );
      return { roles: rows };
    });
  }

  @Post()
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = RoleInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rows: [existing] } = await client.query(
        `SELECT 1 FROM roles WHERE org_id = $1 AND key = $2`,
        [orgId, p.key],
      );
      if (existing) throw new BadRequestException(`role "${p.key}" already exists`);

      const { rows: [role] } = await client.query(
        `INSERT INTO roles (org_id, key, name, description, is_system)
         VALUES ($1, $2, $3, $4, false)
         RETURNING ${ROLE_COLUMNS}`,
        [orgId, p.key, p.name, p.description ?? null],
      );
      await this.audit(client, orgId, "role.create", role.id, req);
      return { role };
    });
  }

  /** Name/description/status only. A system role's key/is_system are fixed -
   *  other code (e.g. the createTenant seed, memberships.role_id backfill)
   *  assumes the 5 seeded rows exist per org with those exact keys. */
  @Patch(":id")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdateRoleBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      const { rows: [existing] } = await client.query(
        `SELECT is_system FROM roles WHERE id = $1`,
        [id],
      );
      if (!existing) throw new NotFoundException("role not found");
      if (existing.is_system) {
        throw new BadRequestException("system roles cannot be renamed, described or archived");
      }

      const { rows: [role] } = await client.query(
        `UPDATE roles SET
           name        = COALESCE($2, name),
           description = CASE WHEN $3::boolean THEN $4 ELSE description END,
           status      = COALESCE($5, status)
         WHERE id = $1
         RETURNING ${ROLE_COLUMNS}`,
        [id, p.name ?? null, p.description !== undefined, p.description ?? null, p.status ?? null],
      );
      await this.audit(client, orgId, "role.update", id, req);
      return { role };
    });
  }

  @Get(":id/permissions")
  async permissions(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: [role] } = await client.query(`SELECT id FROM roles WHERE id = $1`, [id]);
      if (!role) throw new NotFoundException("role not found");

      const { rows } = await client.query(
        `SELECT object_type, action, scope, field_restrictions
           FROM role_permissions WHERE role_id = $1
          ORDER BY object_type, action`,
        [id],
      );
      return { grants: rows };
    });
  }

  /**
   * Replace the full grant set for a role in one call - a permission grid is
   * edited as a whole (every checkbox state submitted together), not one
   * cell at a time, so delete-then-insert is simpler and no less correct
   * than diffing.
   */
  @Put(":id/permissions")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async replacePermissions(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = PermissionsBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const { rows: [role] } = await client.query(`SELECT id FROM roles WHERE id = $1`, [id]);
      if (!role) throw new NotFoundException("role not found");

      await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
      for (const grant of parsed.data.grants) {
        await client.query(
          `INSERT INTO role_permissions (org_id, role_id, object_type, action, scope, field_restrictions)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [orgId, id, grant.objectType, grant.action, grant.scope, JSON.stringify(grant.fieldRestrictions)],
        );
      }
      await this.audit(client, orgId, "role.permissions_update", id, req);

      const { rows } = await client.query(
        `SELECT object_type, action, scope, field_restrictions
           FROM role_permissions WHERE role_id = $1
          ORDER BY object_type, action`,
        [id],
      );
      return { grants: rows };
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
       VALUES ($1, 'user', $2, $3, 'role', $4)`,
      [orgId, req.principal?.userId ?? "dev-admin", action, targetId],
    );
  }
}
