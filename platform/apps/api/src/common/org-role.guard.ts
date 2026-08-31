import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Principal, PrincipalRequest } from "./auth-principal";

export const ORG_ROLE_KEY = "required_org_role";

/**
 * Mark a route as an org-administration action - one only an `org_admin` (or
 * the platform's own root credential) may take. Distinct from
 * `@RequireCrmPermission`, which checks a role's `role_permissions` grant on
 * a CRM record; this checks `principal.role` directly, for routes that are
 * not CRM records at all: who else may act as this org, what an org's policy
 * is, whether a device gets wiped, whether GDPR/DPDP erasure runs.
 */
export const RequireOrgRole = (...roles: Principal["role"][]) => SetMetadata(ORG_ROLE_KEY, roles);

/**
 * Enforces `@RequireOrgRole(...)`. Runs AFTER AdminKeyGuard and TenantGuard -
 * list it third in `@UseGuards`, same position as CrmPermissionsGuard/
 * OwnerRoleGuard.
 *
 * WHY THIS GUARD EXISTS. `TenantGuard` only checks that a caller belongs to
 * the org - it has no notion of what role they hold within it. Before this
 * guard, routes like `PATCH /v1/members/:userId` let ANY member - a
 * freshly-invited `viewer` included - set any membership's `role` to
 * `org_admin`, including their own, with nothing downstream ever reading
 * `principal.role`. Same shape on API-key minting, org policy/branding,
 * a role's own permission grid, device wipe/logout, workspace creation and
 * GDPR/DPDP erasure - all previously AdminKeyGuard+TenantGuard only.
 * `13_ROUTE_AND_GUARD_INVENTORY.md` catalogued the pattern; this closes it
 * on the routes where "any tenant member" has no defensible product reading
 * (compare `pipelines`/`custom-field-definitions`/`automation`/`merge`,
 * which stay member-accessible on purpose - see PermissionObjectType's own
 * header in packages/shared/src/permissions.ts. Those are org
 * CONFIGURATION; the routes this guard covers are org ADMINISTRATION).
 *
 * `principal.role` needs no further DB read to trust here: for a session it
 * was loaded moments earlier from `memberships.role` in
 * `AuthService.principalFromToken`, and for an admin-key caller
 * `admin-key.guard.ts` sets it to the literal `"platform_admin"` - the same
 * bypass `principalHasPermission` already grants `viaAdminKey`/
 * `platform_admin` elsewhere. The admin key is the platform's own root
 * credential, not a tenant role, and ops tooling/scripts using it must keep
 * working.
 */
@Injectable()
export class OrgRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Principal["role"][] | undefined>(ORG_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const principal = req.principal;
    if (!principal) {
      // Guard order is wrong - this ran before AdminKeyGuard. Same reasoning
      // (and status) as TenantGuard's/CrmPermissionsGuard's equivalent branch.
      throw new UnauthorizedException("authentication required");
    }

    if (principal.viaAdminKey || principal.role === "platform_admin") return true;
    if (!required.includes(principal.role)) {
      throw new ForbiddenException(`requires org role: ${required.join(" or ")}`);
    }
    return true;
  }
}
