/**
 * `AdminKeyGuard` - the platform's front door (inventory 13 §2.1, cases A1-A15).
 *
 * Every case below is the REAL guard class with only its two injected
 * dependencies faked. `AuthService` is faked because the alternative is a
 * database; `OrgRegistryService` because its one method is a `SELECT 1` on the
 * admin pool. Faking the guard itself would prove nothing.
 *
 * Three cases here pin live security properties and are called out inline:
 *   · the Stage 0.2 production fix (`resolveAdminKey` → null),
 *   · session org-pinning (proved by hand 2026-07-29, untested since),
 *   · the trusted `x-caller-*` headers (the Stage 2.5 gap).
 */
import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AuthService } from "../modules/auth/auth.service";
import { AdminKeyGuard, resolveAdminKey } from "./admin-key.guard";
import { OrgRegistryService } from "./org-registry.service";
import {
  ORG_A,
  ORG_B,
  USER_A,
  USER_B,
  expectHttpError,
  makeExecutionContext,
  sessionPrincipal,
} from "./guard-harness.spec";

const DEV_KEY = "dev-admin-key";
const UNAUTHORIZED_MESSAGE = "x-admin-key header or a valid session bearer token required";

/** The session fixture: the header is `Bearer aus_test_token` and the stored hash
 *  is sha256 of the WHOLE token including the `aus_` prefix (auth.service.ts:40). */
const SESSION_TOKEN = "aus_test_token";
const SESSION_HEADER = `Bearer ${SESSION_TOKEN}`;

describe("resolveAdminKey", () => {
  // Takes an explicit env, so this table needs no process.env surgery at all.
  const cases: Array<[string, NodeJS.ProcessEnv, string | null]> = [
    [
      "a configured key wins in production",
      { ADMIN_API_KEY: "real-key", NODE_ENV: "production" },
      "real-key",
    ],
    [
      "a configured key is trimmed",
      { ADMIN_API_KEY: "  real-key  ", NODE_ENV: "development" },
      "real-key",
    ],
    // Stage 0.2: the dev literal is published in this repository, so in
    // production it must never be the fallback - null can match no header.
    ["unset + production is null", { NODE_ENV: "production" }, null],
    ["empty + production is null", { ADMIN_API_KEY: "", NODE_ENV: "production" }, null],
    [
      "whitespace-only + production is null",
      { ADMIN_API_KEY: "   ", NODE_ENV: "production" },
      null,
    ],
    ["unset + test keeps the dev literal", { NODE_ENV: "test" }, DEV_KEY],
    ["unset + no NODE_ENV keeps the dev literal", {}, DEV_KEY],
    ["empty + development keeps the dev literal", { ADMIN_API_KEY: "" }, DEV_KEY],
    // The whitespace-only case has to be asserted on BOTH sides of the
    // NODE_ENV branch: `.trim()` is what makes `ADMIN_API_KEY="   "` count as
    // unset, and a regression that dropped it would return "   " here (an
    // unmatchable key that looks configured) while still returning null in
    // production - so the production row alone would not catch it.
    [
      "whitespace-only + test keeps the dev literal",
      { ADMIN_API_KEY: "   ", NODE_ENV: "test" },
      DEV_KEY,
    ],
  ];

  it.each(cases)("%s", (_name, env, expected) => {
    expect(resolveAdminKey(env)).toBe(expected);
  });
});

describe("AdminKeyGuard", () => {
  const auth = { principalFromToken: jest.fn() };
  const orgs = { exists: jest.fn() };
  let guard: AdminKeyGuard;

  // `canActivate` calls `resolveAdminKey()` with no argument, so these cases
  // DO read process.env. Snapshot and restore around every one of them, and
  // delete ADMIN_API_KEY explicitly: a runner or CI shell that exports it would
  // otherwise fail this whole file with no defect present (report 12 §5.6
  // records exactly that failure mode for pipeline.test.ts).
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ADMIN_API_KEY;
    process.env.NODE_ENV = "test";
    auth.principalFromToken.mockReset().mockResolvedValue(null);
    orgs.exists.mockReset().mockResolvedValue(true);
    guard = new AdminKeyGuard(
      auth as unknown as AuthService,
      orgs as unknown as OrgRegistryService,
    );
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("is constructible through Nest DI with both dependencies injected", async () => {
    // Pins the constructor contract: a reordered or added dependency breaks
    // here rather than at boot, on production, on the first request.
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminKeyGuard,
        { provide: AuthService, useValue: auth },
        { provide: OrgRegistryService, useValue: orgs },
      ],
    }).compile();
    expect(moduleRef.get(AdminKeyGuard)).toBeInstanceOf(AdminKeyGuard);
  });

  // ── the admin-key path ─────────────────────────────────────────────────────
  describe("admin key path", () => {
    it("A1 · allows with no x-org-id and leaves orgId empty for TenantGuard to reject", async () => {
      const { context, req } = makeExecutionContext({ headers: { "x-admin-key": DEV_KEY } });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.principal).toEqual({
        userId: "admin-key",
        orgId: "",
        role: "platform_admin",
        recordingsListen: true,
        recordingsExport: true,
        viaAdminKey: true,
        ownerRole: null,
      });
      // The cross-tenant admin endpoints legitimately send no org header, so
      // the existence check must not fire (admin-key.guard.ts:67).
      expect(orgs.exists).not.toHaveBeenCalled();
    });

    it("A2 · allows and pins the named tenant when the org exists", async () => {
      const { context, req } = makeExecutionContext({
        headers: { "x-admin-key": DEV_KEY, "x-org-id": ORG_B },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(orgs.exists).toHaveBeenCalledWith(ORG_B);
      expect(req.principal?.orgId).toBe(ORG_B);
    });

    it("A3 · 404s a well-formed org id that names no tenant", async () => {
      orgs.exists.mockResolvedValue(false);
      const { context, req } = makeExecutionContext({
        headers: { "x-admin-key": DEV_KEY, "x-org-id": ORG_B },
      });

      // NOT a 401 and NOT an empty 200: "this customer has no calls" and "this
      // customer does not exist" are different answers (org-registry.service.ts).
      await expectHttpError(() => guard.canActivate(context), {
        type: NotFoundException,
        message: `no organization with id ${ORG_B}`,
        status: 404,
      });
      expect(req.principal).toBeUndefined();
    });

    it("A4 · allows a MALFORMED x-org-id through without checking it exists (today's behaviour)", async () => {
      const { context, req } = makeExecutionContext({
        headers: { "x-admin-key": DEV_KEY, "x-org-id": "not-a-uuid" },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      // The uuid parse failing SKIPS the existence check entirely
      // (admin-key.guard.ts:67), so the malformed value reaches the principal
      // and only TenantGuard rejects it - see tenant.guard.spec.ts T5.
      expect(orgs.exists).not.toHaveBeenCalled();
      expect(req.principal?.orgId).toBe("not-a-uuid");
    });

    it.skip("A4 (correct) · rejects a malformed x-org-id at the auth guard", async () => {
      // DEFECT (inventory 13 §2.1 A4): a malformed org id is only caught one
      // guard later, as a 400 that reads as "you forgot the header" rather than
      // "that header is not a uuid". Harmless today because TenantGuard is
      // mounted everywhere AdminKeyGuard is (scripts/check-tenancy.js enforces
      // it), which is the only reason this is a wart and not a hole. Un-skip
      // when the guard validates presence-implies-well-formed.
      const { context } = makeExecutionContext({
        headers: { "x-admin-key": DEV_KEY, "x-org-id": "not-a-uuid" },
      });
      await expectHttpError(() => guard.canActivate(context), {
        type: NotFoundException,
        message: "no organization with id not-a-uuid",
        status: 404,
      });
    });

    it('A6 · falls back to the literal user id "admin-key" when x-caller-user-id is malformed', async () => {
      const { context, req } = makeExecutionContext({
        headers: { "x-admin-key": DEV_KEY, "x-org-id": ORG_A, "x-caller-user-id": "not-a-uuid" },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.principal?.userId).toBe("admin-key");
    });

    it("A8 · leaves ownerRole null when x-caller-owner-role is absent or not a persona", async () => {
      for (const header of [undefined, "Telecaller", "admin", ""]) {
        const { context, req } = makeExecutionContext({
          headers: { "x-admin-key": DEV_KEY, "x-org-id": ORG_A, "x-caller-owner-role": header },
        });

        await expect(guard.canActivate(context)).resolves.toBe(true);
        // null is not "unknown, deny" - OwnerRoleGuard:53 reads it as
        // "unchecked, pass". See owner-role.guard.spec.ts O4/O9.
        expect(req.principal?.ownerRole).toBeNull();
      }
    });

    it("A14 · an EMPTY x-admin-key does not match an unset ADMIN_API_KEY", async () => {
      // The `.trim()`-and-truthiness in resolveAdminKey is the only thing
      // stopping `"" === ""` from authenticating an anonymous request.
      const { context } = makeExecutionContext({ headers: { "x-admin-key": "" } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: UNAUTHORIZED_MESSAGE,
        status: 401,
      });
    });

    it("A15 · takes the first value when a header is repeated", async () => {
      const { context, req } = makeExecutionContext({
        headers: {
          "x-admin-key": [DEV_KEY, "second"],
          "x-org-id": [ORG_B, ORG_A],
          "x-caller-user-id": [USER_B, USER_A],
          // `x-caller-owner-role` goes through the same `firstHeader` (`:95`).
          // Worth pinning with the others: if it ever took the LAST value, a
          // caller could append a persona to a header the web tier already set.
          "x-caller-owner-role": ["telecaller", "owner"],
        },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.principal?.orgId).toBe(ORG_B);
      expect(req.principal?.userId).toBe(USER_B);
      expect(req.principal?.ownerRole).toBe("telecaller");
    });

    it("A7 · carries every persona in the OwnerRole enum through verbatim", async () => {
      // A8 covers the values that FAIL to parse; this is the other half. All
      // three are accepted unverified, and `telecaller`/`manager` are personas
      // no route on the platform can even assign (inventory 13 §5.4) - they
      // exist only because a caller asserted them.
      for (const persona of ["owner", "manager", "telecaller"] as const) {
        const { context, req } = makeExecutionContext({
          headers: {
            "x-admin-key": DEV_KEY,
            "x-org-id": ORG_A,
            "x-caller-owner-role": persona,
          },
        });

        await expect(guard.canActivate(context)).resolves.toBe(true);
        expect(req.principal?.ownerRole).toBe(persona);
      }
    });

    it("the admin key WINS over a session bearer token - the session is never consulted", async () => {
      // Precedence, and it is not academic: apps/web holds the admin key AND
      // forwards the signed-in user's bearer token on some paths, so requests
      // carrying both are real. The admin-key branch returns at `:106` before
      // `:109` is reached, which means the resulting principal is
      // `platform_admin` with BOTH recordings grants - not the user's own role.
      // That is why `x-caller-user-id` exists at all, and why PermissionsGuard
      // P3 is inert for the console.
      auth.principalFromToken.mockResolvedValue(sessionPrincipal({ role: "viewer" }));
      const { context, req } = makeExecutionContext({
        headers: { "x-admin-key": DEV_KEY, "x-org-id": ORG_A, authorization: SESSION_HEADER },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.principal?.viaAdminKey).toBe(true);
      expect(req.principal?.role).toBe("platform_admin");
      expect(auth.principalFromToken).not.toHaveBeenCalled();
    });

    it("uses the configured ADMIN_API_KEY and rejects the dev literal once one is set", async () => {
      process.env.ADMIN_API_KEY = "  configured-key  ";

      const good = makeExecutionContext({ headers: { "x-admin-key": "configured-key" } });
      await expect(guard.canActivate(good.context)).resolves.toBe(true);

      const bad = makeExecutionContext({ headers: { "x-admin-key": DEV_KEY } });
      await expectHttpError(() => guard.canActivate(bad.context), {
        type: UnauthorizedException,
        message: UNAUTHORIZED_MESSAGE,
        status: 401,
      });
    });
  });

  // ── Stage 0.2: the dev literal must be dead in production ──────────────────
  describe("production hardening (checklist 08 §0.2)", () => {
    it("rejects the published dev-admin-key literal when ADMIN_API_KEY is unset in production", async () => {
      // THE regression test for the Stage 0.2 fix. Before it, this exact
      // request was a root credential for every tenant on the open internet.
      process.env.NODE_ENV = "production";
      const { context, req } = makeExecutionContext({ headers: { "x-admin-key": DEV_KEY } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: UNAUTHORIZED_MESSAGE,
        status: 401,
      });
      expect(req.principal).toBeUndefined();
      expect(orgs.exists).not.toHaveBeenCalled();
    });

    it("rejects an EMPTY x-admin-key against an unset key in production (null must match nothing)", async () => {
      // The null key is compared with `adminKey !== null` BEFORE the string
      // compare (admin-key.guard.ts:58). A regression that dropped that
      // short-circuit would let `x-admin-key:` with no value through here.
      process.env.NODE_ENV = "production";
      const { context } = makeExecutionContext({ headers: { "x-admin-key": "" } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: UNAUTHORIZED_MESSAGE,
        status: 401,
      });
    });

    it("still admits a real session in production - the rejection is of the key, not the request", async () => {
      process.env.NODE_ENV = "production";
      auth.principalFromToken.mockResolvedValue(sessionPrincipal());
      const { context, req } = makeExecutionContext({
        headers: { "x-admin-key": DEV_KEY, authorization: SESSION_HEADER },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.principal?.viaAdminKey).toBe(false);
    });
  });

  // ── the session path ───────────────────────────────────────────────────────
  describe("session path", () => {
    it("A10 · resolves the principal from the bearer token, prefix included", async () => {
      auth.principalFromToken.mockResolvedValue(sessionPrincipal());
      const { context, req } = makeExecutionContext({ headers: { authorization: SESSION_HEADER } });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      // Only "Bearer " is stripped - the `aus_` prefix is part of what gets
      // hashed (auth.service.ts:40). Slicing it off here would make every
      // session lookup miss and read as an expiry bug.
      expect(auth.principalFromToken).toHaveBeenCalledWith(SESSION_TOKEN);
      expect(req.principal?.viaAdminKey).toBe(false);
    });

    it("PINS SESSION ORG - a session sending another tenant's x-org-id is forced back to its own", async () => {
      // Proved by hand on 2026-07-29 and untested since. This is the property
      // that makes "a session can never act outside its tenant" true; Stage 2.4
      // rewrites how the web tier authenticates and must not lose it.
      auth.principalFromToken.mockResolvedValue(sessionPrincipal({ orgId: ORG_A }));
      const { context, req } = makeExecutionContext({
        headers: { authorization: SESSION_HEADER, "x-org-id": ORG_B },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.headers["x-org-id"]).toBe(ORG_A);
      expect(req.principal?.orgId).toBe(ORG_A);
      // The org came from the session, so it is never re-derived from the header.
      expect(orgs.exists).not.toHaveBeenCalled();
    });

    it("A9 · a WRONG admin key still falls through to the session path", async () => {
      auth.principalFromToken.mockResolvedValue(sessionPrincipal({ orgId: ORG_A }));
      const { context, req } = makeExecutionContext({
        headers: { "x-admin-key": "wrong", authorization: SESSION_HEADER, "x-org-id": ORG_B },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.principal?.viaAdminKey).toBe(false);
      expect(req.headers["x-org-id"]).toBe(ORG_A);
    });

    it("a session CANNOT assert an identity or a persona - the x-caller-* headers are ignored", async () => {
      // The counterweight to the A5/A7 pin below. Both caller-asserted headers
      // are read INSIDE the admin-key branch (`:94-95`); the session branch
      // (`:110-117`) takes the principal wholesale from
      // `AuthService.principalFromToken` and never looks at them. So the trust
      // in those headers is scoped to admin-key callers only - a leaked session
      // token does not become a persona-escalation primitive. Stage 2.4/2.5
      // move the console onto the session path, so this property is the thing
      // that makes that migration a de-escalation rather than a lateral move.
      auth.principalFromToken.mockResolvedValue(
        sessionPrincipal({ userId: USER_A, ownerRole: "telecaller" }),
      );
      const { context, req } = makeExecutionContext({
        headers: {
          authorization: SESSION_HEADER,
          "x-caller-user-id": USER_B,
          "x-caller-owner-role": "owner",
        },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.principal?.userId).toBe(USER_A);
      expect(req.principal?.ownerRole).toBe("telecaller");
    });

    it("A11 · 401s an unknown or expired session token", async () => {
      auth.principalFromToken.mockResolvedValue(null);
      const { context } = makeExecutionContext({ headers: { authorization: SESSION_HEADER } });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: UNAUTHORIZED_MESSAGE,
        status: 401,
      });
    });

    it("A12 · 401s a bearer token without the aus_ prefix, without hitting the database", async () => {
      const { context } = makeExecutionContext({
        headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.x" },
      });

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: UNAUTHORIZED_MESSAGE,
        status: 401,
      });
      expect(auth.principalFromToken).not.toHaveBeenCalled();
    });

    it("A13 · 401s a request with no credential at all", async () => {
      const { context } = makeExecutionContext();

      await expectHttpError(() => guard.canActivate(context), {
        type: UnauthorizedException,
        message: UNAUTHORIZED_MESSAGE,
        status: 401,
      });
      expect(auth.principalFromToken).not.toHaveBeenCalled();
    });
  });

  // ── the Stage 2.5 gap, pinned as today's behaviour ─────────────────────────
  describe("caller-asserted identity headers (checklist 08 §2.5 gap)", () => {
    it("A5/A7 · TRUSTS x-caller-user-id and x-caller-owner-role, unverified", async () => {
      // PINNED DELIBERATELY. This is today's contract, not an endorsement: the
      // admin-key holder asserts who the caller is and which persona they hold,
      // and the API believes both. Stage 2.5 replaces it with a persona derived
      // server-side from memberships.owner_role (migration 0018). WHEN 2.5
      // LANDS, THIS TEST FAILING IS THE SIGNAL THE TRANSITION COMPLETED -
      // delete it then, and un-skip its sibling below.
      const { context, req } = makeExecutionContext({
        headers: {
          "x-admin-key": DEV_KEY,
          "x-org-id": ORG_A,
          "x-caller-user-id": USER_B,
          "x-caller-owner-role": "owner",
        },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.principal?.userId).toBe(USER_B);
      expect(req.principal?.ownerRole).toBe("owner");
      // Nothing was looked up: no session, no membership, no org row. The
      // headers ARE the identity.
      expect(auth.principalFromToken).not.toHaveBeenCalled();
    });

    it.skip("A5/A7 (correct) · derives the persona server-side and ignores the header", async () => {
      // Un-skip with Stage 2.5. A caller claiming `owner` while its membership
      // says `telecaller` must come out `telecaller`; the header must not be
      // able to name a user id either.
      const { context, req } = makeExecutionContext({
        headers: {
          "x-admin-key": DEV_KEY,
          "x-org-id": ORG_A,
          "x-caller-user-id": USER_B,
          "x-caller-owner-role": "owner",
        },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(req.principal?.ownerRole).toBe("telecaller");
    });
  });
});
