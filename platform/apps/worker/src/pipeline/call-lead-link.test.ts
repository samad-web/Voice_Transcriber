import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The call→lead linker, tested where it can actually hurt.
 *
 * A wrong predicate here does not throw. It attaches a call to the wrong
 * customer's lead, or un-dismisses a decision somebody already made, or walks
 * back over the same rows forever while the oldest call never gets linked.
 * None of those show up as an error - they show up as a lead page with
 * somebody else's conversation on it, and as a response-time report built on
 * that. So the guard clauses are asserted directly, on the SQL text.
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
  adminQuery.mockReset().mockResolvedValue({ rows: [] });
  orgQuery.mockReset().mockResolvedValue({ rowCount: 0, rows: [] });
  withOrgContext
    .mockReset()
    .mockImplementation((_orgId: string, fn: (client: unknown) => unknown) =>
      fn({ query: orgQuery }),
    );
});

async function load() {
  return import("./call-lead-link");
}

/** The per-org UPDATE, whitespace-collapsed so assertions stay readable. */
function updateSql(): string {
  return String(orgQuery.mock.calls[0]?.[0] ?? "").replace(/\s+/g, " ");
}

function orgListSql(): string {
  return String(adminQuery.mock.calls[0]?.[0] ?? "").replace(/\s+/g, " ");
}

describe("runCallLeadLink - which orgs it visits", () => {
  it("asks only for orgs that actually have something to link", async () => {
    const { runCallLeadLink } = await load();
    await runCallLeadLink();

    const sql = orgListSql();
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("c.lead_id IS NULL");
    expect(sql).toContain("c.lead_link_dismissed_at IS NULL");
    expect(sql).toContain("c.remote_number_hash IS NOT NULL");
    // A suspended tenant's calls are not linked. Same filter every other sweep
    // here applies, and the reason is the same: it should stop doing work for
    // an org that has stopped being a customer.
    expect(sql).toContain("o.status = 'active'");
  });

  it("does no per-org work at all when nothing is outstanding", async () => {
    const { runCallLeadLink } = await load();
    expect(await runCallLeadLink()).toBe(0);
    expect(withOrgContext).not.toHaveBeenCalled();
  });
});

describe("runCallLeadLink - the match itself", () => {
  beforeEach(() => {
    adminQuery.mockResolvedValue({ rows: [{ id: "org-1" }] });
  });

  it("re-enters each org's RLS context rather than writing off the admin pool", async () => {
    const { runCallLeadLink } = await load();
    await runCallLeadLink();
    // The admin pool finds the orgs; it never writes their rows. Losing this
    // would mean an UPDATE with no org predicate reaching every tenant at once.
    expect(withOrgContext).toHaveBeenCalledWith("org-1", expect.any(Function));
  });

  it("joins on workspace_id, not org_id", async () => {
    const { runCallLeadLink } = await load();
    await runCallLeadLink();
    // Two workspaces in one org are two separate books of business, and the
    // unique index the match relies on is per WORKSPACE. Widening this to
    // org_id would put another team's call on this team's lead - and it would
    // also make the match ambiguous, since two workspaces may legitimately
    // hold a lead with the same number.
    expect(updateSql()).toContain("l.workspace_id = c.workspace_id");
    expect(updateSql()).toContain("l.contact_number_hash = c.remote_number_hash");
  });

  it("never touches a call somebody has dismissed", async () => {
    const { runCallLeadLink } = await load();
    await runCallLeadLink();
    // Dismissal is a person's judgement that the call was not business. A
    // sweep that re-linked it would overturn that silently, and the 0094 CHECK
    // would reject the write anyway - so this guard is what keeps the sweep
    // from failing on rows it should be ignoring.
    expect(updateSql()).toContain("lead_link_dismissed_at IS NULL");
  });

  it("never re-links a call that already has a lead", async () => {
    const { runCallLeadLink } = await load();
    await runCallLeadLink();
    // Idempotence, and the thing that makes a console Link durable: a person
    // attaching a call to a lead the hash does not agree with must not be
    // overwritten on the next tick.
    expect(updateSql()).toContain("lead_id IS NULL");
  });

  it("drains oldest-first, so a backlog cannot starve its own head", async () => {
    const { runCallLeadLink } = await load();
    await runCallLeadLink();
    const sql = updateSql();
    expect(sql).toContain("ORDER BY started_at ASC");
    expect(sql).toContain("LIMIT $1");
  });

  it("marks the link as automatic, so the console can tell it from a decision", async () => {
    const { runCallLeadLink } = await load();
    await runCallLeadLink();
    expect(updateSql()).toContain("lead_link_source = 'auto'");
  });

  it("writes first_responded_at nowhere - that is the trigger's job", async () => {
    const { runCallLeadLink } = await load();
    await runCallLeadLink();
    // 0094 installs an AFTER UPDATE OF lead_id trigger that marks the response
    // for OUTGOING calls only. If this file also wrote the column, the console's
    // Link button and this sweep would be two definitions of "responded", and
    // one of them would eventually count an inbound call.
    expect(updateSql()).not.toContain("first_responded_at");
    // `c.direction` is fetched via RETURNING (0134, for notifyMissedCallOwner)
    // but must never be FILTERED or BRANCHED on here - that would be this file
    // quietly growing its own second definition of "missed", the exact drift
    // the comment above warns about for first_responded_at.
    expect(updateSql()).not.toMatch(/direction\s*=/);
    expect(updateSql()).not.toContain("WHEN");
  });

  it("reports how many calls it attached", async () => {
    orgQuery.mockResolvedValue({ rowCount: 7, rows: [] });
    const { runCallLeadLink } = await load();
    expect(await runCallLeadLink()).toBe(7);
  });
});

describe("runCallLeadLink - missed-call notification (0134)", () => {
  beforeEach(() => {
    adminQuery.mockResolvedValue({ rows: [{ id: "org-1" }] });
  });

  const missedRow = {
    id: "call-1",
    lead_id: "lead-1",
    direction: "incoming",
    duration_s: 0,
    status: "NO_AUDIO",
    remote_name: null,
    remote_number_prefix: "98765",
    remote_number_last3: "210",
  };

  it("notifies the lead's owner only for a row that is actually a missed call", async () => {
    orgQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [missedRow] }) // the UPDATE ... RETURNING
      .mockResolvedValueOnce({ rows: [] }) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [{ user_id: "user-1" }] }) // notifyMissedCallOwner's owner lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // the notification INSERT
      .mockResolvedValueOnce({ rows: [] }); // RELEASE SAVEPOINT

    const { runCallLeadLink } = await load();
    await runCallLeadLink();

    const sqlCalls = orgQuery.mock.calls.map((c) => String(c[0]));
    expect(sqlCalls.some((s) => s.includes("SAVEPOINT missed_call_notify"))).toBe(true);
    expect(sqlCalls.some((s) => s.includes("INSERT INTO notifications"))).toBe(true);
    // The dedupe key ties the notification to this call, not to the tick -
    // a replayed sweep must not ring the bell twice for the same event.
    expect(sqlCalls.some((s) => s.includes("dedupe_key"))).toBe(true);
  });

  it("stays quiet for an answered call, an outgoing call, or one still mid-pipeline", async () => {
    for (const row of [
      { ...missedRow, duration_s: 4 }, // answered
      { ...missedRow, direction: "outgoing" }, // our own attempt, not a missed inbound call
      { ...missedRow, status: "TRANSCRIBING" }, // not yet terminal
    ]) {
      orgQuery.mockReset().mockResolvedValueOnce({ rowCount: 1, rows: [row] });
      const { runCallLeadLink } = await load();
      await runCallLeadLink();
      // Exactly the one UPDATE call - no SAVEPOINT, no notification attempt.
      expect(orgQuery).toHaveBeenCalledTimes(1);
    }
  });

  it("rolls back to the savepoint and keeps going when a notification fails", async () => {
    orgQuery
      .mockResolvedValueOnce({ rowCount: 2, rows: [missedRow, { ...missedRow, id: "call-2" }] })
      .mockResolvedValueOnce({ rows: [] }) // SAVEPOINT for call-1
      .mockRejectedValueOnce(new Error("db hiccup")) // call-1's owner lookup blows up
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK TO SAVEPOINT for call-1
      .mockResolvedValueOnce({ rows: [] }) // SAVEPOINT for call-2
      .mockResolvedValueOnce({ rows: [{ user_id: "user-2" }] }) // call-2's owner lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // call-2's notification INSERT
      .mockResolvedValueOnce({ rows: [] }); // RELEASE SAVEPOINT for call-2

    const { runCallLeadLink } = await load();
    // The failure is swallowed - it must not fail the whole tick, and the
    // count already reflects rows LINKED (both calls), which happened
    // regardless of one notification failing.
    await expect(runCallLeadLink()).resolves.toBe(2);
    const sqlCalls = orgQuery.mock.calls.map((c) => String(c[0]));
    expect(sqlCalls.filter((s) => s.includes("ROLLBACK TO SAVEPOINT")).length).toBe(1);
    expect(sqlCalls.filter((s) => s.includes("RELEASE SAVEPOINT")).length).toBe(1);
  });
});

describe("runCallLeadLink - failure isolation", () => {
  it("carries on to the next tenant when one org's update throws", async () => {
    adminQuery.mockResolvedValue({ rows: [{ id: "org-1" }, { id: "org-2" }] });
    orgQuery
      .mockRejectedValueOnce(new Error("deadlock detected"))
      .mockResolvedValueOnce({ rowCount: 3, rows: [] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { runCallLeadLink } = await load();
    // The failed org is retried on the next tick for free: the sweep converges
    // from whatever state it finds rather than accumulating, so nothing is lost.
    expect(await runCallLeadLink()).toBe(3);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("startCallLeadLinkSweep", () => {
  it("single-flights, so a slow tick cannot overlap the next one", async () => {
    vi.useFakeTimers();
    adminQuery.mockResolvedValue({ rows: [{ id: "org-1" }] });
    // A tick that never settles - the exact shape a large backlog produces.
    let release: (() => void) | undefined;
    orgQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ rowCount: 1, rows: [] });
        }),
    );

    const { startCallLeadLinkSweep } = await load();
    const timer = startCallLeadLinkSweep();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    // Two intervals elapsed, one pass in flight: the second must not have
    // started a second scan over rows the first is still updating.
    expect(adminQuery).toHaveBeenCalledTimes(1);

    release?.();
    clearInterval(timer);
    vi.useRealTimers();
  });
});
