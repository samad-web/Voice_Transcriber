import { createHash } from "node:crypto";
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type ApiScope, hasScope } from "@aura/shared";
import { DbService } from "../db/db.service";
import type { PrincipalRequest } from "./auth-principal";

export const API_SCOPE_KEY = "api_scope";

/**
 * The scope a route requires. Mounted per-handler, never per-controller, so
 * adding a route to an existing controller cannot inherit an unexamined grant.
 */
export const RequireScope = (scope: ApiScope) => SetMetadata(API_SCOPE_KEY, scope);

interface KeyRow {
  id: string;
  org_id: string;
  scopes: string[];
  org_status: string | null;
}

/**
 * Authenticates an external integration by its API key, and enforces the scope
 * the route declares.
 *
 * ── HOW THIS DIFFERS FROM AdminKeyGuard, AND WHY IT MUST ──────────────────
 *
 * AdminKeyGuard authenticates the PLATFORM: one shared secret, cross-tenant by
 * design, which takes its tenant from `x-org-id` because choosing a tenant is
 * its job. It grants `platform_admin`, for which `principalHasPermission`
 * short-circuits to true.
 *
 * This guard authenticates a TENANT'S OWN integration, and inverts all three
 * of those properties:
 *
 *  1. THE ORG COMES FROM THE KEY. `x-org-id` is never read. There is no header
 *     - none - that can move an API-key request to another tenant, because the
 *     org is a column on the row the key hashes to. This is the single most
 *     important line in the file: an integration credential that could name its
 *     own tenant would be a cross-tenant read primitive handed to a third party.
 *
 *  2. IT IS NOT A PERSON. The principal is written with role `viewer` and both
 *     recording permissions FALSE, so `principalHasPermission` returns false for
 *     `recordings:listen` and `recordings:export` - a headless credential can
 *     never reach call audio or transcripts, whatever route it finds. Authority
 *     comes from `req.apiKey.scopes`, checked here, not from the CRM grid.
 *
 *  3. IT EXPIRES AND CAN BE REVOKED, and both are checked in the lookup rather
 *     than after it, so a revoked key cannot be authenticated and then refused
 *     later by something a future route forgets to call.
 *
 * ── WHY THE ADMIN POOL ────────────────────────────────────────────────────
 *
 * `api_keys` is FORCE RLS'd on `app.org_id` (0076), and this lookup has to
 * establish WHICH org the request belongs to before any org context can exist.
 * Same bootstrap the Meta webhook performs when it resolves an org from a
 * page_id before calling withOrg. The query is narrowed by the key hash - a
 * value the caller must already possess - and returns exactly one row.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly db: DbService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const presented = extractKey(req);
    if (!presented) {
      throw new UnauthorizedException("Authorization: Bearer <api key>, or x-api-key, is required");
    }

    // sha256 of the raw key, matching how apikeys.controller.ts stores it.
    // Looked up by hash and not by prefix: the prefix is a display aid shown in
    // the console and is NOT secret.
    const keyHash = createHash("sha256").update(presented).digest("hex");

    const {
      rows: [key],
    } = await this.db.adminPool().query<KeyRow>(
      `SELECT k.id, k.org_id, k.scopes, o.status AS org_status
         FROM api_keys k
         JOIN organizations o ON o.id = k.org_id
        WHERE k.key_hash = $1
          AND k.revoked_at IS NULL
          AND (k.expires_at IS NULL OR k.expires_at > now())`,
      [keyHash],
    );

    // One message for "no such key", "revoked", "expired" and "suspended org".
    // Distinguishing them tells an attacker which of their guesses was once
    // real, and the holder of a legitimately revoked key learns nothing useful
    // from the difference either - they need to talk to the tenant regardless.
    if (!key || key.org_status !== "active") {
      throw new UnauthorizedException("invalid or expired API key");
    }

    const required = this.reflector.get<ApiScope | undefined>(API_SCOPE_KEY, context.getHandler());

    // A route with no declared scope is a bug, not a public route. Refusing
    // here means forgetting `@RequireScope` fails closed - the opposite of the
    // default where an un-annotated handler quietly accepts every key.
    if (!required) {
      throw new ForbiddenException("route declares no API scope");
    }

    if (!hasScope(key.scopes, required)) {
      await this.record(key, req, "forbidden_scope", { required });
      throw new ForbiddenException(`this API key lacks the '${required}' scope`);
    }

    req.apiKey = { id: key.id, orgId: key.org_id, scopes: key.scopes };
    req.principal = {
      userId: `api-key:${key.id}`,
      orgId: key.org_id,
      // Least privilege, and never platform_admin: `principalHasPermission`
      // short-circuits to true for that role, which would hand a partner's
      // credential every recording in the tenant.
      role: "viewer",
      recordingsListen: false,
      recordingsExport: false,
      viaAdminKey: false,
      ownerRole: null,
      // An API key is a headless credential belonging to a tenant, never to a
      // platform operator - so there is no operator to name, and the
      // call-access gate treats it as it treats any other non-operator.
      operatorEmail: null,
    };

    // TenantGuard reads `principal.orgId`, so the org this request is pinned to
    // is the key's own - never anything the caller sent.
    req.headers["x-org-id"] = key.org_id;

    void this.touch(key.id);
    return true;
  }

  /** Last-used tracking. Best effort: a failed write must never fail a request. */
  private async touch(keyId: string): Promise<void> {
    try {
      await this.db
        .adminPool()
        .query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [keyId]);
    } catch {
      /* observability, not correctness */
    }
  }

  private async record(
    key: KeyRow,
    req: PrincipalRequest,
    status: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.adminPool().query(
        `INSERT INTO api_key_events (org_id, api_key_id, channel, operation, status, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          key.org_id,
          key.id,
          req.path?.startsWith("/v1/mcp") ? "mcp" : "rest",
          `${req.method} ${req.path}`,
          status,
          JSON.stringify(detail),
        ],
      );
    } catch {
      /* a refusal that cannot be logged is still a refusal */
    }
  }
}

/**
 * `Authorization: Bearer <key>` or `x-api-key: <key>`.
 *
 * Bearer is rejected for values starting `aus_`, which is the USER SESSION
 * prefix AdminKeyGuard consumes. Without that check a session token presented
 * here would be sha256'd, match nothing, and return "invalid API key" - a
 * confusing 401 for what is actually a valid credential on the wrong door.
 */
function extractKey(req: PrincipalRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const value = header.slice("Bearer ".length).trim();
    if (value && !value.startsWith("aus_")) return value;
  }
  const raw = req.headers["x-api-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || null;
}
