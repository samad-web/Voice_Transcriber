/**
 * `TenantGuard` + `@OrgId()` - the tenant boundary (inventory 13 §2.2, T1-T6).
 *
 * The boundary used to be ~70 hand-written `orgIdFromHeader` calls; it is now
 * this one guard. That makes these cases the whole of the tenant-scoping
 * contract, and `scripts/check-tenancy.js` is only a grep over the MOUNTING of
 * it - it cannot tell whether the guard is correct. This file does.
 *
 * A real `Reflector` reads `@CrossTenant()` off real decorated fixtures, so the
 * handler-wins-over-class precedence (`GET /v1/analytics/fleet` is a
 * `@CrossTenant()` handler inside a tenant-scoped controller) is tested rather
 * than assumed.
 */
import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  InternalServerErrorException,
  UnauthorizedException,
} from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { AuthService } from "../modules/auth/auth.service";
import { AdminKeyGuard } from "./admin-key.guard";
import { OrgRegistryService } from "./org-registry.service";
import { CrossTenant, OrgId, TenantGuard } from "./tenant.guard";
import {
  ORG_A,
  ORG_B,
  adminKeyPrincipal,
  expectHttpError,
  makeExecutionContext,
  sessionPrincipal,
} from "./guard-harness.spec";

/** A normal tenant-scoped controller. */
class ScopedController {
  handler(): void {}
}

/** The operator surface: `@CrossTenant()` at class level (AdminController). */
@CrossTenant()
class CrossTenantController {
  handler(): void {}
}

/** The mixed shape: one cross-tenant handler inside a scoped controller. */
class FleetController {
  @CrossTenant()
  fleet(): void {}

  scoped(): void {}
}

const ORG_REQUIRED = "x-org-id header (uuid) required";
const ORG_ID_500 = "@OrgId() on a route without TenantGuard, or on a @CrossTenant() route";

describe("TenantGuard", () => {
  let guard: TenantGuard;
  beforeEach(() => {
    guard = new TenantGuard(new Reflector());
  });

  it("T1 · @CrossTenant() at class level allows and leaves the tenant UNSET", () => {
    const { context, req } = makeExecutionContext({
      cls: CrossTenantController,
      handler: CrossTenantController.prototype.handler,
      principal: adminKeyPrincipal({ orgId: "" }),
    });

    expect(guard.canActivate(context)).toBe(true);
    // Unset, not "": `@OrgId()` must then fail loudly if such a route ever asks
    // for a tenant, rather than scoping a query to the empty string.
    expect(req.tenantOrgId).toBeUndefined();
  });

  it("T1 · a @CrossTenant() HANDLER overrides a scoped controller", () => {
    const { context, req } = makeExecutionContext({
      cls: FleetController,
      handler: FleetController.prototype.fleet,
      principal: adminKeyPrincipal({ orgId: "" }),
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(req.tenantOrgId).toBeUndefined();
  });

  it("T1 · a @CrossTenant() route allows even with no principal and no org header", () => {
    // The cross-tenant branch returns before the principal is read
    // (tenant.guard.ts:62-68); this pins that ordering.
    const { context } = makeExecutionContext({
      cls: CrossTenantController,
      handler: CrossTenantController.prototype.handler,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("T1 · CLEARS a tenant something else already set, rather than leaving it", () => {
    // `req.tenantOrgId = undefined` (tenant.guard.ts:66) is an assignment, not a
    // no-op on an unset field. If it were dropped as "already undefined", a
    // cross-tenant route sitting behind anything that pre-populates the request
    // - a future middleware, an interceptor, a test harness - would silently
    // run an operator query scoped to whatever that left behind.
    const { context, req } = makeExecutionContext({
      cls: CrossTenantController,
      handler: CrossTenantController.prototype.handler,
      principal: adminKeyPrincipal({ orgId: ORG_A }),
    });
    req.tenantOrgId = ORG_B;

    expect(guard.canActivate(context)).toBe(true);
    expect(req.tenantOrgId).toBeUndefined();
  });

  it("T1 · a sibling handler on the same controller is still scoped", () => {
    const { context, req } = makeExecutionContext({
      cls: FleetController,
      handler: FleetController.prototype.scoped,
      principal: adminKeyPrincipal({ orgId: ORG_A }),
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(req.tenantOrgId).toBe(ORG_A);
  });

  it("T2 · 401s when no principal was set - a guard-ORDER bug, caught loudly", async () => {
    // Mounted alone, i.e. `@UseGuards(TenantGuard, AdminKeyGuard)` or a missing
    // AdminKeyGuard. Inventory 13 §2.0: a future reordering of @UseGuards must
    // fail here rather than silently unscope a query.
    const { context, req } = makeExecutionContext({
      cls: ScopedController,
      handler: ScopedController.prototype.handler,
      headers: { "x-org-id": ORG_A },
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: UnauthorizedException,
      message: "authentication required",
      status: 401,
    });
    // Notably NOT scoped to the header - the header is never a fallback.
    expect(req.tenantOrgId).toBeUndefined();
  });

  it("T3 · pins the request to the principal's org", () => {
    const { context, req } = makeExecutionContext({
      cls: ScopedController,
      handler: ScopedController.prototype.handler,
      principal: adminKeyPrincipal({ orgId: ORG_B }),
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(req.tenantOrgId).toBe(ORG_B);
  });

  it("T4 · 400s the admin-key principal that named no org", async () => {
    // AdminKeyGuard A1 produces orgId:"" - this is where that becomes a client
    // error, with the same message the old orgIdFromHeader raised.
    const { context } = makeExecutionContext({
      cls: ScopedController,
      handler: ScopedController.prototype.handler,
      principal: adminKeyPrincipal({ orgId: "" }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: BadRequestException,
      message: ORG_REQUIRED,
      status: 400,
    });
  });

  it("T5 · 400s a malformed org id that AdminKeyGuard let through (case A4)", async () => {
    const { context } = makeExecutionContext({
      cls: ScopedController,
      handler: ScopedController.prototype.handler,
      principal: adminKeyPrincipal({ orgId: "not-a-uuid" }),
    });

    await expectHttpError(() => guard.canActivate(context), {
      type: BadRequestException,
      message: ORG_REQUIRED,
      status: 400,
    });
  });

  it("T5 · 400s a uuid whose version/variant nibbles are out of range", async () => {
    // What zod 4's .uuid() actually enforces, verified against zod 4.4.3: the
    // version nibble must be 1-8 and the variant nibble 8/9/a/b (RFC 9562), plus
    // the all-zero nil uuid. It does NOT pin the version to 4 - a v1-shaped id
    // parses fine - so this asserts the real boundary rather than a v4-only rule
    // the guard has never had. Nothing on the platform requires v4 org ids; the
    // fixtures are v4-shaped only because gen_random_uuid() emits v4.
    for (const orgId of [
      "00000000-0000-9000-8000-000000000001", // version nibble 9 - out of range
      "00000000-0000-4000-c000-000000000001", // variant nibble c - out of range
    ]) {
      const { context } = makeExecutionContext({
        cls: ScopedController,
        handler: ScopedController.prototype.handler,
        principal: adminKeyPrincipal({ orgId }),
      });

      await expectHttpError(() => guard.canActivate(context), {
        type: BadRequestException,
        message: ORG_REQUIRED,
        status: 400,
      });
    }
  });

  it("T6 · WRONG TENANT - a session principal is scoped to its own org, header ignored", () => {
    // AdminKeyGuard:114 has already overwritten the header by this point; this
    // asserts TenantGuard reads the PRINCIPAL and not the header, so the
    // pinning survives even if some later code re-sets the header.
    const { context, req } = makeExecutionContext({
      cls: ScopedController,
      handler: ScopedController.prototype.handler,
      principal: sessionPrincipal({ orgId: ORG_A }),
      headers: { "x-org-id": ORG_B },
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(req.tenantOrgId).toBe(ORG_A);
  });
});

describe("@OrgId()", () => {
  /**
   * `createParamDecorator` hides its factory; Nest stores it under
   * ROUTE_ARGS_METADATA on the declaring class. Pulling it back out is the only
   * way to test the real decorator rather than a re-implementation of it.
   */
  function orgIdFactory(): (data: unknown, ctx: ExecutionContext) => string {
    class Probe {
      handler(@OrgId() _orgId: string): void {}
    }
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, "handler") as Record<
      string,
      { factory: (data: unknown, ctx: ExecutionContext) => string }
    >;
    return Object.values(args)[0].factory;
  }

  it("returns the tenant TenantGuard pinned", () => {
    const factory = orgIdFactory();
    const { context, req } = makeExecutionContext();
    req.tenantOrgId = ORG_A;

    expect(factory(undefined, context)).toBe(ORG_A);
  });

  it("throws 500 on a @CrossTenant() route, where the tenant is deliberately unset", async () => {
    const factory = orgIdFactory();
    const { context } = makeExecutionContext();

    await expectHttpError(() => factory(undefined, context), {
      type: InternalServerErrorException,
      message: ORG_ID_500,
      status: 500,
    });
  });

  it("throws 500 on the empty string too - falsy, not just undefined", async () => {
    // This is exactly why TenantGuard leaves tenantOrgId undefined rather than
    // "" on the cross-tenant path: "" would otherwise reach withOrg and scope a
    // query to no tenant at all.
    const factory = orgIdFactory();
    const { context, req } = makeExecutionContext();
    req.tenantOrgId = "";

    await expectHttpError(() => factory(undefined, context), {
      type: InternalServerErrorException,
      message: ORG_ID_500,
      status: 500,
    });
  });
});

/**
 * The ORDER of the chain, not just each guard in isolation (inventory 13 §2.0).
 *
 * Every `@UseGuards(AdminKeyGuard, TenantGuard)` on the platform - 57 routes -
 * depends on that sequence: `TenantGuard` reads `req.principal`, which only
 * `AdminKeyGuard` writes. T2 above proves the guard 401s when the principal is
 * missing; this block proves the pair is order-DEPENDENT, so a
 * `@UseGuards(TenantGuard, AdminKeyGuard)` typo in a controller (or a
 * reordering in app.module.ts) is a failing test rather than a route that
 * quietly rejects every request in production.
 *
 * Nest runs guards left to right and stops at the first that throws
 * (`GuardsConsumer`), which is exactly what `runChain` below does. Both guards
 * are the real classes; only `AuthService` and `OrgRegistryService` are faked,
 * because the alternative is a database.
 */
describe("AdminKeyGuard → TenantGuard chain order (inventory 13 §2.0)", () => {
  const DEV_KEY = "dev-admin-key";
  const auth = { principalFromToken: jest.fn() };
  const orgs = { exists: jest.fn() };
  let adminKeyGuard: AdminKeyGuard;
  let tenantGuard: TenantGuard;

  // `AdminKeyGuard.canActivate` calls `resolveAdminKey()` with no argument, so
  // it reads process.env. Snapshot/restore and delete ADMIN_API_KEY explicitly:
  // a CI shell exporting it would otherwise fail this block with no defect
  // present (report 12 §5.6 records that failure mode for pipeline.test.ts).
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ADMIN_API_KEY;
    process.env.NODE_ENV = "test";
    auth.principalFromToken.mockReset().mockResolvedValue(null);
    orgs.exists.mockReset().mockResolvedValue(true);
    adminKeyGuard = new AdminKeyGuard(
      auth as unknown as AuthService,
      orgs as unknown as OrgRegistryService,
    );
    tenantGuard = new TenantGuard(new Reflector());
  });
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  /** Nest's own semantics: sequential, short-circuiting on the first throw. */
  async function runChain(guards: CanActivate[], context: ExecutionContext): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const g of guards) results.push((await g.canActivate(context)) as boolean);
    return results;
  }

  it("the DECLARED order authenticates, then pins the tenant", async () => {
    const { context, req } = makeExecutionContext({
      cls: ScopedController,
      handler: ScopedController.prototype.handler,
      headers: { "x-admin-key": DEV_KEY, "x-org-id": ORG_A },
    });

    await expect(runChain([adminKeyGuard, tenantGuard], context)).resolves.toEqual([true, true]);
    expect(req.principal?.orgId).toBe(ORG_A);
    expect(req.tenantOrgId).toBe(ORG_A);
  });

  it("REVERSED, TenantGuard 401s before AdminKeyGuard can set a principal", async () => {
    // The regression this whole block exists for. Note the failure is NOT
    // silent-and-unscoped - it is a hard 401 on a request that carries a valid
    // admin key and a valid org header, which is the correct way for a
    // misconfiguration to fail. Pinning it means nobody can "fix" that 401 by
    // making TenantGuard fall back to the `x-org-id` header.
    const { context, req } = makeExecutionContext({
      cls: ScopedController,
      handler: ScopedController.prototype.handler,
      headers: { "x-admin-key": DEV_KEY, "x-org-id": ORG_A },
    });

    await expectHttpError(() => runChain([tenantGuard, adminKeyGuard], context), {
      type: UnauthorizedException,
      message: "authentication required",
      status: 401,
    });
    expect(req.tenantOrgId).toBeUndefined();
    // AdminKeyGuard never ran, so nothing was authenticated either.
    expect(req.principal).toBeUndefined();
  });

  it("a @CrossTenant() route is order-INDEPENDENT - it never reads the principal", async () => {
    // Why the operator surface (6 routes, inventory 13 §1.1) is not covered by
    // the case above: `TenantGuard` returns at tenant.guard.ts:62 before
    // touching `req.principal`, so both orders allow. That is a real asymmetry -
    // a reordering would break the 57 tenant routes and leave the 6
    // cross-tenant ones working, which is exactly the kind of partial failure
    // that gets misdiagnosed as "the org header is wrong".
    for (const order of [
      [adminKeyGuard, tenantGuard],
      [tenantGuard, adminKeyGuard],
    ]) {
      const { context, req } = makeExecutionContext({
        cls: CrossTenantController,
        handler: CrossTenantController.prototype.handler,
        headers: { "x-admin-key": DEV_KEY },
      });

      await expect(runChain(order, context)).resolves.toEqual([true, true]);
      expect(req.tenantOrgId).toBeUndefined();
      expect(req.principal?.viaAdminKey).toBe(true);
    }
  });
});
