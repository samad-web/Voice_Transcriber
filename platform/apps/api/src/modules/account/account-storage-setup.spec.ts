/**
 * Doc 27's API contracts that a route-count test cannot see (§10.1):
 *
 *   - the setup guide refuses to skip a required step (409) and an unknown id (404);
 *   - a manager is refused the business-profile PUT, by the real OwnerRoleGuard
 *     reading the real metadata, and allowed the GET;
 *   - sign-in history is bound to the CALLER's own subject, whatever the
 *     request says, and refuses outright without one;
 *   - a failed sign-in for an unknown address writes nothing, and the per-hour
 *     cap stops writing once reached.
 *
 * No database: `DbService` is a fake that records every statement, and the
 * cases assert on what reached it. The SQL itself is exercised against a real
 * Postgres by `verify-account-storage-setup.cjs`.
 */
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OwnerRoleGuard } from "../../common/owner-role.guard";
import type { AuthService } from "../auth/auth.service";
import type { DbService } from "../../db/db.service";
import { ORG_A, USER_A, USER_B, adminKeyPrincipal, makeExecutionContext } from "../../common/guard-harness.spec";
import { BusinessProfileController } from "../owner/business-profile.controller";
import { SetupController } from "../owner/setup.controller";
import { AuthEventsController } from "./auth-events.controller";

const SUBJECT_A = "6f1c2c1e-4b7a-4d3a-9f59-2f0e7c1d8a11";
const SUBJECT_B = "9a0b3e55-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

interface Issued {
  text: string;
  values: unknown[];
}

/** A DbService whose every query is recorded and answered by `respond`. */
function fakeDb(respond: (text: string, values: unknown[]) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] })) {
  const issued: Issued[] = [];
  const client = {
    query: jest.fn(async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      const out = respond(text, values);
      return { rowCount: out.rows.length, ...out };
    }),
  };
  const db = {
    withOrg: async (_orgId: string, fn: (c: typeof client) => Promise<unknown>) => fn(client),
    adminPool: () => client,
  } as unknown as DbService;
  return { db, issued };
}

function reqFor(overrides: Parameters<typeof adminKeyPrincipal>[0] = {}) {
  return { principal: adminKeyPrincipal({ orgId: ORG_A, userId: USER_A, ...overrides }), headers: {} } as never;
}

describe("setup guide - skipping", () => {
  it("409s for a required step, before touching the database", async () => {
    const { db, issued } = fakeDb();
    const controller = new SetupController(db);
    await expect(controller.skip(ORG_A, "business_profile", reqFor())).rejects.toBeInstanceOf(ConflictException);
    await expect(controller.skip(ORG_A, "handset", reqFor())).rejects.toBeInstanceOf(ConflictException);
    expect(issued).toHaveLength(0);
  });

  it("404s for an id the catalogue does not know", async () => {
    const { db } = fakeDb();
    const controller = new SetupController(db);
    await expect(controller.skip(ORG_A, "not_a_step", reqFor())).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.unskip(ORG_A, "'; DROP TABLE x", reqFor())).rejects.toBeInstanceOf(NotFoundException);
  });

  it("skips an optional step idempotently, and audits only a real change", async () => {
    let inserted = true;
    const { db, issued } = fakeDb((text) =>
      /INSERT INTO org_setup_step_skips/.test(text) ? { rows: [], rowCount: inserted ? 1 : 0 } : { rows: [] },
    );
    const controller = new SetupController(db);
    await expect(controller.skip(ORG_A, "outreach", reqFor())).resolves.toEqual({ skipped: true, stepId: "outreach" });
    expect(issued.some((q) => /org\.setup_step_skipped/.test(q.text))).toBe(true);

    issued.length = 0;
    inserted = false;
    await controller.skip(ORG_A, "outreach", reqFor());
    expect(issued.some((q) => /audit_log/.test(q.text))).toBe(false);
  });

  it("re-opens a finished guide when a skip is undone", async () => {
    const { db, issued } = fakeDb((text) =>
      /DELETE FROM org_setup_step_skips/.test(text) ? { rows: [], rowCount: 1 } : { rows: [] },
    );
    await new SetupController(db).unskip(ORG_A, "outreach", reqFor());
    expect(issued.some((q) => /guide_completed_at = NULL/.test(q.text))).toBe(true);
  });
});

describe("business profile - owner edits, manager reads", () => {
  const auth = { ownerRoleFor: jest.fn() };
  const guard = new OwnerRoleGuard(new Reflector(), auth as unknown as AuthService);

  function contextFor(handler: (...args: never[]) => unknown) {
    return makeExecutionContext({
      cls: BusinessProfileController,
      handler,
      principal: adminKeyPrincipal({ orgId: ORG_A, userId: USER_A }),
    }).context;
  }

  it("403s a manager on the PUT", async () => {
    auth.ownerRoleFor.mockResolvedValue("manager");
    await expect(guard.canActivate(contextFor(BusinessProfileController.prototype.put))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets a manager read it", async () => {
    auth.ownerRoleFor.mockResolvedValue("manager");
    await expect(guard.canActivate(contextFor(BusinessProfileController.prototype.get))).resolves.toBe(true);
  });

  it("lets the owner write it", async () => {
    auth.ownerRoleFor.mockResolvedValue("owner");
    await expect(guard.canActivate(contextFor(BusinessProfileController.prototype.put))).resolves.toBe(true);
  });

  it("refuses a telecaller even the read", async () => {
    auth.ownerRoleFor.mockResolvedValue("telecaller");
    await expect(guard.canActivate(contextFor(BusinessProfileController.prototype.get))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe("login activity - bound to the caller", () => {
  /** Two people's history in one table; the fake applies the query's $1. */
  const TABLE = [
    { auth_user_id: SUBJECT_A, id: "1", kind: "sign_in" },
    { auth_user_id: SUBJECT_B, id: "2", kind: "sign_in" },
    { auth_user_id: SUBJECT_A, id: "3", kind: "sign_out" },
  ].map((r) => ({
    ...r,
    session_id: null,
    console: "owner",
    org_name: "Acme",
    ip: "203.0.113.9",
    user_agent: null,
    created_at: new Date("2026-09-21T10:00:00Z"),
    cursor_at: "2026-09-21T10:00:00.000000Z",
  }));

  function historyDb() {
    return fakeDb((text, values) =>
      /FROM auth_events e/.test(text) ? { rows: TABLE.filter((r) => r.auth_user_id === values[0]) } : { rows: [] },
    );
  }

  it("returns only the caller's own rows", async () => {
    const { db, issued } = historyDb();
    const page = await new AuthEventsController(db).loginActivity({}, reqFor({ authUserId: SUBJECT_A }));
    expect(page.rows.map((r) => r.id).sort()).toEqual(["1", "3"]);
    expect(issued[0].values[0]).toBe(SUBJECT_A);

    const other = await new AuthEventsController(historyDb().db).loginActivity({}, reqFor({ userId: USER_B, authUserId: SUBJECT_B }));
    expect(other.rows.map((r) => r.id)).toEqual(["2"]);
  });

  it("cannot be pointed at somebody else by the query string", async () => {
    const { db, issued } = historyDb();
    await new AuthEventsController(db).loginActivity(
      { authUserId: SUBJECT_B, auth_user_id: SUBJECT_B, cursor: undefined },
      reqFor({ authUserId: SUBJECT_A }),
    );
    expect(issued[0].values[0]).toBe(SUBJECT_A);
  });

  it("refuses without a caller subject rather than reading anybody's", async () => {
    const { db, issued } = historyDb();
    await expect(new AuthEventsController(db).loginActivity({}, reqFor({ authUserId: null }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(issued).toHaveLength(0);
  });
});

describe("recording auth events", () => {
  const base = { sessionId: null, console: null, orgId: null, ip: null, userAgent: null, email: null };

  it("writes nothing for a failed sign-in on an address nobody has", async () => {
    const { db, issued } = fakeDb(() => ({ rows: [] }));
    const result = await new AuthEventsController(db).record(
      { ...base, kind: "sign_in_failed", email: "stranger@example.com" },
      reqFor({ authUserId: null }),
    );
    expect(result).toEqual({ recorded: false });
    expect(issued.some((q) => /INSERT INTO auth_events/.test(q.text))).toBe(false);
  });

  it("stops writing failed sign-ins once the hourly cap is reached", async () => {
    const { db, issued } = fakeDb((text) => {
      if (/FROM users/.test(text)) return { rows: [{ id: USER_A, sso_subject: SUBJECT_A }] };
      if (/count\(\*\)/.test(text)) return { rows: [{ n: 20 }] };
      return { rows: [] };
    });
    const result = await new AuthEventsController(db).record(
      { ...base, kind: "sign_in_failed", email: "abdul@acme.in" },
      reqFor({ authUserId: null }),
    );
    expect(result).toEqual({ recorded: false });
    expect(issued.some((q) => /INSERT INTO auth_events/.test(q.text))).toBe(false);
  });

  it("takes whose event it is from the header, never the body", async () => {
    const { db, issued } = fakeDb(() => ({ rows: [] }));
    await new AuthEventsController(db).record(
      { ...base, kind: "sign_out", authUserId: SUBJECT_B, console: "owner", orgId: ORG_A },
      reqFor({ authUserId: SUBJECT_A }),
    );
    const insert = issued.find((q) => /INSERT INTO auth_events/.test(q.text));
    expect(insert?.values[0]).toBe(SUBJECT_A);
  });

  it("refuses a session event with no caller subject", async () => {
    const { db } = fakeDb();
    await expect(
      new AuthEventsController(db).record({ ...base, kind: "sign_out" }, reqFor({ authUserId: null })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("drops an ip that does not parse instead of throwing on the inet cast", async () => {
    const { db, issued } = fakeDb(() => ({ rows: [] }));
    await new AuthEventsController(db).record(
      { ...base, kind: "sign_out", ip: "not-an-ip, 1.2.3.4" },
      reqFor({ authUserId: SUBJECT_A }),
    );
    const insert = issued.find((q) => /INSERT INTO auth_events/.test(q.text));
    expect(insert?.values[6]).toBeNull();
  });
});
