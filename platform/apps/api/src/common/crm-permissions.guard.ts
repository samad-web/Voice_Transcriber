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
import {
  PERMISSION_OBJECT_MODULE,
  type PermissionAction,
  type PermissionObjectType,
  ownerRoleSeesAllRecords,
  resolveOwnerRole,
} from "@aura/shared";
import { DbService } from "../db/db.service";
import type { PrincipalRequest } from "./auth-principal";

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
 * PERSONA INTERSECTION (0079). The scope this guard publishes is the grid's
 * grant narrowed by the caller's owner-console persona - a telecaller or sales
 * persona reads `owned` even where the grid granted `all`. See the comment at
 * the assignment below for why the narrowing happens here rather than in each
 * controller. It only ever narrows: no persona can widen a grant, so an org
 * that has never assigned a persona sees exactly what it saw before.
 *
 * MODULE GATE. The query also requires the OBJECT'S OWN module to be present in
 * `organizations.enabled_modules` (migration 0072). The module being off denies
 * exactly like a missing grant does - zero rows, same 403 - which matters once
 * a tenant that previously had CRM (and so still has its `roles`/
 * `role_permissions` rows) gets it toggled off: without this join those rows
 * would keep granting access even though the module is supposed to be off.
 *
 * The module comes from `PERMISSION_OBJECT_MODULE`, not from a literal 'crm'.
 * It WAS a literal, and that was correct while every object in the enum was a
 * CRM object. `lead` (0103) is core Aura, and a hard-coded 'crm' would have
 * taken the lead board away from every recording-only tenant the moment this
 * guard was mounted on the leads controller - the single most damaging
 * regression that change could have shipped. Reading the module off the object
 * makes it unrepresentable rather than merely avoided.
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
      client.query<{ scope: string; owner_role: string | null }>(
        // `ORDER BY scope` puts 'all' before 'owned' alphabetically, and LIMIT 1
        // therefore takes the WIDEST grant when a user somehow holds two. That
        // is the right tie-break: two grants means somebody was given both, and
        // silently applying the narrower one would be a lockout nobody
        // configured. It cannot normally happen - role_permissions is unique on
        // (role, object, action) - but a membership resolving through the
        // legacy `role`-string fallback below can match a second row.
        // `m.owner_role` rides along for the persona intersection below. It
        // costs nothing - the row is already being read - and fetching it
        // separately would have added a second Mumbai→Seoul round trip to
        // every CRM read.
        `SELECT rp.scope, m.owner_role
           FROM memberships m
           JOIN organizations o
             ON o.id = m.org_id AND $5 = ANY(o.enabled_modules)
           JOIN roles r
             ON r.org_id = m.org_id
            AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
           JOIN role_permissions rp
             ON rp.role_id = r.id AND rp.object_type = $3 AND rp.action = $4
          WHERE m.user_id = $1 AND m.org_id = $2
          ORDER BY rp.scope
          LIMIT 1`,
        [
          userId.data,
          orgId,
          required.objectType,
          required.action,
          PERMISSION_OBJECT_MODULE[required.objectType],
        ],
      ),
    );

    if (rows.length === 0) throw new ForbiddenException(denial(required));

    // ── The persona intersection (migration 0079) ───────────────────────
    //
    // The grid says what the ROLE was granted. The persona says which desk the
    // person sits at. Both must hold, and they compose in one direction only:
    // a persona may NARROW a grant, never widen one. So an `all` grant read by
    // a telecaller or a sales persona becomes `owned`, and an `owned` grant
    // stays `owned` no matter who reads it.
    //
    // Why this belongs here rather than in each controller: the controllers
    // already apply `req.crmScope` faithfully via `@RecordScope()` and
    // `scopeFilter()`. Narrowing the value they read means every one of them
    // enforces the persona for free, and - more to the point - a controller
    // added tomorrow enforces it too, without its author having to know the
    // persona model exists. The alternative, a second filter beside the first
    // at every call site, is the shape of thing that gets forgotten once and
    // leaks quietly.
    //
    // `manager` and `marketing` are NOT narrowed. A manager's job is the whole
    // floor's pipeline; a marketer's is the funnel across every source, which
    // narrowed to "records assigned to me" is empty by construction. Both are
    // restricted by OBJECT instead - see nav.ts and the persona guards - which
    // is a different question from scope and is answered elsewhere.
    const gridScope = rows[0].scope === "owned" ? "owned" : "all";
    const persona = resolveOwnerRole(rows[0].owner_role);
    const scope = ownerRoleSeesAllRecords(persona) ? gridScope : "owned";

    // The scope travels on the request because it is a predicate on rows, not
    // a verdict on the request - see crm-scope.ts. Every controller with a
    // @RequireCrmPermission route reads it via @RecordScope().
    req.crmScope = { scope, userId: userId.data };
    return true;
  }
}

function denial({ objectType, action }: CrmPermissionRequirement): string {
  return `requires permission: ${action} on ${objectType}`;
}
