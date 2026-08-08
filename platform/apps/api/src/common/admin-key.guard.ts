import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import { OwnerRole } from "@aura/shared";
import type { Principal, PrincipalRequest } from "./auth-principal";
import { OrgRegistryService } from "./org-registry.service";
import { AuthService } from "../modules/auth/auth.service";

/**
 * The admin key this process will accept, or null when there is none.
 *
 * The dev literal is a convenience for `pnpm dev` and nothing else, so it only
 * exists outside production (checklist 08 §0.2). In production an unset or empty
 * ADMIN_API_KEY yields null and every admin-key request is rejected, instead of
 * silently falling back to a string published in this repository — which would
 * be a root credential for every tenant on the open internet. `config/assert-env`
 * already refuses to boot in that state; this is the second line, so the hole
 * cannot reappear via a code path that skips bootstrap.
 *
 * Empty counts as unset: `x-admin-key:` with no value arrives as "" and `??`
 * alone would happily match it against an empty ADMIN_API_KEY.
 */
export function resolveAdminKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.ADMIN_API_KEY?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "production") return null;
  return "dev-admin-key";
}

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

    const adminKey = resolveAdminKey();
    if (adminKey !== null && firstHeader(req.headers["x-admin-key"]) === adminKey) {
      const orgId = firstHeader(req.headers["x-org-id"]);

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

      // The web server is the only holder of the admin key, so these two
      // caller-asserted headers don't cross a trust boundary — they carry
      // forward a fact (the signed-in owner's own identity/persona) it
      // already resolved server-side moments earlier, via /v1/auth/context.
      // Absent (any caller that hasn't been updated: seed scripts, ops
      // tooling) falls back to today's behaviour untouched.
      //
      // SECURITY (08 §2.5): these two headers make owner-role enforcement
      // ADVISORY, not enforced. The principal's persona is whatever the caller
      // says it is, and OMITTING x-caller-owner-role leaves ownerRole null,
      // which OwnerRoleGuard treats as "unchecked, pass" (owner-role.guard.ts).
      // So any holder of the admin key — which is the whole platform's root
      // credential — bypasses every @RequireOwnerRole by simply not sending a
      // header, and can equally claim `owner` on a request the real user is
      // only a `viewer` for. The premise "the web server is the only holder of
      // the admin key" is the entire trust boundary; it is one leaked env var
      // from being false, and 08 §0.2/§0.3 exist because that has to be assumed.
      // Fixing it means the API resolving the caller's persona itself from the
      // session/OIDC subject rather than accepting it as a header. NOT changed
      // here: apps/web sends these headers today and every owner route depends
      // on the null-means-pass behaviour (see server-api.ts Caller).
      const callerUserId = z.string().uuid().safeParse(firstHeader(req.headers["x-caller-user-id"]));
      const callerOwnerRole = OwnerRole.safeParse(firstHeader(req.headers["x-caller-owner-role"]));

      req.principal = {
        userId: callerUserId.success ? callerUserId.data : "admin-key",
        orgId: orgId ?? "",
        role: "platform_admin",
        recordingsListen: true,
        recordingsExport: true,
        viaAdminKey: true,
        ownerRole: callerOwnerRole.success ? callerOwnerRole.data : null,
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

/** Express lower-cases repeated headers into an array; every header read here wants the first value. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
