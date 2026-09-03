import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import { resolveOwnerRole } from "@aura/shared";
import { DbService } from "../db/db.service";
import type { PrincipalRequest } from "./auth-principal";
import { type OwnerRecordScope, OWNER_UNSCOPED, scopeForRole } from "./owner-scope";

/**
 * Resolves the caller's owner-console persona and, for a persona scoped to its
 * own records, the `telecallers` identity those records hang off. Writes the
 * result to `req.ownerScope` for `@OwnerScope()` to read.
 *
 * Mount it AFTER AdminKeyGuard and TenantGuard, so `req.principal` and
 * `req.tenantOrgId` are both set - list it third in `@UseGuards`, beside
 * `OwnerRoleGuard`.
 *
 * ── A GUARD THAT NEVER DENIES ─────────────────────────────────────────────
 *
 * This one always returns true. That reads oddly for a guard, and it is
 * deliberate: `OwnerRoleGuard` answers the yes/no question ("may this persona
 * call this route at all"), and this answers the orthogonal one ("of the rows
 * behind that route, which are theirs"). A scope is a predicate on rows, not a
 * verdict on a request, so there is nothing here to refuse. It is a guard
 * rather than an interceptor for exactly one reason - guards run before the
 * handler's parameters are resolved, which is what lets `@OwnerScope()` be a
 * plain param decorator. `CrmPermissionsGuard` makes the same trade for the
 * same reason.
 *
 * ── WHAT IS TRUSTED ───────────────────────────────────────────────────────
 *
 * The IDENTITY comes from the principal - a session's own `user_id`, or the
 * `x-caller-user-id` the web tier asserts on the admin-key path. The PERSONA
 * is always read from `memberships`, never from `x-caller-owner-role`, which
 * is the header Stage 2.5 (checklist 08 §2.5) closed off and which
 * `admin-key.guard.ts` now keeps only for introspection. A caller may say who
 * they are; it may not say what it is allowed to see.
 *
 * ── THE TWO UNSCOPED FALLBACKS, AND WHY THEY ARE NOT HOLES ────────────────
 *
 * 1. No resolvable user (a bare admin key: `principal.userId` is the literal
 *    string "admin-key"). Unscoped. The admin key is a server-side secret that
 *    already carries org-wide trust everywhere else in the platform -
 *    `principalHasPermission` returns true for it unconditionally - so
 *    narrowing it here would be a lone exception that breaks seed scripts and
 *    ops tooling while protecting nothing a key-holder could not already read.
 *
 * 2. A resolvable user with NO membership row in this org. Unscoped, matching
 *    `resolveOwnerRole(undefined)`'s documented fail-open ("isn't an
 *    owner-console login at all"), and matching the local-dev mode where
 *    DEV_USER_ID may have no membership. Any route that actually cares
 *    declares `@RequireOwnerRole`, and `OwnerRoleGuard` refuses this exact
 *    case with a 403 before the handler runs.
 *
 * Both are consistent with the resolver's existing semantics rather than a new
 * exception invented here - which matters, because a second, different
 * fail-open rule is how the two drift apart.
 *
 * ── COST ──────────────────────────────────────────────────────────────────
 *
 * One extra round trip per owner-console request. That is not free on this
 * deployment (the API is in Mumbai and the database in Seoul - roughly 125ms
 * per flight, see DB_LATENCY_MIGRATION.md), so the membership and the
 * telecaller row are fetched in ONE statement rather than two, and the
 * telecaller half is a LEFT JOIN that costs nothing for the owner/manager
 * personas that will never read it. It cannot be skipped for a persona the
 * caller CLAIMS is unscoped: believing that claim is precisely the bypass
 * Stage 2.5 removed.
 */
@Injectable()
export class OwnerScopeGuard implements CanActivate {
  constructor(private readonly db: DbService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<PrincipalRequest & { ownerScope?: OwnerRecordScope }>();

    const principal = req.principal;
    if (!principal) {
      // Guard order is wrong - this ran before AdminKeyGuard. Same reasoning
      // and status as TenantGuard's equivalent branch: a configuration bug,
      // not a caller error.
      throw new UnauthorizedException("authentication required");
    }

    const orgId = req.tenantOrgId;
    const userId = z.string().uuid().safeParse(principal.userId);

    // Fallback 1 and the cross-tenant routes: nothing to scope by.
    if (!orgId || !userId.success) {
      req.ownerScope = OWNER_UNSCOPED;
      return true;
    }

    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query<{ owner_role: string | null; telecaller_id: string | null }>(
        // `status = 'active'` on the telecaller join, not just a user match: an
        // archived telecaller is a person who has left the desk, and resolving
        // a live console session onto their retired identity would show a new
        // hire the previous holder's leads.
        //
        // ORDER BY puts the org-scope membership first. A person can hold an
        // org-scope row AND workspace-scope rows in the same tenant (see
        // members.controller.ts), and while `owner_role` is written to all of
        // them together today, an unordered LIMIT 1 would silently pick a
        // different row on a different day the moment that stops being true.
        `SELECT m.owner_role, t.id AS telecaller_id
           FROM memberships m
           LEFT JOIN telecallers t
             ON t.org_id = m.org_id AND t.user_id = m.user_id AND t.status = 'active'
          WHERE m.user_id = $1 AND m.org_id = $2
          ORDER BY (m.scope_type = 'org') DESC, m.id
          LIMIT 1`,
        [userId.data, orgId],
      ),
    );

    // Fallback 2 - see the header.
    if (rows.length === 0) {
      req.ownerScope = OWNER_UNSCOPED;
      return true;
    }

    const role = resolveOwnerRole(rows[0].owner_role);
    req.ownerScope = {
      role,
      scope: scopeForRole(role),
      userId: userId.data,
      telecallerId: rows[0].telecaller_id,
    };
    return true;
  }
}
