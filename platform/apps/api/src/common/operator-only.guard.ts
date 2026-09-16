import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import type { PrincipalRequest } from "./auth-principal";

/**
 * Routes that belong to the PLATFORM OPERATOR, never to a tenant's own console.
 *
 * ── THE GAP THIS CLOSES ───────────────────────────────────────────────────
 *
 * `InstancesController` mints enrollment tokens, and an enrollment token lets
 * whoever holds it put a device into that tenant. It carried
 * `AdminKeyGuard + TenantGuard` and nothing else, so its only protection was
 * that no owner-console code path happened to call it. That is not a boundary,
 * it is an absence of traffic - and migration 0107 added a client-facing
 * pairing surface, which is exactly the moment somebody would be tempted to
 * reuse these routes from the console.
 *
 * ── WHY NEITHER EXISTING GUARD FITS ───────────────────────────────────────
 *
 * `OrgRoleGuard` returns true for ANY `viaAdminKey` caller, and every
 * owner-console request arrives on the platform admin key (the web tier holds
 * it server-side and proxies). Mounting it here would be inert.
 *
 * `OwnerRoleGuard` derives the persona from `memberships` and would work for a
 * console user - but it correctly refuses the BARE admin key, which has no user
 * behind it and therefore no persona. That is precisely the credential the
 * operator console and the ops scripts use, so mounting it would break the
 * people these routes exist for.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 *
 * Any request carrying a REAL USER identity is refused; only the platform's own
 * root credential, which has no user behind it, passes. That covers both shapes
 * a person can arrive in: an owner-console request (the web tier proxies on the
 * admin key and adds `x-caller-user-id`, which `ownerHeaders()` always sends and
 * the operator's `orgHeaders(orgId)` never does), and a direct Bearer session,
 * whose principal carries the user id it was resolved from.
 *
 * The operator console is unaffected because it does not act as a person here:
 * it sends the admin key with an org header and no caller, exactly as the ops
 * scripts do.
 *
 * Deliberately a denial and not a persona check. There is no owner who SHOULD
 * reach these routes - a client pairing a handset has `/owner/devices` (0107),
 * which is gated on a per-person capability and issues a narrower token. If a
 * genuinely owner-facing instance route is ever wanted, it should be added to
 * an owner-scoped controller rather than by widening this one, and this guard
 * failing closed is what forces that decision to be made out loud.
 */
@Injectable()
export class OperatorOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const principal = req.principal;
    if (!principal) {
      // Guard order is wrong - this ran before AdminKeyGuard. Same reasoning
      // and status as TenantGuard's equivalent branch.
      throw new UnauthorizedException("authentication required");
    }

    // `admin-key.guard.ts` writes the literal string "admin-key" when no caller
    // header is present, so a uuid here means a real person asked - either a
    // console user the web tier is proxying for, or a Bearer session.
    const consoleUser = z.string().uuid().safeParse(principal.userId);
    if (consoleUser.success) {
      throw new ForbiddenException(
        "this is a platform operator endpoint - use the handset pairing page in your console",
      );
    }
    return true;
  }
}
