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
import type { PrincipalRequest } from "./auth-principal";
import { AuthService } from "../modules/auth/auth.service";

export const OWNER_ROLE_KEY = "required_owner_role";

/** Mark a route as requiring one of the owner console's personas (design doc §9). */
export const RequireOwnerRole = (...roles: OwnerRole[]) => SetMetadata(OWNER_ROLE_KEY, roles);

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
}
