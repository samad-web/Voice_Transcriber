import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { CallAccessGuard, CallContent } from "./call-access.guard";
import { adminKeyPrincipal, sessionPrincipal, ORG_A, USER_A } from "./guard-harness.spec";
import type { Principal } from "./auth-principal";
import type { DbService } from "../db/db.service";

/**
 * Does the call-access gate (0122) actually refuse?
 *
 * The one property worth more than all the others here is that it fails
 * CLOSED. A gate that waves a request through on a missing row, an unreadable
 * window or an unnamed caller is not a gate; it is a delay. So the cases below
 * are weighted toward "something is absent or malformed" rather than toward the
 * happy path.
 */

const OPERATOR = "support@sirahdigital.in";

interface FakeRow {
  gate?: boolean;
  grant?: {
    status: string;
    granted_start: Date | null;
    granted_end: Date | null;
  } | null;
}

interface Recorded {
  sql: string;
  params: unknown[];
}

/**
 * A `DbService` stand-in that answers the guard's three queries by shape.
 *
 * Matching on the SQL rather than on call order, because the guard issues a
 * different number of queries depending on which branch it takes (a live grant
 * stops after two; a refusal goes on to insert, notify and audit), and an
 * order-indexed fake would silently answer the wrong question the first time
 * somebody reordered them.
 */
function fakeDb(row: FakeRow): { db: DbService; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const db = {
    withOrg: async (orgId: string, fn: (client: unknown) => Promise<unknown>) => {
      const client = {
        query: async (sql: string, params: unknown[] = []) => {
          calls.push({ sql, params });
          if (sql.includes("call_access_gate_enabled FROM organizations")) {
            return { rows: [{ call_access_gate_enabled: row.gate ?? true }], rowCount: 1 };
          }
          if (sql.includes("FROM call_access_requests")) {
            return { rows: row.grant ? [row.grant] : [], rowCount: row.grant ? 1 : 0 };
          }
          if (sql.includes("INSERT INTO call_access_requests")) {
            return {
              rows: [{ id: "req-1", status: "pending", attempts: 1, inserted: true }],
              rowCount: 1,
            };
          }
          // memberships lookup for the alert, notify()'s insert, audit_log.
          return { rows: [], rowCount: 0 };
        },
      };
      return fn(client);
    },
  } as unknown as DbService;
  return { db, calls };
}

function gatedHandler(): void {}
CallContent()(gatedHandler as never, "gatedHandler", {
  value: gatedHandler,
} as PropertyDescriptor);

function plainHandler(): void {}

class PlainController {}

function contextFor(
  handler: (...args: never[]) => unknown,
  principal: Principal | undefined,
  tenantOrgId: string | undefined = ORG_A,
): ExecutionContext {
  const req: Record<string, unknown> = { headers: {} };
  if (principal) req.principal = principal;
  if (tenantOrgId) req.tenantOrgId = tenantOrgId;
  return {
    getType: () => "http",
    getClass: () => PlainController,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const guardWith = (row: FakeRow) => {
  const { db, calls } = fakeDb(row);
  return { guard: new CallAccessGuard(new Reflector(), db), calls };
};

const operatorPrincipal = (overrides: Partial<Principal> = {}) =>
  adminKeyPrincipal({ operatorEmail: OPERATOR, ...overrides });

describe("CallAccessGuard", () => {
  describe("routes it does not touch", () => {
    it("G1 · ignores a route with no @CallContent()", async () => {
      const { guard, calls } = guardWith({ gate: true });
      await expect(guard.canActivate(contextFor(plainHandler, operatorPrincipal()))).resolves.toBe(
        true,
      );
      // Not merely allowed - never even asked. An un-marked route must cost
      // nothing, or nobody will mark the next one.
      expect(calls).toHaveLength(0);
    });
  });

  describe("callers it does not gate", () => {
    it("G2 · lets a tenant's own console user through untouched", async () => {
      // The owner console proxies on the admin key and adds x-caller-user-id,
      // so the principal carries a real uuid. Their access is decided by the
      // persona and recordings_listen, not by this guard - permission-grid.md
      // is explicit that a fourth axis over one object is a mistake.
      const { guard, calls } = guardWith({ gate: true });
      await expect(
        guard.canActivate(contextFor(gatedHandler, adminKeyPrincipal({ userId: USER_A }))),
      ).resolves.toBe(true);
      expect(calls).toHaveLength(0);
    });

    it("G3 · lets a bearer session through untouched", async () => {
      const { guard, calls } = guardWith({ gate: true });
      await expect(
        guard.canActivate(contextFor(gatedHandler, sessionPrincipal())),
      ).resolves.toBe(true);
      expect(calls).toHaveLength(0);
    });

    it("G4 · lets any caller through when the org's gate is off", async () => {
      // Every org that existed when 0122 ran is in this state.
      const { guard } = guardWith({ gate: false });
      await expect(
        guard.canActivate(contextFor(gatedHandler, operatorPrincipal())),
      ).resolves.toBe(true);
    });
  });

  describe("the gate itself", () => {
    it("G5 · allows an operator holding a live grant", async () => {
      const { guard } = guardWith({
        gate: true,
        grant: {
          status: "approved",
          granted_start: new Date(Date.now() - 60_000),
          granted_end: new Date(Date.now() + 60_000),
        },
      });
      await expect(
        guard.canActivate(contextFor(gatedHandler, operatorPrincipal())),
      ).resolves.toBe(true);
    });

    it("G6 · refuses an operator with no grant at all", async () => {
      const { guard } = guardWith({ gate: true, grant: null });
      await expect(guard.canActivate(contextFor(gatedHandler, operatorPrincipal()))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("G7 · refuses a grant whose window has ended", async () => {
      const { guard } = guardWith({
        gate: true,
        grant: {
          status: "approved",
          granted_start: new Date(Date.now() - 7_200_000),
          granted_end: new Date(Date.now() - 3_600_000),
        },
      });
      await expect(guard.canActivate(contextFor(gatedHandler, operatorPrincipal()))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("G8 · refuses a grant whose window has not started", async () => {
      // A scheduled window is a real state: approved, and not yet usable.
      const { guard } = guardWith({
        gate: true,
        grant: {
          status: "approved",
          granted_start: new Date(Date.now() + 3_600_000),
          granted_end: new Date(Date.now() + 7_200_000),
        },
      });
      await expect(guard.canActivate(contextFor(gatedHandler, operatorPrincipal()))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("G9 · refuses a grant with an unreadable end - fails CLOSED", async () => {
      // The row should be impossible (0122's CHECK forbids it), which is
      // exactly why the guard must not assume it away. A NULL end read as
      // "no limit" would be permanent access.
      const { guard } = guardWith({
        gate: true,
        grant: {
          status: "approved",
          granted_start: new Date(Date.now() - 60_000),
          granted_end: null,
        },
      });
      await expect(guard.canActivate(contextFor(gatedHandler, operatorPrincipal()))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("G10 · refuses an unattributable admin-key caller, and never inserts a request", async () => {
      // A script with the bare root key. There is nobody to attribute an
      // access request to and nobody for the customer to answer, so it is
      // refused and only audited.
      const { guard, calls } = guardWith({ gate: true });
      await expect(
        guard.canActivate(contextFor(gatedHandler, adminKeyPrincipal({ operatorEmail: null }))),
      ).rejects.toThrow(ForbiddenException);

      expect(calls.some((c) => c.sql.includes("INSERT INTO call_access_requests"))).toBe(false);
      expect(calls.some((c) => c.sql.includes("call_access.denied"))).toBe(true);
    });

    it("G11 · refuses when the org cannot be read", async () => {
      const { db } = (() => {
        const stub = {
          withOrg: async (_orgId: string, fn: (client: unknown) => Promise<unknown>) =>
            fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
        } as unknown as DbService;
        return { db: stub };
      })();
      const guard = new CallAccessGuard(new Reflector(), db);
      await expect(guard.canActivate(contextFor(gatedHandler, operatorPrincipal()))).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("misconfiguration", () => {
    it("G12 · 401s when it runs before AdminKeyGuard", async () => {
      const { guard } = guardWith({ gate: true });
      await expect(guard.canActivate(contextFor(gatedHandler, undefined))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("G13 · refuses a @CallContent() route with no tenant pinned", async () => {
      // A cross-tenant call route is a hole this guard cannot reason about, so
      // it is a configuration error rather than something to wave through.
      const { guard } = guardWith({ gate: true });
      await expect(
        guard.canActivate(contextFor(gatedHandler, operatorPrincipal(), undefined)),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("what it tells the caller", () => {
    it("G14 · names the blocking reason so the console can act on it", async () => {
      const { guard } = guardWith({ gate: true, grant: null });
      try {
        await guard.canActivate(contextFor(gatedHandler, operatorPrincipal()));
        throw new Error("expected a refusal");
      } catch (err) {
        const body = (err as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(body.error).toBe("call_access_required");
        expect(body.callAccess).toMatchObject({ orgId: ORG_A, status: "pending" });
      }
    });

    it("G15 · looks the grant up case-insensitively by operator", async () => {
      // One person is one person whether they signed in as Support@ or support@.
      const { guard, calls } = guardWith({ gate: true, grant: null });
      await expect(
        guard.canActivate(
          contextFor(gatedHandler, operatorPrincipal({ operatorEmail: OPERATOR.toUpperCase() })),
        ),
      ).rejects.toThrow(ForbiddenException);

      const lookup = calls.find((c) => c.sql.includes("FROM call_access_requests"));
      expect(lookup?.sql).toMatch(/lower\(btrim\(requested_by_email\)\) = lower\(btrim\(\$2\)\)/);
    });
  });
});
