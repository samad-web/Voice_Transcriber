import { beforeEach, describe, expect, it, vi } from "vitest";
import { deviceUnderstandsAlertsSql, HANDSET_ALERT_MAX_PUSHES } from "@aura/shared";

/**
 * Phone alerts (0150). The SQL itself is proven against a real database (see
 * the migration's verification note); these pin the decisions that a later
 * edit could quietly undo - who is NOT alerted, the org predicate on every
 * source, and the push being a contentless doorbell sent once per phone.
 */

const ORG = "00000000-0000-4000-8000-000000000001";

const { adminQuery, orgQuery } = vi.hoisted(() => ({
  adminQuery: vi.fn(),
  orgQuery: vi.fn(),
}));

vi.mock("@aura/db", () => ({
  getAdminPool: () => ({ query: adminQuery }),
  withOrgContext: (_orgId: string, fn: (client: unknown) => Promise<unknown>) => fn({ query: orgQuery }),
}));
vi.mock("./fcm", () => ({ sendPush: vi.fn() }));

import {
  PUSH_LADDER,
  PUSH_STEP_SQL,
  RAISE_SQL,
  pushHandsetAlerts,
  raiseHandsetAlerts,
  raiseParams,
} from "./handset-alerts";

beforeEach(() => {
  adminQuery.mockReset();
  orgQuery.mockReset();
});

describe("RAISE_SQL", () => {
  it("names the org on every source, not only through RLS", () => {
    for (const alias of ["l", "ta", "t", "c"]) {
      expect(RAISE_SQL).toContain(`${alias}.org_id = $1`);
    }
    // Five root reads: leads, task_assignees, tasks (machine-assigned),
    // tasks (follow-ups), calls.
    expect(RAISE_SQL.match(/\b(l|ta|t|c)\.org_id = \$1/g)?.length).toBe(5);
  });

  it("does not tell a telecaller about a lead their own phone created", () => {
    expect(RAISE_SQL).toMatch(
      /NOT \(l\.source_channel IN \('call', 'missed_call'\)\s+AND l\.telecaller_id IS NOT DISTINCT FROM l\.assigned_telecaller_id\)/,
    );
  });

  it("does not tell anyone about their own action, or about their own phone's missed call", () => {
    expect(RAISE_SQL).toContain("x.by IS DISTINCT FROM x.user_id");
    expect(RAISE_SQL).toContain("l.assigned_telecaller_id IS DISTINCT FROM c.telecaller_id");
  });

  it("skips a person who declined, and anybody without an active phone", () => {
    expect(RAISE_SQL).toContain("ta.status <> 'declined'");
    expect(RAISE_SQL.match(/d\.status = 'active' AND d\.removed_at IS NULL/g)?.length).toBe(4);
  });

  it("dedupes every source on the telecaller", () => {
    expect(RAISE_SQL.match(/ON CONFLICT \(telecaller_id, dedupe_key\)/g)?.length).toBe(4);
  });

  it("binds twelve parameters, org first", () => {
    const p = raiseParams(ORG);
    expect(p).toHaveLength(12);
    expect(p[0]).toBe(ORG);
    expect(RAISE_SQL).toContain("$12");
    expect(RAISE_SQL).not.toContain("$13");
    // Styles land where the SQL reads them.
    expect(p.slice(4)).toEqual(["popup", 1440, "notify", 1440, "notify", 120, "notify", 720]);
  });
});

describe("raiseHandsetAlerts", () => {
  it("runs one statement per candidate org and sums what landed", async () => {
    adminQuery.mockResolvedValueOnce({ rows: [{ org_id: ORG }] });
    orgQuery.mockResolvedValueOnce({ rows: [{ leads: 2, tasks: 1, due: 0, missed: 1 }] });
    expect(await raiseHandsetAlerts()).toBe(4);
    expect(orgQuery).toHaveBeenCalledTimes(1);
    expect(orgQuery.mock.calls[0][1][0]).toBe(ORG);
  });

  it("keeps going when one org fails", async () => {
    adminQuery.mockResolvedValueOnce({ rows: [{ org_id: "a" }, { org_id: "b" }] });
    orgQuery.mockRejectedValueOnce(new Error("boom"));
    orgQuery.mockResolvedValueOnce({ rows: [{ leads: 1, tasks: 0, due: 0, missed: 0 }] });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await raiseHandsetAlerts()).toBe(1);
    err.mockRestore();
  });
});

describe("pushHandsetAlerts", () => {
  it("rings each phone once, with no content in the push", async () => {
    adminQuery.mockResolvedValueOnce({ rows: [{ org_id: ORG }] });
    orgQuery.mockResolvedValueOnce({ rows: [{ fcm_token: "tok-1" }, { fcm_token: "tok-2" }] });
    const push = vi.fn(async () => true);
    expect(await pushHandsetAlerts(push)).toBe(2);
    expect(push).toHaveBeenCalledTimes(2);
    for (const call of push.mock.calls as unknown as [string, Record<string, string>][]) {
      expect(call[1]).toEqual({ action: "alert" });
    }
  });

  it("steps the ladder in the same statement that picks the phones", async () => {
    adminQuery.mockResolvedValueOnce({ rows: [{ org_id: ORG }] });
    orgQuery.mockResolvedValueOnce({ rows: [] });
    await pushHandsetAlerts(vi.fn());
    const [sql, params] = orgQuery.mock.calls[0];
    expect(sql).toBe(PUSH_STEP_SQL);
    expect(params).toEqual([HANDSET_ALERT_MAX_PUSHES, PUSH_LADDER, ORG]);
    expect(PUSH_STEP_SQL).toContain("a.org_id = $3");
    expect(PUSH_STEP_SQL).toContain("d.org_id = $3");
  });

  it("does not ring a phone known to run an app too old to show alerts", () => {
    expect(PUSH_STEP_SQL).toContain(deviceUnderstandsAlertsSql("d"));
  });

  it("counts only pushes FCM accepted", async () => {
    adminQuery.mockResolvedValueOnce({ rows: [{ org_id: ORG }] });
    orgQuery.mockResolvedValueOnce({ rows: [{ fcm_token: "a" }, { fcm_token: "b" }] });
    const push = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await pushHandsetAlerts(push)).toBe(1);
  });
});

describe("PUSH_LADDER", () => {
  it("has one delay per allowed push, starting at a minute", () => {
    expect(PUSH_LADDER).toHaveLength(HANDSET_ALERT_MAX_PUSHES);
    expect(PUSH_LADDER[0]).toBe(60);
    expect(PUSH_LADDER.at(-1)).toBe(1800);
  });
});
