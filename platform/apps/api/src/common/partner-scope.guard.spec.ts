import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { PartnersController } from "../modules/partners/partners.controller";
import { PortalController } from "../modules/partners/portal.controller";
import { PortalInvitesController } from "../modules/partners/portal-invites.controller";
import { PartnerScopeGuard } from "./partner-scope.guard";

/**
 * §17's three rules, as far as a unit test can reach them.
 *
 * Rule 3 (the isolation cases) lives in `tests/isolation.test.ts`, which needs
 * a real container. Rules 1 and 2 are structural and are pinned here, because
 * both of them fail SILENTLY: an unmounted guard looks exactly like a route
 * with no boundary, and a partner read that slipped onto `withOrgContext`
 * returns the whole tenant with a 200.
 */

const ADMIN_KEY = "dev-admin-key"; // resolveAdminKey()'s non-production default

type Row = Record<string, unknown>;

/** A fake admin pool: one canned result set, and a record of what was asked. */
function fakeDb(rows: Row[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    service: {
      adminPool: () => ({
        query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          return { rows, rowCount: rows.length };
        },
      }),
    } as never,
  };
}

function contextFor(path: string, headers: Record<string, string>): ExecutionContext {
  const req = { path, url: path, headers } as Record<string, unknown>;
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

const PARTNER_ROW: Row = {
  orgId: "00000000-0000-4000-8000-000000000001",
  orgName: "Tenant A",
  branding: {},
  defaultCountry: "IN",
  baseCurrency: "INR",
  partnerId: "00000000-0000-4000-8000-0000000000b1",
  partnerName: "Arjun Realty",
  partnerCode: "ARJ-01",
  partnerStatus: "active",
  partnerUserId: "00000000-0000-4000-8000-0000000000b2",
  partnerRole: "member",
  userId: "00000000-0000-4000-8000-0000000000b3",
  email: "arjun@example.test",
  name: "Arjun",
};

const SUBJECT = "00000000-0000-4000-8000-0000000000c1";
const headers = (extra: Record<string, string> = {}) => ({
  "x-admin-key": ADMIN_KEY,
  "x-caller-auth-id": SUBJECT,
  ...extra,
});

describe("PartnerScopeGuard", () => {
  let db: ReturnType<typeof fakeDb>;
  let guard: PartnerScopeGuard;

  beforeEach(() => {
    db = fakeDb([PARTNER_ROW]);
    guard = new PartnerScopeGuard(db.service);
  });

  it("admits an active partner and writes req.partner", async () => {
    const ctx = contextFor("/v1/portal/submissions", headers());
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest() as Record<string, unknown>;
    expect((req.partner as { partnerId: string }).partnerId).toBe(PARTNER_ROW.partnerId);
    // The principal stays UNSET. A partner request that carried one would be
    // seen by OwnerRoleGuard, CrmPermissionsGuard, auditActor and everything
    // else that reads `req.principal` - and for a `viaAdminKey` principal most
    // of those answer yes.
    expect(req.principal).toBeUndefined();
    // And no tenant is pinned, so `@OrgId()` throws on these routes rather
    // than handing a handler an org id it could pass to `db.withOrg`.
    expect(req.tenantOrgId).toBeUndefined();
  });

  it("resolves the partner from the database, never from a header", async () => {
    const ctx = contextFor(
      "/v1/portal/context",
      // A caller-chosen org and a caller-chosen partner, both ignored.
      headers({
        "x-org-id": "00000000-0000-4000-8000-00000000dead",
        "x-partner-id": "00000000-0000-4000-8000-00000000beef",
      }),
    );
    await guard.canActivate(ctx);
    const req = ctx.switchToHttp().getRequest() as { partner: { orgId: string; partnerId: string } };
    expect(req.partner.orgId).toBe(PARTNER_ROW.orgId);
    expect(req.partner.partnerId).toBe(PARTNER_ROW.partnerId);
    // One query, one round trip - this runs on every portal request and the
    // database is in Seoul while the API is in Mumbai (doc 39 Part K §13).
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.params).toEqual([SUBJECT]);
  });

  it("binds the lookup to users.sso_subject and excludes anybody with a membership", async () => {
    // The definition of a partner principal is "has partner_users, no
    // memberships" (§18). 0163 makes that pair impossible to create, but the
    // predicate is restated in the query and this is what notices if somebody
    // simplifies it away - at which point a person holding both would resolve
    // to a partner principal and the whole portal boundary would turn on which
    // row sorted first.
    await guard.canActivate(contextFor("/v1/portal/context", headers()));
    const sql = db.calls[0]!.sql.replace(/\s+/g, " ");
    expect(sql).toContain("u.sso_subject = $1");
    expect(sql).toMatch(/NOT EXISTS \( SELECT 1 FROM memberships m/);
    // And every status that can close a portal is decided in the query rather
    // than handed back for a handler to remember to check.
    expect(sql).toContain("u.status = 'active'");
    expect(sql).toContain("p.status = 'active'");
    expect(sql).toContain("o.status = 'active'");
    expect(sql).toContain("pu.status = 'active'");
  });

  it("refuses when the subject matches no active partner", async () => {
    guard = new PartnerScopeGuard(fakeDb([]).service);
    await expect(guard.canActivate(contextFor("/v1/portal/context", headers()))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("refuses without the admin key, and without a subject", async () => {
    await expect(
      guard.canActivate(contextFor("/v1/portal/context", { "x-caller-auth-id": SUBJECT })),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      guard.canActivate(contextFor("/v1/portal/context", { "x-admin-key": ADMIN_KEY })),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      guard.canActivate(contextFor("/v1/portal/context", headers({ "x-caller-auth-id": "not-a-uuid" }))),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("refuses a wrong admin key without consulting the database", async () => {
    await expect(
      guard.canActivate(contextFor("/v1/portal/context", headers({ "x-admin-key": "wrong" }))),
    ).rejects.toThrow(UnauthorizedException);
    expect(db.calls).toHaveLength(0);
  });

  // ── §17 rule 2: a partner may reach ONLY /portal/* ──────────────────────

  describe("the fence", () => {
    for (const path of [
      "/v1/owner/leads",
      "/v1/leads",
      "/v1/calls/123",
      "/v1/reports/commission",
      "/v1/contacts",
      // Named to look like the portal without being it. Anchored matching is
      // what stops a route inheriting portal access by resembling one.
      "/v1/portalsomething",
      "/v1/admin/portal",
      "/portal-x",
    ]) {
      it(`refuses ${path} even with a valid partner credential`, async () => {
        await expect(guard.canActivate(contextFor(path, headers()))).rejects.toThrow(
          ForbiddenException,
        );
        // Before the credential, before the query: a mount in the wrong place
        // is a deployment bug and must be loud on the first request, not only
        // on the first one that happens to carry a real partner session.
        expect(db.calls).toHaveLength(0);
      });
    }

    for (const path of ["/portal", "/v1/portal", "/v1/portal/", "/v1/portal/submissions", "/v2/portal/x"]) {
      it(`admits ${path}`, async () => {
        await expect(guard.canActivate(contextFor(path, headers()))).resolves.toBe(true);
      });
    }

    it("ignores the query string when deciding", async () => {
      await expect(
        guard.canActivate(contextFor("/v1/portal/submissions?limit=10", headers())),
      ).resolves.toBe(true);
    });
  });
});

// ── §17 rule 2, the mounting half ─────────────────────────────────────────
//
// `guard-mounting.spec.ts` is the suite that proves guards are mounted where
// they are supposed to be, and it owns the route-class partition. It cannot
// see this controller until somebody adds it to its CONTROLLERS list, so the
// two assertions that matter most for P4 are made here as well - they are
// cheap, and a boundary that is asserted in only one file is a boundary that
// disappears when that file is being edited.

const guardsOn = (target: unknown): string[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target as object) ?? []).map(
    (g: { name?: string }) => g?.name ?? String(g),
  );

describe("mounting", () => {
  it("mounts PartnerScopeGuard at CLASS level on the portal, and nothing else", () => {
    // Class level, not per handler: §17 rule 2 says the guard goes on the
    // controller class, and a handler-level mount is one new @Get away from a
    // route that forgot it.
    expect(guardsOn(PortalController)).toEqual(["PartnerScopeGuard"]);
  });

  it("does not mount PartnerScopeGuard on the tenant's own partner routes", () => {
    // PartnersController is the CONSOLE's view of the roster. If it ever
    // carried this guard, a tenant's staff would be refused their own screen
    // and a partner would be admitted to it.
    expect(guardsOn(PartnersController)).toEqual([
      "AdminKeyGuard",
      "TenantGuard",
      "CrmPermissionsGuard",
    ]);
  });

  it("leaves the invite routes on the ordinary cross-tenant stack", () => {
    // There is no partner principal yet - the token is what names the org - so
    // these three carry AuthInvitesController's stack, byte for byte.
    expect(guardsOn(PortalInvitesController)).toEqual(["AdminKeyGuard", "TenantGuard"]);
  });
});

// ── §17 rule 1: two helpers, two call sites, no shared setter ─────────────

describe("the partners module never opens a tenant transaction for a partner", () => {
  const MODULE_DIR = join(__dirname, "..", "modules", "partners");

  /**
   * CODE only - block and line comments stripped first.
   *
   * Every file in this module explains at length why it does or does not use
   * `withOrg` and what sets `app.partner_id`, so a grep over raw source
   * matches the prose and fails on files that are doing exactly the right
   * thing. `opt-out.test.ts` strips `--` out of the SQL before matching it for
   * the same reason.
   */
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  const sources = readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
    .map((f) => ({ file: f, text: stripComments(readFileSync(join(MODULE_DIR, f), "utf8")) }));

  it("has source files to check", () => {
    // Non-vacuity. A renamed directory would make every assertion below pass
    // over an empty list, which is the failure mode that makes a grep test
    // worse than no test.
    expect(sources.length).toBeGreaterThanOrEqual(5);
  });

  /**
   * `db.withOrg` IS allowed in this module - it is how a submission reaches
   * the tenant's intake engine, and how the console's own roster is read - but
   * only in the two files that have an argued reason for it. A third file
   * acquiring one is how a portal read ends up running with `app.partner_id`
   * unset, which returns the whole tenant with a 200 and breaks nothing
   * visible.
   */
  const MAY_USE_WITH_ORG = new Set([
    // The console's roster, queue and decisions: ordinary tenant routes.
    "partners.controller.ts",
    // Issue / revoke / accept, none of which has a partner principal.
    "partner-invites.service.ts",
    // The lead write and the vault write, which are acts of the tenant's
    // intake engine - see this file's header in partners.service.ts.
    "partners.service.ts",
  ]);

  for (const { file, text } of sources) {
    if (MAY_USE_WITH_ORG.has(file)) continue;
    it(`${file} does not call withOrg`, () => {
      expect(text).not.toMatch(/\bwithOrg\b/);
    });
  }

  it("the portal controller reaches the database through nothing at all", () => {
    // It has no DbService. Every read goes through PartnersService, which is
    // the single file where the choice between the two contexts is made.
    const portal = sources.find((s) => s.file === "portal.controller.ts")!;
    expect(portal.text).not.toMatch(/DbService/);
    expect(portal.text).not.toMatch(/@OrgId\(/);
  });

  it("withPartnerContext is the only thing that sets app.partner_id", () => {
    // The grep that makes §17 rule 1 true rather than intended. Two call
    // sites would be two places to forget it.
    const setters = sources.filter((s) => s.text.includes("app.partner_id"));
    expect(setters.map((s) => s.file)).toEqual(["partner-context.ts"]);
  });

  it("packages/db still knows nothing about app.partner_id", () => {
    // The other half of rule 1, and the one that would be easiest to undo:
    // adding an optional `partnerId` to `withOrgContext` would make every one
    // of its ~400 call sites a place the setting could be FORGOTTEN, and an
    // omitted optional argument is not a compile error - it is the whole
    // tenant, returned successfully, to a broker.
    const dbIndex = stripComments(
      readFileSync(join(__dirname, "..", "..", "..", "..", "packages", "db", "src", "index.ts"), "utf8"),
    );
    expect(dbIndex).not.toMatch(/partner_id|partnerId/);
  });
});
