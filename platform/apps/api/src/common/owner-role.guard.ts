import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type OwnerRole, resolveOwnerRole } from "@aura/shared";
import type { PrincipalRequest } from "./auth-principal";

export const OWNER_ROLE_KEY = "required_owner_role";

/** Mark a route as requiring one of the owner console's personas (design doc §9). */
export const RequireOwnerRole = (...roles: OwnerRole[]) => SetMetadata(OWNER_ROLE_KEY, roles);

/**
 * Enforces `@RequireOwnerRole(...)`. Runs AFTER AdminKeyGuard, so `req.principal`
 * is set.
 *
 * A bare admin-key caller that never asserted a persona (`viaAdminKey` true,
 * `ownerRole` null — seed scripts, ops tooling, anything not yet updated to
 * send `x-caller-owner-role`) keeps today's behaviour and passes unchecked.
 * Enforcement only activates once a caller actually names a persona, which
 * every real owner-console request does (see apps/web/lib/owner-context.ts).
 */
@Injectable()
export class OwnerRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<OwnerRole[] | undefined>(OWNER_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const principal = req.principal;
    if (!principal) throw new ForbiddenException("owner role required");

    // SECURITY (08 §2.5): this line is the bypass. `ownerRole` is populated in
    // admin-key.guard.ts purely from the caller-supplied `x-caller-owner-role`
    // header, so an admin-key caller that omits it lands here with null and is
    // waved through EVERY @RequireOwnerRole check on the platform. The same
    // caller can also just assert `owner` and be believed. Role enforcement is
    // therefore advisory: it constrains the web tier, which volunteers the
    // header, and constrains nothing else. Removing this line is not the fix —
    // it would break seed scripts and ops tooling while still trusting a header.
    // The fix is for the API to derive the persona server-side from the
    // authenticated subject (memberships.owner_role, migration 0018) instead of
    // reading it off the request. Behaviour deliberately UNCHANGED here.
    if (principal.viaAdminKey && principal.ownerRole == null) return true;

    const actual = resolveOwnerRole(principal.ownerRole);
    if (!required.includes(actual)) {
      throw new ForbiddenException(`requires owner role: ${required.join(" or ")}`);
    }
    return true;
  }
}
