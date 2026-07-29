import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import type { Principal, PrincipalRequest } from "./auth-principal";
import { OrgRegistryService } from "./org-registry.service";
import { AuthService } from "../modules/auth/auth.service";

/**
 * Platform request auth. Accepts EITHER:
 *  - the dev `x-admin-key` header → a synthetic platform_admin principal (all
 *    permissions), org taken from `x-org-id` (bootstrap / service access), or
 *  - a real user session (`Authorization: Bearer aus_...`) → the user's role +
 *    permissions, with `x-org-id` FORCED to the session's org so a session can
 *    never act outside its tenant.
 *
 * Either way it populates `req.principal` and leaves a valid `x-org-id` header
 * so existing controllers keep resolving the org via `orgIdFromHeader`.
 * Swapping the dev login for OIDC later changes only how the session is minted.
 */
@Injectable()
export class AdminKeyGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly orgs: OrgRegistryService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PrincipalRequest>();

    const adminKey = process.env.ADMIN_API_KEY ?? "dev-admin-key";
    if (req.headers["x-admin-key"] === adminKey) {
      const orgId = Array.isArray(req.headers["x-org-id"])
        ? req.headers["x-org-id"][0]
        : req.headers["x-org-id"];

      // The admin key is a cross-tenant credential, so `x-org-id` picks the
      // tenant and is trusted. Trusted is not the same as unchecked: an id that
      // names no org would otherwise pass into withOrg and come back as an
      // empty-but-successful read, which reads as "no data" rather than "wrong
      // id". Only validated when present — the cross-tenant admin endpoints
      // legitimately send no org header at all.
      if (orgId !== undefined && z.string().uuid().safeParse(orgId).success) {
        if (!(await this.orgs.exists(orgId))) {
          throw new NotFoundException(`no organization with id ${orgId}`);
        }
      }

      req.principal = {
        userId: "admin-key",
        orgId: orgId ?? "",
        role: "platform_admin",
        recordingsListen: true,
        recordingsExport: true,
        viaAdminKey: true,
      };
      return true;
    }

    const header = req.headers.authorization;
    if (header?.startsWith("Bearer aus_")) {
      const principal = await this.auth.principalFromToken(header.slice("Bearer ".length));
      if (principal) {
        // Pin the request to the session's org — ignore any client-supplied header.
        req.headers["x-org-id"] = principal.orgId;
        req.principal = principal as Principal;
        return true;
      }
    }

    throw new UnauthorizedException("x-admin-key header or a valid session bearer token required");
  }
}
