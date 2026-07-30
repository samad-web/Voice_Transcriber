import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  InternalServerErrorException,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { z } from "zod";
import type { PrincipalRequest } from "./auth-principal";

export const CROSS_TENANT_KEY = "cross_tenant";

/**
 * Marks a route (or controller) as spanning every tenant, so no org is pinned.
 *
 * This is the ONLY way out of tenant scoping, and it is deliberately explicit:
 * the default is that a request belongs to exactly one tenant, and a route that
 * wants otherwise has to say so at the point where someone reviewing it will
 * see it. Reserved for the operator surface that genuinely has no single org —
 * provisioning the first tenant, listing tenants, the fleet rollup, resolving a
 * login's memberships — all of which run on the RLS-bypassing admin pool.
 */
export const CrossTenant = () => SetMetadata(CROSS_TENANT_KEY, true);

/**
 * Pins each request to one tenant, or rejects it.
 *
 * Before this guard, every handler resolved its own org by reading the
 * `x-org-id` header through `orgIdFromHeader`. That put the tenant boundary in
 * ~70 hand-written places and made "the handler forgot to scope itself" a
 * silent bug rather than a compile error — the failure mode being a query that
 * runs under the wrong `app.org_id`, or none.
 *
 * Now the org is resolved once, from the authenticated principal, and handlers
 * receive it through `@OrgId()`. Two paths, matching the two kinds of caller:
 *
 *   session principal — the org is the session's own. `AdminKeyGuard` has
 *     already overwritten any client-supplied header with it, so a session can
 *     never act outside its tenant no matter what the request claims.
 *   admin-key principal — the operator legitimately acts across tenants, so the
 *     header picks the org. `AdminKeyGuard` has already checked that it names a
 *     real one; this guard only enforces that it is present and well-formed.
 *
 * Runs after `AdminKeyGuard` — list it second in `@UseGuards`. RLS remains the
 * last line of defence underneath all of this, not the only one.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<PrincipalRequest>();

    const crossTenant = this.reflector.getAllAndOverride<boolean | undefined>(CROSS_TENANT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (crossTenant) {
      // Leave it unset rather than falsy-but-present: `@OrgId()` then fails
      // loudly if such a route ever asks for a tenant, instead of scoping a
      // query to "".
      req.tenantOrgId = undefined;
      return true;
    }

    const principal = req.principal;
    if (!principal) {
      // Guard order is wrong — TenantGuard ran before the auth guard. A
      // configuration bug, not a client one.
      throw new UnauthorizedException("authentication required");
    }

    const parsed = z.string().uuid().safeParse(principal.orgId);
    if (!parsed.success) {
      // Same message and status the old orgIdFromHeader raised: for the
      // admin-key path this IS a missing/!malformed header.
      throw new BadRequestException("x-org-id header (uuid) required");
    }

    req.tenantOrgId = parsed.data;
    return true;
  }
}

/**
 * The tenant this request belongs to. Replaces
 * `@Headers("x-org-id") h` + `orgIdFromHeader(h)` in every handler.
 *
 * Throws rather than returning undefined when the org is unset, because the
 * only ways that happens are programming errors — the route is missing
 * `TenantGuard`, or it is `@CrossTenant()` and should not be asking.
 */
export const OrgId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<PrincipalRequest>();
  const orgId = req.tenantOrgId;
  if (!orgId) {
    throw new InternalServerErrorException(
      "@OrgId() on a route without TenantGuard, or on a @CrossTenant() route",
    );
  }
  return orgId;
});
