import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import { type FeatureOverrides, resolveFeatures } from "@aura/shared";
import { DbService } from "../db/db.service";
import type { PartnerContext, PartnerRequest } from "../modules/partners/partner-context";
import { resolveAdminKey } from "./admin-key.guard";
import { timingSafeStringEqual } from "./timing-safe-equal";

/**
 * A channel partner's credential, and the fence around it (Build docs/39 §17,
 * rule 2).
 *
 * ── WHY THIS DOES NOT SIT BEHIND `AdminKeyGuard` + `TenantGuard` ───────────
 *
 * Every other authenticated controller in the API mounts those two. This one
 * mounts neither, and it is the deliberate choice rather than a shortcut. Three
 * reasons, in order of how badly each would bite:
 *
 *  1. `AdminKeyGuard` writes `req.principal` with `role: "platform_admin"`,
 *     `recordingsListen: true` and `recordingsExport: true`. That object is
 *     read by `principalHasPermission`, `OwnerRoleGuard`, `CrmPermissionsGuard`,
 *     `CallAccessGuard`, `auditActor` and a long tail of handlers. Attaching it
 *     to a broker's request means every one of those now has an opinion about a
 *     person they were never designed to see, and the opinion most of them
 *     reach for a `viaAdminKey` principal is "yes". A partner request therefore
 *     carries NO principal at all; the identity goes in `req.partner`, its own
 *     field, for precisely the reason `req.apiKey` is its own field.
 *
 *  2. `TenantGuard` takes the org from `principal.orgId`, which for an
 *     admin-key request is the `x-org-id` HEADER. A partner must not be able to
 *     name their own tenant - the org is a property of their `partner_users`
 *     row and is read from the database here. Mounting TenantGuard would also
 *     set `req.tenantOrgId`, which is what makes `@OrgId()` work, which is what
 *     would let a portal handler hand an org id straight to `db.withOrg` and
 *     read the whole tenant (see partner-context.ts).
 *
 *  3. The route partition. §17 rule 2 asks for a SIXTH route class beside
 *     tenant / cross-tenant / device / unguarded / internal, and
 *     `guard-mounting.spec.ts` derives "tenant-scoped" from the presence of
 *     `TenantGuard`. A portal route that mounted it would be counted as an
 *     ordinary tenant route and the new class would not exist.
 *
 * It is not a new pattern. `DeviceAuthGuard` and `InternalStreamGuard` are both
 * self-contained principal guards mounted alone, for audiences - a handset, the
 * worker - that are likewise not users of a tenant.
 *
 * ── THE CREDENTIAL ─────────────────────────────────────────────────────────
 *
 * The same one the console uses: `x-admin-key`, held only by the web tier,
 * plus `x-caller-auth-id` - the Supabase subject (`claims.sub`) the portal
 * resolved from a verified `getClaims()` moments earlier. Same "trusted fact"
 * category as it is everywhere else in this codebase: it names WHO is asking
 * and authorizes nothing on its own, because a subject that matches no
 * `partner_users` row denies exactly as an absent header does.
 *
 * `x-caller-auth-id` rather than `x-caller-user-id` on purpose. The subject is
 * what GoTrue actually proved; `users.id` is an internal key, and binding
 * portal access to a value the web tier derived one step further from the
 * verified claim is the weaker of two options for no benefit.
 *
 * ── AND THE FENCE ──────────────────────────────────────────────────────────
 *
 * §17 rule 2 is "a partner principal may reach only /portal/*". Mounting this
 * guard solely on portal controllers satisfies it by construction, but
 * "satisfied by construction" is a property of today's file layout and nothing
 * enforces it. So the guard refuses outright on any path outside `/portal`.
 * Mounting it on, say, a leads controller then produces a 403 on every request
 * rather than a working route that quietly admits a broker - and the spec
 * beside this file pins that behaviour, so the rule is tested rather than
 * merely observed.
 */
@Injectable()
export class PartnerScopeGuard implements CanActivate {
  constructor(private readonly db: DbService) {}

  /**
   * `/portal`, with or without the `v1` prefix `main.ts` adds at bootstrap.
   * Anchored, and `(?:\/|$)` rather than a bare prefix test so a future
   * `/portalsomething` controller cannot inherit portal access by name.
   */
  static readonly PORTAL_PATH = /^\/(?:v\d+\/)?portal(?:\/|$)/;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PartnerRequest>();

    // The fence, before the credential. A misconfigured mount is a deployment
    // bug and should be loud on the very first request, not only on the first
    // request that happens to present a valid partner session.
    const path = (req.path ?? req.url ?? "").split("?")[0] ?? "";
    if (!PartnerScopeGuard.PORTAL_PATH.test(path)) {
      throw new ForbiddenException("PartnerScopeGuard is only mountable on /portal routes");
    }

    const adminKey = resolveAdminKey();
    const presented = firstHeader(req.headers["x-admin-key"]);
    if (adminKey === null || presented === undefined || !timingSafeStringEqual(presented, adminKey)) {
      throw new UnauthorizedException("x-admin-key header required");
    }

    const subject = z.string().uuid().safeParse(firstHeader(req.headers["x-caller-auth-id"]));
    if (!subject.success) {
      throw new UnauthorizedException("x-caller-auth-id header (uuid) required");
    }

    const partner = await this.resolve(subject.data);
    if (!partner) {
      // One message for "no such partner user", "disabled", "suspended" and
      // "you are a member of this workspace, not a partner". A portal that
      // distinguished them would let anybody holding the admin key enumerate
      // which Supabase subjects are partners of which tenant, and none of the
      // four is actionable by the person reading it anyway - they ring whoever
      // invited them either way.
      throw new ForbiddenException("this account has no active partner portal access");
    }

    req.partner = partner;
    return true;
  }

  /**
   * One query, one round trip. The database is in AWS Seoul and the API in
   * Mumbai (~125ms each way), and this runs on EVERY portal request.
   *
   * On the ADMIN pool, which bypasses RLS - necessarily, because this is the
   * step that decides what the row-level context will be, so there is no
   * context to run it under yet. The same reason device enrollment and
   * `AuthService.contextFor` run there. It is bound to one `sso_subject` and
   * returns at most one row.
   *
   * ── THE `NOT EXISTS (memberships)` CLAUSE IS THE DEFINITION ───────────────
   *
   * Doc 39 §18: a partner principal is "has `partner_users`, no
   * `org_memberships`". (The table is `memberships`; this schema has never had
   * one called `org_memberships`.) Migration 0163 makes that pair impossible to
   * create in the first place, with a trigger on each side - but the predicate
   * is restated here rather than assumed, because the cost is one index probe
   * and the failure it guards against is a broker with a console login.
   *
   * ── AND WHY THE STATUS CHECKS ARE IN THE QUERY ────────────────────────────
   *
   * `users.status`, `partner_users.status` and `partners.status` all have to be
   * right, and a suspended partner that came back as a row for the handler to
   * check later is a row somebody eventually forgets to check. Deciding it here
   * means "resolved" and "allowed" are the same event.
   */
  private async resolve(subject: string): Promise<PartnerContext | null> {
    const { rows } = await this.db.adminPool().query<{
      orgId: string;
      orgName: string;
      branding: unknown;
      defaultCountry: string | null;
      baseCurrency: string | null;
      partnerId: string;
      partnerName: string;
      partnerCode: string;
      partnerStatus: string;
      partnerUserId: string;
      partnerRole: string;
      userId: string;
      email: string;
      name: string | null;
      enabledModules: unknown;
      featureOverrides: unknown;
    }>(
      `SELECT o.id            AS "orgId",
              o.name          AS "orgName",
              o.branding      AS "branding",
              bp.country      AS "defaultCountry",
              bp.base_currency AS "baseCurrency",
              o.enabled_modules AS "enabledModules",
              -- The portal's reachability gate (Build docs/40 section A2),
              -- aggregated into the query that was already joining
              -- organizations rather than read by loadOrgFeatures afterwards. A
              -- second lookup would be ~125ms of Seoul flight time on every
              -- portal request. It is spelled out here rather than reusing
              -- loadOrgFeatures because this runs on the ADMIN pool with no RLS
              -- context, so the org predicate has to be explicit - and that
              -- helper's whole design is that RLS has already narrowed both
              -- tables and there is no predicate to get wrong.
              COALESCE(
                (SELECT jsonb_object_agg(f.feature_key, f.enabled)
                   FROM org_feature_settings f
                  WHERE f.org_id = o.id),
                '{}'::jsonb) AS "featureOverrides",
              p.id            AS "partnerId",
              p.name          AS "partnerName",
              p.code          AS "partnerCode",
              p.status        AS "partnerStatus",
              pu.id           AS "partnerUserId",
              pu.role         AS "partnerRole",
              u.id            AS "userId",
              u.email         AS "email",
              u.name          AS "name"
         FROM users u
         JOIN partner_users pu ON pu.user_id = u.id AND pu.status = 'active'
         JOIN partners p       ON p.id = pu.partner_id AND p.org_id = pu.org_id
         JOIN organizations o  ON o.id = pu.org_id
         -- LEFT: 0126's row is created on demand, so an org that has never
         -- opened Time & location has none. The defaults below are the
         -- column defaults, so the portal behaves identically either way.
         LEFT JOIN org_business_profile bp ON bp.org_id = o.id
        WHERE u.sso_subject = $1
          AND u.status = 'active'
          AND p.status = 'active'
          AND o.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM memberships m
             WHERE m.user_id = u.id AND m.org_id = pu.org_id
          )
        ORDER BY pu.created_at ASC
        LIMIT 1`,
      [subject],
    );

    const row = rows[0];
    if (!row) return null;
    return {
      orgId: row.orgId,
      orgName: row.orgName,
      branding: row.branding,
      // 0126's own column defaults, restated for the org that has no row yet.
      defaultCountry: row.defaultCountry ?? "IN",
      baseCurrency: row.baseCurrency ?? "INR",
      partnerId: row.partnerId,
      partnerName: row.partnerName,
      partnerCode: row.partnerCode,
      partnerStatus: row.partnerStatus,
      partnerUserId: row.partnerUserId,
      // The CHECK on partner_users.role admits only these two; narrowed here so
      // the context type is honest rather than `string`.
      partnerRole: row.partnerRole === "owner" ? "owner" : "member",
      userId: row.userId,
      email: row.email,
      name: row.name,
      authUserId: subject,
      // Resolved through the catalogue rather than read as one boolean, because
      // a feature's state is not a property of its own row - `resolveFeatures`
      // also applies the module entitlement and the dependency pass, and an org
      // without the `aura` module must come back `unavailable` rather than "on
      // because nobody overrode it". Same reasoning as `orgHasFeature`.
      portalEnabled:
        resolveFeatures(
          Array.isArray(row.enabledModules) ? (row.enabledModules as string[]) : [],
          (row.featureOverrides ?? {}) as FeatureOverrides,
        ).get("partner_portal")?.state === "on",
    };
  }
}

/** Express lower-cases repeated headers into an array; take the first. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
