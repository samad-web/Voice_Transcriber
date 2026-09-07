import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import {
  PermissionAction,
  PermissionObjectType,
  RoleInput,
  RolePermissionGrant,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { RolesService } from "../roles/roles.service";

const UpdateRoleBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const PermissionsBody = z.object({
  grants: z.array(RolePermissionGrant).max(64),
});

/**
 * Roles & permissions, the CLIENT's own surface - the second tab of the Staff
 * section.
 *
 * ── WHY THIS IS NOT JUST `/v1/roles` WITH A DIFFERENT URL ───────────────────
 *
 * `/v1/roles` is gated by `OrgRoleGuard`, which reads `memberships.role`. Every
 * owner-console request reaches the API on the platform admin key, and
 * `admin-key.guard.ts` mints that as `platform_admin` - so `OrgRoleGuard`
 * passes for a telecaller exactly as it does for an owner. Pointing the client
 * console at `/v1/roles` would therefore have let anybody with a login rewrite
 * the permission grid, which is the same trap `/v1/org/policy` fell into and
 * that the transcription page had to work around in its server action.
 *
 * `OwnerRoleGuard` is the fix, and it is real enforcement: it resolves the
 * persona from `memberships` itself rather than believing the
 * `x-caller-owner-role` header the same caller supplied.
 *
 * ── THIS PAGE MUST NEVER BE GATED BY THE GRID IT EDITS ──────────────────────
 *
 * There is no `@RequireCrmPermission` here, and that is deliberate rather than
 * an omission. `CrmPermissionsGuard` denies whatever it finds no grant for, so
 * a role saved with an empty grid - one mis-click on a matrix of forty
 * checkboxes - would take away the CRM. If the page that repairs it were
 * itself behind the grid, the repair would be impossible from inside the
 * console and would need an operator with a SQL prompt.
 *
 * Same class of refusal as `guardLastOwner` and as the locked features in
 * `features.ts`: an administrative surface must not be able to lock its own
 * door from the inside.
 */
@Controller("owner/roles")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class OwnerRolesController {
  constructor(private readonly roles: RolesService) {}

  /**
   * Every role, its grants and how many people hold it.
   *
   * Owner AND manager, matching the Team roster next door: a manager needs to
   * be able to answer "why can Priya not export contacts" without waiting for
   * the account holder. Only an owner changes it.
   *
   * The object/action vocabulary rides along so the matrix's axes come from the
   * API rather than from a copy in the web bundle. A checkbox for an object the
   * API does not know about writes a grant that nothing will ever read.
   */
  @Get()
  @RequireOwnerRole("owner", "manager")
  async list(@OrgId() orgId: string) {
    const { roles } = await this.roles.list(orgId);
    return {
      roles,
      objectTypes: PermissionObjectType.options,
      actions: PermissionAction.options,
    };
  }

  @Post()
  @RequireOwnerRole("owner")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = RoleInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.roles.create(orgId, parsed.data, req.principal?.userId ?? "unknown");
  }

  @Patch(":id")
  @RequireOwnerRole("owner")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdateRoleBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.roles.update(orgId, id, parsed.data, req.principal?.userId ?? "unknown");
  }

  /**
   * Replace a role's whole grant set.
   *
   * A SYSTEM role's grid is editable here, and that is intentional - it is what
   * "roles & permissions" means to the business that bought this, and 0039's
   * own operator endpoint has always allowed it. What stays fixed is a system
   * role's identity (its key and `is_system`), because the tenant seed and the
   * `role_id` backfill both assume those five rows exist with those exact keys.
   */
  @Put(":id/permissions")
  @RequireOwnerRole("owner")
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
      req.principal?.userId ?? "unknown",
    );
  }

  @Delete(":id")
  @RequireOwnerRole("owner")
  async remove(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.roles.remove(orgId, id, req.principal?.userId ?? "unknown");
  }
}
