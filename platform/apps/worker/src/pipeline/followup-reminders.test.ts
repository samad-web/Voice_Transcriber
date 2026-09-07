import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The follow-up escalation ladder, tested on the two properties that decide
 * whether people keep reading the bell.
 *
 * It nags at most once per task per day, and it nags the REP. Both are
 * enforced in SQL rather than in TypeScript - the dedupe key and the
 * assignee column - so the SQL is what is asserted. A test that mocked the
 * database's uniqueness would be testing its own mock.
 */

const adminQuery = vi.fn();
const orgQuery = vi.fn();
const withOrgContext = vi.fn();

vi.mock("@aura/db", () => ({
  getAdminPool: () => ({ query: adminQuery }),
  withOrgContext: (orgId: string, fn: (client: unknown) => unknown) =>
    withOrgContext(orgId, fn) as unknown,
}));

beforeEach(() => {
  vi.resetModules();
  adminQuery.mockReset().mockResolvedValue({ rows: [{ id: "org-1" }] });
  orgQuery.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
  withOrgContext
    .mockReset()
    .mockImplementation((_orgId: string, fn: (client: unknown) => unknown) =>
      fn({ query: orgQuery }),
    );
});

async function load() {
  return import("./followup-reminders");
}

function sweepSql(): string {
  return String(orgQuery.mock.calls[0]?.[0] ?? "").replace(/\s+/g, " ");
}

describe("runFollowupReminders - what it raises", () => {
  it("writes a notification and nothing else", async () => {
    const { runFollowupReminders } = await load();
    await runFollowupReminders();
    const sql = sweepSql();
    // Safety rule 3, asserted rather than assumed. `notifications` (0048) is
    // in-app only and reaches nobody who has not already signed in. If this
    // sweep ever grew an outbox insert, the customer would be the one getting
    // chased for the rep's missed follow-up.
    expect(sql).toContain("INSERT INTO notifications");
    expect(sql).not.toContain("outbox");
    expect(sql).not.toContain("message");
  });

  it("addresses the assignee, never the contact", async () => {
    const { runFollowupReminders } = await load();
    await runFollowupReminders();
    expect(sweepSql()).toContain("t.assignee_user_id IS NOT NULL");
    expect(sweepSql()).toContain("d.assignee_user_id, 'task_due'");
  });

  it("dedupes per task per LOCAL day", async () => {
    const { runFollowupReminders } = await load();
    await runFollowupReminders();
    const sql = sweepSql();
    // The key, and the conflict clause that makes it binding. Without both,
    // "this is overdue" stays true and re-fires every tick until somebody
    // acts - which is how a notification bell gets ignored.
    expect(sql).toContain("'task-due:' || d.id || ':' || d.today");
    expect(sql).toContain("ON CONFLICT (user_id, dedupe_key)");
    expect(sql).toContain("DO NOTHING");
    // The day is the ORG's, not the database's. On a UTC box an Indian floor
    // rolls over at 05:30 local and the morning's nag would be hours late.
    expect(sql).toContain("org_reporting_today()");
    expect(sql).not.toContain("current_date");
  });

  it("counts only the notices that actually landed", async () => {
    const { runFollowupReminders } = await load();
    await runFollowupReminders();
    const sql = sweepSql();
    // reminders_sent is driven off RETURNING from the insert, so a second run
    // on the same day increments nothing. Counting the SELECT instead would
    // make "chased 4 times" mean "the sweep ran 4 times".
    expect(sql).toContain("RETURNING task_id");
    expect(sql).toContain("reminders_sent = t.reminders_sent + 1");
  });

  it("stops nagging after a bounded number of days", async () => {
    const { runFollowupReminders } = await load();
    await runFollowupReminders();
    // A follow-up forty days past due is not rescued by a forty-first notice.
    // Without the bound the ladder becomes permanent background noise, which
    // is the same failure as no dedupe key by a slower route.
    expect(sweepSql()).toContain("org_reporting_today() - $1::int");
    expect(orgQuery.mock.calls[0]?.[1]).toEqual([30]);
  });

  it("never chases a completed or cancelled follow-up", async () => {
    const { runFollowupReminders } = await load();
    await runFollowupReminders();
    expect(sweepSql()).toContain("t.status = 'open'");
  });
});

describe("runFollowupReminders - which orgs", () => {
  it("skips an org with no dated open follow-ups", async () => {
    adminQuery.mockResolvedValue({ rows: [] });
    const { runFollowupReminders } = await load();
    expect(await runFollowupReminders()).toBe(0);
    expect(withOrgContext).not.toHaveBeenCalled();
  });

  it("re-enters each org's RLS context rather than writing off the admin pool", async () => {
    const { runFollowupReminders } = await load();
    await runFollowupReminders();
    expect(withOrgContext).toHaveBeenCalledWith("org-1", expect.any(Function));
  });

  it("carries on when one tenant fails", async () => {
    adminQuery.mockResolvedValue({ rows: [{ id: "org-1" }, { id: "org-2" }] });
    orgQuery
      .mockRejectedValueOnce(new Error("statement timeout"))
      .mockResolvedValueOnce({ rowCount: 2, rows: [] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runFollowupReminders } = await load();
    expect(await runFollowupReminders()).toBe(2);
    spy.mockRestore();
  });
});
