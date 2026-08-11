import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { z } from "zod";
import type { PermissionAction, PermissionObjectType } from "@aura/shared";
import type { PrincipalRequest } from "./auth-principal";
import { DbService } from "../db/db.service";

export const CRM_PERMISSION_KEY = "required_crm_permission";

export interface CrmPermissionRequirement {
  objectType: PermissionObjectType;
  action: PermissionAction;
}

/** Mark a route as requiring a `role_permissions` grant (migration 0039). */
export const RequireCrmPermission = (objectType: PermissionObjectType, action: PermissionAction) =>
  SetMetadata(CRM_PERMISSION_KEY, { objectType, action } satisfies CrmPermissionRequirement);

/**
 * Enforces `@RequireCrmPermission(...)` against the `role_permissions` grid that
 * `/roles` edits. Runs AFTER AdminKeyGuard and TenantGuard, so `req.principal`
 * and `req.tenantOrgId` are both set — list it third in `@UseGuards`.
 *
 * WHAT IS TRUSTED, AND WHAT IS NOT. The acting user's IDENTITY comes from the
 * principal: a session's own `user_id`, or the `x-caller-user-id` the web tier
 * asserts on the admin-key path (`admin-key.guard.ts:94`). The GRANT is always
 * read from the database for that identity — never from a header. That is the
 * one deliberate difference from `OwnerRoleGuard`, which believes an asserted
 * persona VALUE outright: here a caller can say who they are, but not what they
 * may do. The admin-key-leak caveat documented at length in admin-key.guard.ts
 * still applies to the identity half and is unchanged by this guard.
 *
 * THE BARE-ADMIN-KEY CARVE-OUT. A caller that presents the admin key and asserts
 * no user at all (seed scripts, ops tooling, the CRM backfill) passes unchecked,
 * exactly as it does through `OwnerRoleGuard`. Those callers have no identity to
 * resolve a role for, and they are the platform's own root-credentialled jobs.
 * Every OTHER outcome denies: an asserted user with no membership in the target
 * org, or with a role whose grid lacks this object/action, gets a 403 rather
 * than being waved through.
 *
 * NULL `role_id` FALLBACK. Migration 0039 backfilled `memberships.role_id` once,
 * and `members.controller.ts` keeps it in sync from here on, but a row written
 * between those two points would have NULL. Rather than 403 a legitimate user
 * over a data gap, the join falls back to matching the legacy `memberships.role`
 * string against `roles.key` — the same correspondence 0039's own backfill used.
 */
@Injectable()
export class CrmPermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<CrmPermissionRequirement | undefined>(
      CRM_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const principal = req.principal;
    if (!principal) {
      // Guard order is wrong — this ran before AdminKeyGuard. Same reasoning
      // (and status) as TenantGuard's equivalent branch: a configuration bug.
      throw new UnauthorizedException("authentication required");
    }

    const userId = z.string().uuid().safeParse(principal.userId);
    if (principal.viaAdminKey && !userId.success) return true;
    if (!userId.success) throw new ForbiddenException(denial(required));

    const orgId = req.tenantOrgId;
    if (!orgId) {
      throw new UnauthorizedException("tenant scope required");
    }

    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query(
        `SELECT 1
           FROM memberships m
           JOIN roles r
             ON r.org_id = m.org_id
            AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
           JOIN role_permissions rp
             ON rp.role_id = r.id AND rp.object_type = $3 AND rp.action = $4
          WHERE m.user_id = $1 AND m.org_id = $2
          LIMIT 1`,
        [userId.data, orgId, required.objectType, required.action],
      ),
    );

    if (rows.length === 0) throw new ForbiddenException(denial(required));
    return true;
  }
}

function denial({ objectType, action }: CrmPermissionRequirement): string {
  return `requires permission: ${action} on ${objectType}`;
}
