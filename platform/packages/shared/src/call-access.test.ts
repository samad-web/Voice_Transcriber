import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CALL_ACCESS_MAX_WINDOW_MS,
  CallAccessApprovalInput,
  CallAccessOtpInput,
  CallAccessRequestInput,
  callAccessBlockedReason,
  isCallAccessLive,
  validateCallAccessWindow,
} from "./call-access";

/** Same walk-up as notification-kinds.test.ts - the package compiles as CommonJS. */
const MIGRATIONS_DIR = (() => {
  let dir = resolve(process.cwd());
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, "packages", "db", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("packages/db/migrations not found above " + process.cwd());
})();

const migrationSql = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");

const NOW = new Date("2026-09-19T12:00:00.000Z");
const live = {
  status: "approved" as const,
  grantedStart: "2026-09-19T11:00:00.000Z",
  grantedEnd: "2026-09-19T13:00:00.000Z",
};

describe("isCallAccessLive", () => {
  it("is live only inside an approved window", () => {
    expect(isCallAccessLive(live, NOW)).toBe(true);
    expect(isCallAccessLive({ ...live, status: "pending" }, NOW)).toBe(false);
    expect(isCallAccessLive({ ...live, status: "denied" }, NOW)).toBe(false);
    expect(isCallAccessLive({ ...live, status: "revoked" }, NOW)).toBe(false);
  });

  it("treats the end as exclusive and the start as inclusive", () => {
    // The boundary matters: a grant that is still live at its stated end is a
    // grant that runs a request longer than the customer agreed to.
    expect(isCallAccessLive(live, new Date("2026-09-19T11:00:00.000Z"))).toBe(true);
    expect(isCallAccessLive(live, new Date("2026-09-19T12:59:59.999Z"))).toBe(true);
    expect(isCallAccessLive(live, new Date("2026-09-19T13:00:00.000Z"))).toBe(false);
    expect(isCallAccessLive(live, new Date("2026-09-19T10:59:59.999Z"))).toBe(false);
  });

  it("fails CLOSED on a bound it cannot read", () => {
    // The property the whole gate rests on: a grant we cannot read the end of
    // is not a grant. Anything else turns a data bug into permanent access.
    expect(isCallAccessLive({ ...live, grantedEnd: null }, NOW)).toBe(false);
    expect(isCallAccessLive({ ...live, grantedStart: null }, NOW)).toBe(false);
    expect(isCallAccessLive({ ...live, grantedEnd: "not a date" }, NOW)).toBe(false);
  });

  it("accepts Date objects as the pg driver returns them", () => {
    expect(
      isCallAccessLive(
        { status: "approved", grantedStart: new Date(live.grantedStart), grantedEnd: new Date(live.grantedEnd) },
        NOW,
      ),
    ).toBe(true);
  });
});

describe("callAccessBlockedReason", () => {
  it("tells the four not-yet/no-longer cases apart", () => {
    expect(callAccessBlockedReason(live, NOW)).toBeNull();
    expect(callAccessBlockedReason(null, NOW)).toBe("none");
    expect(callAccessBlockedReason({ ...live, status: "pending" }, NOW)).toBe("pending");
    expect(callAccessBlockedReason({ ...live, status: "denied" }, NOW)).toBe("denied");
    expect(callAccessBlockedReason({ ...live, status: "revoked" }, NOW)).toBe("revoked");
    expect(callAccessBlockedReason(live, new Date("2026-09-19T09:00:00.000Z"))).toBe("not_started");
    expect(callAccessBlockedReason(live, new Date("2026-09-19T18:00:00.000Z"))).toBe("expired");
  });

  it("agrees with isCallAccessLive on every case", () => {
    // Two functions, one truth. A console that said "active" while the guard
    // said 403 would be the most confusing possible bug.
    const cases = [
      [live, NOW],
      [live, new Date("2026-09-19T09:00:00.000Z")],
      [live, new Date("2026-09-19T18:00:00.000Z")],
      [{ ...live, status: "pending" as const }, NOW],
      [{ ...live, grantedEnd: null }, NOW],
    ] as const;
    for (const [grant, at] of cases) {
      expect(callAccessBlockedReason(grant, at) === null).toBe(isCallAccessLive(grant, at));
    }
  });
});

describe("validateCallAccessWindow", () => {
  it("refuses a window that does not run forwards", () => {
    expect(validateCallAccessWindow(live.grantedEnd, live.grantedStart).ok).toBe(false);
    expect(validateCallAccessWindow(live.grantedStart, live.grantedStart).ok).toBe(false);
  });

  it("refuses a window longer than the ceiling, and permits one exactly at it", () => {
    const start = Date.parse(live.grantedStart);
    const atCeiling = new Date(start + CALL_ACCESS_MAX_WINDOW_MS).toISOString();
    const overCeiling = new Date(start + CALL_ACCESS_MAX_WINDOW_MS + 1000).toISOString();
    expect(validateCallAccessWindow(live.grantedStart, atCeiling).ok).toBe(true);
    expect(validateCallAccessWindow(live.grantedStart, overCeiling).ok).toBe(false);
  });

  it("matches the ceiling the database enforces", () => {
    // 0122's `call_access_window_is_bounded` is the authority; this is the
    // courtesy copy that turns a constraint violation into a sentence. If the
    // two drift, the console starts offering windows the database rejects.
    const sql = migrationSql();
    expect(sql).toMatch(/call_access_window_is_bounded/);
    const match = sql.match(/granted_start \+ interval '(\d+) days'/);
    expect(match).not.toBeNull();
    expect(Number(match![1]) * 24 * 60 * 60 * 1000).toBe(CALL_ACCESS_MAX_WINDOW_MS);
  });
});

describe("the database keeps the invariants, not just the API", () => {
  const sql = migrationSql();

  it("cannot store an approved grant without an end", () => {
    // The single most important line in the migration. Everything else is
    // policy; this is what makes "granted" mean "granted until".
    expect(sql).toMatch(/call_access_approved_is_complete/);
    expect(sql).toMatch(/status <> 'approved'[\s\S]*granted_end\s+IS NOT NULL/);
  });

  it("pairs an OTP decision with no user and a console decision with one", () => {
    expect(sql).toMatch(/\(decided_via = 'otp'\) = \(decided_by_user_id IS NULL\)/);
  });

  it("keeps one open request per operator per org", () => {
    // What makes "every attempt alerts the administrator" survivable: one
    // console page fans out to four call routes at once.
    expect(sql).toMatch(/call_access_requests_one_open/);
    expect(sql).toMatch(/WHERE status = 'pending'/);
  });

  it("leaves existing orgs exactly as permissive as they were", () => {
    // 0103's rule. A deploy that silently locked support out of two live
    // customers would read as an outage, not a feature.
    expect(sql).toMatch(/UPDATE organizations\s+SET call_access_gate_enabled = false/);
  });

  it("never grants DELETE on the request ledger", () => {
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON call_access_requests TO aura_app/);
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*ON call_access_requests/);
  });
});

describe("input schemas", () => {
  it("requires a reason - an unexplained request cannot be answered well", () => {
    expect(
      CallAccessRequestInput.safeParse({
        requestedStart: live.grantedStart,
        requestedEnd: live.grantedEnd,
      }).success,
    ).toBe(false);
    expect(
      CallAccessRequestInput.safeParse({
        reason: "   ",
        requestedStart: live.grantedStart,
        requestedEnd: live.grantedEnd,
      }).success,
    ).toBe(false);
  });

  it("never fills in a window the approver left out", () => {
    // The partial/default trap with real consequences: a default here would
    // be the server deciding how long a vendor may listen.
    expect(CallAccessApprovalInput.safeParse({ grantedStart: live.grantedStart }).success).toBe(false);
    expect(CallAccessApprovalInput.safeParse({ grantedEnd: live.grantedEnd }).success).toBe(false);
    expect(CallAccessApprovalInput.safeParse({}).success).toBe(false);
  });

  it("takes exactly six digits as a code", () => {
    expect(CallAccessOtpInput.safeParse({ code: "042913" }).success).toBe(true);
    expect(CallAccessOtpInput.safeParse({ code: "42913" }).success).toBe(false);
    expect(CallAccessOtpInput.safeParse({ code: "0429133" }).success).toBe(false);
    expect(CallAccessOtpInput.safeParse({ code: "abcdef" }).success).toBe(false);
  });
});
