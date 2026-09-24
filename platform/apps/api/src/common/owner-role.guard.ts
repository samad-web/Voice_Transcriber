import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { z } from "zod";
import { type OwnerRole, resolveOwnerRole } from "@aura/shared";
import { AuthService } from "../modules/auth/auth.service";
import type { PrincipalRequest } from "./auth-principal";

export const OWNER_ROLE_KEY = "required_owner_role";

/** Mark a route as requiring one of the owner console's personas (design doc §9). */
export const RequireOwnerRole = (...roles: OwnerRole[]) => SetMetadata(OWNER_ROLE_KEY, roles);

export const OPERATOR_MAY_CALL_KEY = "owner_role_operator_may_call";

/**
 * Let the platform's own root credential through a persona-gated route.
 *
 * ── WHY THIS EXISTS (doc 31 §2 X8) ───────────────────────────────────────
 *
 * Automation rules, custom-field definitions, analytics and the org audit log
 * were mounted on AdminKeyGuard + TenantGuard and nothing else, because the
 * OPERATOR console is what calls them - and it calls on the bare admin key,
 * which carries no user and therefore no persona. `@RequireOwnerRole` alone
 * would 403 that console on every request (O4 below); leaving the routes
 * unguarded meant any signed-in console user whose request reached them -
 * a telecaller included - could rewrite the org's automation rules.
 *
 * This keeps both halves true: a request with NO user behind it (the literal
 * "admin-key" principal - operator console, ops scripts) passes, exactly as it
 * did before; a request that names a REAL person must hold one of the listed
 * personas, resolved from `memberships` like every other persona check.
 *
 * It widens nothing a bare-key caller could not already do - that credential
 * passes every tenant route that is not OwnerRoleGuard'd, and these were not.
 * It is NOT OperatorOnlyGuard: those routes refuse people outright, while
 * these are org settings an owner may well be given a console page for later
 * (doc 31 §15.3 moves automation into the owner console).
 */
export const OperatorMayCall = () => SetMetadata(OPERATOR_MAY_CALL_KEY, true);

/**
 * Enforces `@RequireOwnerRole(...)`. Runs AFTER AdminKeyGuard, so `req.principal`
 * is set.
 *
 * STAGE 2.5 (checklist 08 §2.5) - CLOSED. This used to trust the caller's OWN
 * claim about its persona (`x-caller-owner-role`, read verbatim by
 * admin-key.guard.ts into `principal.ownerRole`): any admin-key holder could
 * assert `owner` and be believed, or omit the header entirely and be waved
 * through unchecked. It now derives the persona itself from `memberships`
 * (the same table a Bearer session's `ownerRole` already came from, via
 * `principalFromToken` - that path was never the bypass and is unchanged) -
 * see `AuthService.ownerRoleFor`. `admin-key.guard.ts` still parses
 * `x-caller-owner-role` into `principal.ownerRole` for an admin-key caller,
 * but nothing here reads that value anymore; it is only informational.
 */
@Injectable()
export class OwnerRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<OwnerRole[] | undefined>(OWNER_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const principal = req.principal;
    if (!principal) throw new ForbiddenException("owner role required");

    let ownerRole: OwnerRole | null;
    if (principal.viaAdminKey) {
      // Derived from `memberships`, not from anything the request claims.
      // The bare admin key itself (no `x-caller-user-id`, `userId` is the
      // literal string "admin-key") has no row to look up - and correctly
      // so: a credential with no user behind it has no persona to grant.
      const userId = z.string().uuid().safeParse(principal.userId);
      if (!userId.success && this.operatorMayCall(context)) return true;
      const resolved = userId.success
        ? await this.auth.ownerRoleFor(userId.data, principal.orgId)
        : undefined;
      if (resolved === undefined) {
        throw new ForbiddenException(`requires owner role: ${required.join(" or ")}`);
      }
      ownerRole = resolved;
    } else {
      // A session's ownerRole was already read from `memberships` when the
      // token was resolved - authoritative already.
      ownerRole = principal.ownerRole;
    }

    const actual = resolveOwnerRole(ownerRole);
    if (!required.includes(actual)) {
      throw new ForbiddenException(`requires owner role: ${required.join(" or ")}`);
    }
    return true;
  }

  /**
   * Only the admin-key branch consults this: a Bearer session always names a
   * member, so it always gets the persona check whatever the route declares.
   */
  private operatorMayCall(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(OPERATOR_MAY_CALL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}
