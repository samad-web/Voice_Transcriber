import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { RolesService } from "./roles.service";

/**
 * Roles & permissions, the OPERATOR's surface (CRM Phase 1, E0.4). Schema:
 * packages/db/migrations/0039.
 *
 * The behaviour lives in `RolesService`, shared with the client console's
 * `/v1/owner/roles`; that file explains why the two exist separately and why
 * the guard tier is the only difference between them.
 *
 * NO LONGER SCHEMA-ONLY. 0039's header said this grid was wired into nothing
 * and that no endpoint assigned a role to a membership. Both halves have since
 * changed: `CrmPermissionsGuard` has enforced the grid since 0079, and
 * `PUT /v1/owner/team/:userId/role` (0102) is the assignment. What has NOT
 * changed is the thing 0039 was actually protecting - `memberships.role`'s
 * five-value CHECK, which `OrgRoleGuard` reads - and neither endpoint writes it.
 */

const UpdateRoleBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const PermissionsBody = z.object({
  grants: z.array(RolePermissionGrant).max(64),
});

@Controller("roles")
@UseGuards(AdminKeyGuard, TenantGuard)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.roles.list(orgId);
  }

  @Post()
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = RoleInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.roles.create(orgId, parsed.data, req.principal?.userId ?? "dev-admin");
  }

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
    return this.roles.update(orgId, id, parsed.data, req.principal?.userId ?? "dev-admin");
  }

  @Get(":id/permissions")
  async permissions(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.roles.permissions(orgId, id);
  }

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
    return this.roles.replacePermissions(
      orgId,
      id,
      parsed.data.grants,
      req.principal?.userId ?? "dev-admin",
    );
  }
}
