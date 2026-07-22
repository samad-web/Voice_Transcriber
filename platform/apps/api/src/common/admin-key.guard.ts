import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Principal, PrincipalRequest } from "./auth-principal";
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
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PrincipalRequest>();

    const adminKey = process.env.ADMIN_API_KEY ?? "dev-admin-key";
    if (req.headers["x-admin-key"] === adminKey) {
      const orgId = Array.isArray(req.headers["x-org-id"])
        ? req.headers["x-org-id"][0]
        : req.headers["x-org-id"];
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
