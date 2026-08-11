/**
 * `CrmPermissionsGuard` — enforces the `role_permissions` grid (migration 0039)
 * on the contact/account/deal routes.
 *
 * Mounted on the 14 routes pinned by `CRM_PERMISSION_ROUTES` in
 * guard-mounting.spec.ts. Like the other guard suites this one instantiates the
 * guard directly with a real `Reflector` over real decorator metadata, so
 * handler-overrides-class precedence is tested rather than assumed.
 *
 * The database is faked, but the fake RECORDS the SQL parameters, and the cases
 * below assert them. That matters more here than in the other guard suites: the
 * whole security property is "the grant is looked up for the acting identity in
 * the pinned tenant", and a guard that returned the right boolean while querying
 * the wrong user or the wrong org would satisfy a bare allow/deny assertion.
 */
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { DbService } from "../db/db.service";
import type { Principal } from "./auth-principal";
import {
  ORG_A,
  ORG_B,
  USER_A,
  USER_B,
  adminKeyPrincipal,
  expectHttpError,
  makeExecutionContext,
  sessionPrincipal,
} from "./guard-harness.spec";
import { CrmPermissionsGuard, RequireCrmPermission } from "./crm-permissions.guard";

/** Mirrors how the real controllers mount it: metadata per handler, not per class. */
class FixtureController {
  @RequireCrmPermission("contact", "view")
  viewContact(): void {}

  @RequireCrmPermission("contact", "create")
  createContact(): void {}

  @RequireCrmPermission("deal", "delete")
  deleteDeal(): void {}

  undecorated(): void {}
}

interface Recorded {
  orgId: string;
  params: unknown[];
}

/**
 * A `DbService` stand-in. `granted` decides whether the permission query finds a
 * row; every call is recorded so the tests can assert WHAT was asked, not just
 * what came back.
 */
function fakeDb(granted: boolean): { db: DbService; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const db = {
    withOrg: async (orgId: string, fn: (client: unknown) => Promise<unknown>) => {
      const client = {
        query: async (_sql: string, params: unknown[]) => {
          calls.push({ orgId, params });
          return { rows: granted ? [{ "?column?": 1 }] : [] };
        },
      };
      return fn(client);
    },
  } as unknown as DbService;
  return { db, calls };
}

/**
 * A tenant that was never pinned. A distinct sentinel rather than `undefined`,
 * because passing `undefined` to a parameter that HAS a default silently
 * re-triggers that default — which quietly turned C9 into a second copy of the
 * pinned case until it was caught.
 */
const UNPINNED = Symbol("unpinned");

function contextFor(
  handler: (...args: never[]) => unknown,
  principal: Principal | undefined,
  tenantOrgId: string | typeof UNPINNED = ORG_A,
) {
  const made = makeExecutionContext({ principal, handler, cls: FixtureController });
  if (tenantOrgId !== UNPINNED) made.req.tenantOrgId = tenantOrgId;
  return made;
}

describe("CrmPermissionsGuard", () => {
  it("C1 ignores a route carrying no @RequireCrmPermission", async () => {
    const { db, calls } = fakeDb(false);
    const guard = new CrmPermissionsGuard(new Reflector(), db);
    const { context } = contextFor(FixtureController.prototype.undecorated, sessionPrincipal());

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // Not merely allowed — it must not have touched the database at all, which
    // is what keeps this guard free on the other 110 principal routes.
    expect(calls).toHaveLength(0);
  });

  it("C2 passes a BARE admin-key caller (no asserted user) without a lookup", async () => {
    // Seed scripts, ops tooling, scripts/backfill-crm-objects.js. Same carve-out
    // OwnerRoleGuard makes, and the reason `userId` is the literal "admin-key".
    const { db, calls } = fakeDb(false);
    const guard = new CrmPermissionsGuard(new Reflector(), db);
    const { context } = contextFor(FixtureController.prototype.createContact, adminKeyPrincipal());

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("C3 ENFORCES an admin-key caller that asserted a user id", async () => {
    // The path that actually matters: this is how the live owner console talks
    // to the API once Supabase auth is configured.
    const { db, calls } = fakeDb(true);
    const guard = new CrmPermissionsGuard(new Reflector(), db);
    const { context } = contextFor(
      FixtureController.prototype.createContact,
      adminKeyPrincipal({ userId: USER_B }),
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([USER_B, ORG_A, "contact", "create"]);
  });

  it("C4 denies when the grid has no matching grant", async () => {
    const { db } = fakeDb(false);
    const guard = new CrmPermissionsGuard(new Reflector(), db);
    const { context } = contextFor(FixtureController.prototype.deleteDeal, sessionPrincipal());

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires permission: delete on deal",
      status: 403,
    });
  });

  it("C5 looks the grant up for the SESSION's own user and the PINNED org", async () => {
    // `tenantOrgId` is what TenantGuard pinned, which for a session is forced to
    // the session's own org. Asserting the pair together is what would catch a
    // guard that read the org off an attacker-supplied header instead.
    const { db, calls } = fakeDb(true);
    const guard = new CrmPermissionsGuard(new Reflector(), db);
    const { context } = contextFor(
      FixtureController.prototype.viewContact,
      sessionPrincipal({ userId: USER_A, orgId: ORG_A }),
      ORG_A,
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(calls[0]).toEqual({ orgId: ORG_A, params: [USER_A, ORG_A, "contact", "view"] });
  });

  it("C6 scopes the lookup to the tenant the request was pinned to, not the principal's own field", async () => {
    // An operator acting on ORG_B through the admin key: the grant must be read
    // in ORG_B, because that is the tenant the write would land in.
    const { db, calls } = fakeDb(true);
    const guard = new CrmPermissionsGuard(new Reflector(), db);
    const { context } = contextFor(
      FixtureController.prototype.viewContact,
      adminKeyPrincipal({ userId: USER_A, orgId: ORG_B }),
      ORG_B,
    );

    await guard.canActivate(context);
    expect(calls[0].orgId).toBe(ORG_B);
    expect(calls[0].params[1]).toBe(ORG_B);
  });

  it("C7 denies a session whose user has no membership in the org (empty result)", async () => {
    // Same empty-rows outcome as "no grant" and deliberately the same 403: the
    // distinction is not something a caller is entitled to learn.
    const { db } = fakeDb(false);
    const guard = new CrmPermissionsGuard(new Reflector(), db);
    const { context } = contextFor(FixtureController.prototype.viewContact, sessionPrincipal());

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires permission: view on contact",
      status: 403,
    });
  });

  it("C8 rejects when no principal is present (guard mounted before AdminKeyGuard)", async () => {
    const { db } = fakeDb(true);
    const guard = new CrmPermissionsGuard(new Reflector(), db);
    const { context } = contextFor(FixtureController.prototype.viewContact, undefined);

    await expectHttpError(() => guard.canActivate(context), {
      type: UnauthorizedException,
      message: "authentication required",
      status: 401,
    });
  });

  it("C9 rejects when the request was never pinned to a tenant", async () => {
    // Mounted without TenantGuard, or on a @CrossTenant() route. Refuses rather
    // than falling back to the principal's own orgId — a guard that guessed the
    // tenant here would check the grant in the wrong one.
    const { db, calls } = fakeDb(true);
    const guard = new CrmPermissionsGuard(new Reflector(), db);
    const { context } = contextFor(
      FixtureController.prototype.viewContact,
      sessionPrincipal(),
      UNPINNED,
    );

    await expectHttpError(() => guard.canActivate(context), {
      type: UnauthorizedException,
      message: "tenant scope required",
      status: 401,
    });
    expect(calls).toHaveLength(0);
  });

  it("C10 denies a non-admin-key principal with an unparseable user id", async () => {
    // The carve-out on line 1 of the check is `viaAdminKey` AND no valid user —
    // a SESSION principal that somehow carries a malformed id must not inherit
    // it, so this asserts the two halves are actually conjoined.
    const { db, calls } = fakeDb(true);
    const guard = new CrmPermissionsGuard(new Reflector(), db);
    const { context } = contextFor(
      FixtureController.prototype.viewContact,
      sessionPrincipal({ userId: "not-a-uuid" }),
    );

    await expectHttpError(() => guard.canActivate(context), {
      type: ForbiddenException,
      message: "requires permission: view on contact",
      status: 403,
    });
    expect(calls).toHaveLength(0);
  });
});
