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
 * and `req.tenantOrgId` are both set - list it third in `@UseGuards`.
 *
 * WHAT IS TRUSTED, AND WHAT IS NOT. The acting user's IDENTITY comes from the
 * principal: a session's own `user_id`, or the `x-caller-user-id` the web tier
 * asserts on the admin-key path (`admin-key.guard.ts:94`). The GRANT is always
 * read from the database for that identity - never from a header. That is the
 * one deliberate difference from `OwnerRoleGuard`, which believes an asserted
 * persona VALUE outright: here a caller can say who they are, but not what they
 * may do. The admin-key-leak caveat documented at length in admin-key.guard.ts
 * still applies to the identity half and is unchanged by this guard.
 *
 * NO BARE-ADMIN-KEY CARVE-OUT. A caller that presents the admin key but asserts
 * no user (or an unresolvable one) is DENIED, the same as `OwnerRoleGuard` was
 * hardened to do (see that guard's STAGE 2.5 note). This guard used to grant an
 * UNSCOPED, unfiltered read/write over every contact/account/deal in the org in
 * that case, on the theory that seed scripts and ops tooling needed it - but
 * nothing in this repository actually calls these routes that way (checked:
 * `scripts/backfill-crm-objects.js` writes the database directly and never
 * touches `/v1/contacts`, `/v1/accounts` or `/v1/deals`), and the bypass had a
 * perverse shape besides: OMITTING `x-caller-user-id` granted MORE access than
 * asserting a real-but-unresolvable one, which is backwards. Ops tooling that
 * genuinely needs this surface should assert a real, seeded user id - the same
 * path every other admin-key caller already takes. Every outcome now denies
 * except an asserted user who resolves to a real membership with a matching
 * grant: no user, an empty string, a malformed id, or a well-formed id with no
 * row all reach the same 403 below.
 *
 * NULL `role_id` FALLBACK. Migration 0039 backfilled `memberships.role_id` once,
 * and `members.controller.ts` keeps it in sync from here on, but a row written
 * between those two points would have NULL. Rather than 403 a legitimate user
 * over a data gap, the join falls back to matching the legacy `memberships.role`
 * string against `roles.key` - the same correspondence 0039's own backfill used.
 *
 * MODULE GATE. The query also requires `'crm' = ANY(organizations.enabled_modules)`
 * (migration 0072). CRM being off for an org denies exactly like a missing
 * grant does - zero rows, same 403 - which matters once a tenant that
 * previously had CRM (and so still has its `roles`/`role_permissions` rows)
 * gets it toggled off: without this join those rows would keep granting
 * access even though the module is supposed to be off.
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
      // Guard order is wrong - this ran before AdminKeyGuard. Same reasoning
      // (and status) as TenantGuard's equivalent branch: a configuration bug.
      throw new UnauthorizedException("authentication required");
    }

    const userId = z.string().uuid().safeParse(principal.userId);
    if (!userId.success) throw new ForbiddenException(denial(required));

    const orgId = req.tenantOrgId;
    if (!orgId) {
      throw new UnauthorizedException("tenant scope required");
    }

    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query<{ scope: string }>(
        // `ORDER BY scope` puts 'all' before 'owned' alphabetically, and LIMIT 1
        // therefore takes the WIDEST grant when a user somehow holds two. That
        // is the right tie-break: two grants means somebody was given both, and
        // silently applying the narrower one would be a lockout nobody
        // configured. It cannot normally happen - role_permissions is unique on
        // (role, object, action) - but a membership resolving through the
        // legacy `role`-string fallback below can match a second row.
        `SELECT rp.scope
           FROM memberships m
           JOIN organizations o
             ON o.id = m.org_id AND 'crm' = ANY(o.enabled_modules)
           JOIN roles r
             ON r.org_id = m.org_id
            AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
           JOIN role_permissions rp
             ON rp.role_id = r.id AND rp.object_type = $3 AND rp.action = $4
          WHERE m.user_id = $1 AND m.org_id = $2
          ORDER BY rp.scope
          LIMIT 1`,
        [userId.data, orgId, required.objectType, required.action],
      ),
    );

    if (rows.length === 0) throw new ForbiddenException(denial(required));

    // The scope travels on the request because it is a predicate on rows, not
    // a verdict on the request - see crm-scope.ts. Every controller with a
    // @RequireCrmPermission route reads it via @RecordScope().
    req.crmScope = {
      scope: rows[0].scope === "owned" ? "owned" : "all",
      userId: userId.data,
    };
    return true;
  }
}

function denial({ objectType, action }: CrmPermissionRequirement): string {
  return `requires permission: ${action} on ${objectType}`;
}
