/**
 * Shared harness for the five guard suites (checklist 08 §1.3), plus its own
 * self-tests.
 *
 * WHY THIS IS A `.spec.ts` AND NOT A PLAIN MODULE: report 12 §7 makes the guard
 * suite the regression net for Stage 2, and the harness is the part every one of
 * those five suites depends on — a silently wrong `makeExecutionContext` would
 * weaken all of them at once (the classic "the fake never had the header the
 * guard reads, so everything passed"). So the harness ships with tests proving
 * it behaves like Express + Nest do, and it lives in a file the runner is
 * guaranteed to execute. Importing helpers across spec files is fine: Jest gives
 * each test file its own module registry.
 *
 * Nothing here touches a database, a socket, or an env file. `reflect-metadata`
 * is imported once, here, because every spec imports this file — that keeps the
 * runner free of a `setupFiles` entry (and of a non-spec file in this partition).
 */
import "reflect-metadata";
import { type ExecutionContext, type HttpException, SetMetadata, type Type } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { DevicePrincipal } from "./device-auth.guard";
import type { Principal } from "./auth-principal";

// ── fixed ids (inventory 13 §5.0) ────────────────────────────────────────────
// Version-4-shaped to match what the database actually stores (gen_random_uuid()
// emits v4), not because the guards demand it: AdminKeyGuard:67 and
// TenantGuard:77 parse with zod 4's `.uuid()`, which accepts any RFC 9562
// version nibble 1-8 with variant 8/9/a/b, plus the nil uuid. Verified against
// zod 4.4.3 — a v1-shaped id parses fine, so do not write a test asserting one
// is rejected (see tenant.guard.spec.ts T5).
export const ORG_A = "00000000-0000-4000-8000-000000000001";
export const ORG_B = "00000000-0000-4000-8000-0000000000b1";
export const USER_A = "00000000-0000-4000-8000-000000000003";
export const USER_B = "00000000-0000-4000-8000-0000000000b3";
export const DEVICE_A = "00000000-0000-4000-8000-00000000d001";
/**
 * NOT a valid uuid — `i` is not a hex digit. Kept verbatim from the fixture
 * contract because that is the point: `DeviceAuthGuard:41` copies
 * `instance_id` off the JWT with no parsing at all, so an id this malformed
 * still reaches `req.device`. See the D9/D10 cases in device-auth.guard.spec.ts.
 */
export const INSTANCE_A = "00000000-0000-4000-8000-00000000i001";

/** The device JWT secret. Set EXPLICITLY in specs — see device-auth.guard.spec.ts. */
export const DEV_JWT_SECRET = "dev-jwt-secret-change-me";

// ── request / context fakes ──────────────────────────────────────────────────

export type TestHeaders = Record<string, string | string[] | undefined>;

/** The subset of the request the five guards read from and write to. */
export interface TestRequest {
  headers: TestHeaders;
  principal?: Principal;
  tenantOrgId?: string;
  device?: DevicePrincipal;
}

export interface TestContext {
  context: ExecutionContext;
  /** The same object the guard mutates — assert `principal` / `tenantOrgId` / `device` on it. */
  req: TestRequest;
}

/**
 * Node's HTTP parser lower-cases every inbound header name, and every guard
 * reads `req.headers["x-admin-key"]` in lower case. A fixture written as
 * `{"X-Admin-Key": ...}` would therefore miss — and the test would fail (or,
 * worse, pass) for a reason that has nothing to do with the guard.
 */
function lowerCaseKeys(headers: TestHeaders): TestHeaders {
  const out: TestHeaders = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** Distinct default handler/class so `Reflector` reads real (empty) metadata, not a shared one. */
function defaultHandler(): void {}
class DefaultController {}

/**
 * Build an `ExecutionContext` over a fake request.
 *
 * `handler` / `cls` exist because `TenantGuard`, `PermissionsGuard` and
 * `OwnerRoleGuard` all resolve their metadata with
 * `reflector.getAllAndOverride(KEY, [context.getHandler(), context.getClass()])`
 * — handler first, class second. Passing real decorated fixtures (rather than a
 * stubbed Reflector) is what makes the handler-wins-over-class precedence a
 * tested property instead of an assumed one; `GET /v1/analytics/fleet` is a
 * `@CrossTenant()` handler inside a tenant-scoped controller and depends on it.
 */
export function makeExecutionContext(
  opts: {
    headers?: TestHeaders;
    principal?: Principal;
    handler?: (...args: never[]) => unknown;
    cls?: Type<unknown>;
  } = {},
): TestContext {
  const req: TestRequest = { headers: lowerCaseKeys(opts.headers ?? {}) };
  if (opts.principal) req.principal = opts.principal;

  const handler = opts.handler ?? defaultHandler;
  const cls = opts.cls ?? DefaultController;

  const context = {
    getType: () => "http",
    getClass: () => cls,
    getHandler: () => handler,
    getArgs: () => [req],
    getArgByIndex: (index: number) => [req][index],
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    switchToRpc: () => {
      throw new Error("guard tests are HTTP-only");
    },
    switchToWs: () => {
      throw new Error("guard tests are HTTP-only");
    },
  } as unknown as ExecutionContext;

  return { context, req };
}

// ── principal builders ───────────────────────────────────────────────────────

/**
 * What `AdminKeyGuard:97-105` builds on the admin-key path. `viaAdminKey: true`
 * and `role: "platform_admin"` are hard-coded there, so they are not overridable
 * by accident here — pass them explicitly if a case needs them changed.
 */
export function adminKeyPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: "admin-key",
    orgId: ORG_A,
    role: "platform_admin",
    recordingsListen: true,
    recordingsExport: true,
    viaAdminKey: true,
    ownerRole: null,
    ...overrides,
  };
}

/**
 * What `AuthService.principalFromToken` (auth.service.ts:148-156) returns.
 * Defaults are the seeded dev membership (inventory 13 §5.4) EXCEPT
 * `ownerRole`, which is `null` on a database seeded after 0018 — trap (5).
 */
export function sessionPrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: USER_A,
    orgId: ORG_A,
    role: "org_admin",
    recordingsListen: true,
    recordingsExport: false,
    viaAdminKey: false,
    ownerRole: null,
    ...overrides,
  };
}

// ── assertions ───────────────────────────────────────────────────────────────

/**
 * Assert the exact exception a guard threw: type, message AND status.
 *
 * `expect(...).toThrow()` alone is not enough here. `AdminKeyGuard` throws
 * `NotFoundException` for an unknown org and `UnauthorizedException` for a bad
 * credential, and the Stage 0.2 fix (`resolveAdminKey` returning null in
 * production) is only correct if the request lands on the 401 — a regression
 * that turned it into a 404, or into a 401 with a different message, would still
 * satisfy a bare `toThrow()`.
 */
export async function expectHttpError(
  run: () => unknown,
  expected: { type: Type<HttpException>; message: string; status: number },
): Promise<void> {
  let threw = false;
  let error: unknown;
  try {
    await run();
  } catch (e) {
    threw = true;
    error = e;
  }
  if (!threw) {
    throw new Error(
      `expected ${expected.type.name}("${expected.message}") but the guard returned normally`,
    );
  }
  expect(error).toBeInstanceOf(expected.type);
  expect((error as HttpException).message).toBe(expected.message);
  expect((error as HttpException).getStatus()).toBe(expected.status);
}

// ── self-tests ───────────────────────────────────────────────────────────────

const SELF_TEST_KEY = "guard_harness_self_test";
const SelfTest = () => SetMetadata(SELF_TEST_KEY, "class-level");
const SelfTestHandler = () => SetMetadata(SELF_TEST_KEY, "handler-level");

@SelfTest()
class DecoratedController {
  @SelfTestHandler()
  overriding(): void {}

  inheriting(): void {}
}

describe("guard harness", () => {
  it("lower-cases header names the way Node's HTTP parser does", () => {
    const { req } = makeExecutionContext({ headers: { "X-Admin-Key": "k", "X-Org-Id": ORG_A } });
    expect(req.headers["x-admin-key"]).toBe("k");
    expect(req.headers["x-org-id"]).toBe(ORG_A);
  });

  it("exposes the same request object the guard mutates", () => {
    const { context, req } = makeExecutionContext();
    const fromContext = context.switchToHttp().getRequest<TestRequest>();
    fromContext.tenantOrgId = ORG_A;
    expect(req.tenantOrgId).toBe(ORG_A);
  });

  it("carries real decorator metadata, so a REAL Reflector resolves it", () => {
    // Proves the three metadata-driven guards are being tested against Nest's
    // own resolution, not a hand-rolled stub that agrees with the test by
    // construction.
    const reflector = new Reflector();
    const { context } = makeExecutionContext({
      handler: DecoratedController.prototype.inheriting,
      cls: DecoratedController,
    });
    expect(
      reflector.getAllAndOverride(SELF_TEST_KEY, [context.getHandler(), context.getClass()]),
    ).toBe("class-level");
  });

  it("lets handler metadata override class metadata (the @CrossTenant() fleet route)", () => {
    const reflector = new Reflector();
    const { context } = makeExecutionContext({
      handler: DecoratedController.prototype.overriding,
      cls: DecoratedController,
    });
    expect(
      reflector.getAllAndOverride(SELF_TEST_KEY, [context.getHandler(), context.getClass()]),
    ).toBe("handler-level");
  });

  it("defaults to a handler and class carrying no metadata at all", () => {
    const reflector = new Reflector();
    const { context } = makeExecutionContext();
    expect(
      reflector.getAllAndOverride(SELF_TEST_KEY, [context.getHandler(), context.getClass()]),
    ).toBeUndefined();
  });

  it("expectHttpError fails when the guard did NOT throw", async () => {
    // Without this, a guard that silently started allowing everything would
    // turn every negative case green.
    await expect(
      expectHttpError(() => true, {
        type: Error as unknown as Type<HttpException>,
        message: "never thrown",
        status: 500,
      }),
    ).rejects.toThrow(/returned normally/);
  });
});
