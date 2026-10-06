import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The attempt→call matcher, tested where it can actually hurt.
 *
 * A wrong predicate here does not throw. It attaches one customer's recording
 * to a different attempt - in a report a supervisor uses to judge an agent -
 * or it links nothing at all while every screen stays green and the dialer
 * quietly loses the only advantage it has over GoDial. Neither shows up as an
 * error, so the guard clauses are asserted directly, on the SQL text and on
 * the arrays the sweep decides to write.
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
    .mockImplementation((_orgId: string, fn: (client: unknown) => unknown) => fn({ query: orgQuery }));
});

async function load() {
  return import("./dial-attempt-link");
}

const flat = (sql: unknown): string => String(sql ?? "").replace(/\s+/g, " ");

/** Every statement this tick issued inside the org transaction. */
function issued(): Array<{ text: string; values: unknown[] }> {
  return orgQuery.mock.calls.map((c) => ({ text: flat(c[0]), values: (c[1] ?? []) as unknown[] }));
}

function candidates(rows: Array<[string, string, number, number]>) {
  adminQuery.mockResolvedValue({ rows: [{ id: "org-1" }] });
  orgQuery.mockImplementation(async (text: string) => {
    if (/WITH pending AS/.test(text)) {
      return {
        rows: rows.map(([attempt_id, call_id, calls_for_attempt, attempts_for_call]) => ({
          attempt_id,
          call_id,
          calls_for_attempt,
          attempts_for_call,
        })),
        rowCount: rows.length,
      };
    }
    return { rows: [], rowCount: rows.length };
  });
}

describe("which orgs it visits", () => {
  it("asks only for orgs with an unlinked attempt inside the window", async () => {
    const { runDialAttemptLink } = await load();
    await runDialAttemptLink();

    const sql = flat(adminQuery.mock.calls[0]?.[0]);
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("a.call_id IS NULL");
    // An attempt a person has been asked to resolve is not pending work.
    expect(sql).toContain("a.link_ambiguous_at IS NULL");
    expect(sql).toContain("make_interval(hours => $1::int)");
    // A suspended tenant's attempts are not linked - the same filter every
    // other sweep applies, for the same reason.
    expect(sql).toContain("o.status = 'active'");
  });

  it("does no per-org work when nothing is outstanding", async () => {
    const { runDialAttemptLink } = await load();
    expect(await runDialAttemptLink()).toEqual({ linked: 0, ambiguous: 0 });
    expect(withOrgContext).not.toHaveBeenCalled();
  });

  it("re-enters each org's RLS context rather than writing off the admin pool", async () => {
    candidates([["att-1", "call-1", 1, 1]]);
    const { runDialAttemptLink } = await load();
    await runDialAttemptLink();
    // Losing this would mean an UPDATE with no org predicate reaching every
    // tenant's attempts at once.
    expect(withOrgContext).toHaveBeenCalledWith("org-1", expect.any(Function));
    expect(adminQuery).toHaveBeenCalledTimes(1);
  });

  it("keeps one tenant's failure from stopping the others", async () => {
    adminQuery.mockResolvedValue({ rows: [{ id: "org-1" }, { id: "org-2" }] });
    let call = 0;
    withOrgContext.mockImplementation(async (_orgId: string, fn: (c: unknown) => unknown) => {
      call += 1;
      if (call === 1) throw new Error("boom");
      return fn({ query: orgQuery });
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runDialAttemptLink } = await load();
    await runDialAttemptLink();
    expect(withOrgContext).toHaveBeenCalledTimes(2);
  });
});

describe("the match predicate", () => {
  beforeEach(() => candidates([]));

  it("is the §10 rule, literally", async () => {
    const { runDialAttemptLink } = await load();
    await runDialAttemptLink();
    const sql = issued()[0].text;

    expect(sql).toContain("c.device_id = p.device_id");
    expect(sql).toContain("c.remote_number_key = p.number_key");
    expect(sql).toContain("c.started_at BETWEEN p.dialed_at - make_interval(secs => $3::int)");
    expect(sql).toContain("p.dialed_at + make_interval(secs => $4::int)");
  });

  it("says 'outgoing' and not the doc's 'out'", async () => {
    const { runDialAttemptLink } = await load();
    await runDialAttemptLink();
    const sql = issued()[0].text;
    // §10 writes `calls.direction = 'out'`. There is no such value - the CHECK
    // has been ('incoming','outgoing') since 0001_init - so the doc's literal
    // would match zero rows and link nothing, silently, forever. 0157's
    // backfill hit the same typo from the other side.
    expect(sql).toContain("c.direction = 'outgoing'");
    expect(sql).not.toContain("direction = 'out'");
  });

  it("refuses a call another attempt already claimed", async () => {
    const { runDialAttemptLink } = await load();
    await runDialAttemptLink();
    expect(issued()[0].text).toContain("NOT EXISTS (SELECT 1 FROM dial_attempts a2 WHERE a2.call_id = c.id)");
  });

  it("binds the window from the shared constants, not from a literal", async () => {
    const { runDialAttemptLink } = await load();
    await runDialAttemptLink();
    const [, hours, before, after] = issued()[0].values as number[];
    // The same three numbers the handset and the console read. A second copy
    // here is how the preview and the matcher come to disagree about which
    // call belongs to which dial.
    expect([hours, before, after]).toEqual([24, 30, 120]);
  });
});

describe("exactly one candidate", () => {
  it("links it", async () => {
    candidates([["att-1", "call-1", 1, 1]]);
    const { runDialAttemptLink } = await load();
    expect(await runDialAttemptLink()).toEqual({ linked: 1, ambiguous: 0 });

    const link = issued().find((q) => /SET call_id = v.call_id/.test(q.text));
    expect(link?.values).toEqual([["att-1"], ["call-1"]]);
    // Re-asserted in the statement, not only in the candidate query: the read
    // and the write are two round trips and a console link could land between.
    expect(link?.text).toContain("a.call_id IS NULL");
  });

  it("writes no ambiguity row", async () => {
    candidates([["att-1", "call-1", 1, 1]]);
    const { runDialAttemptLink } = await load();
    await runDialAttemptLink();
    expect(issued().some((q) => /link_ambiguous_at = now\(\)/.test(q.text))).toBe(false);
  });
});

describe("zero candidates", () => {
  it("leaves the attempt alone for the next tick", async () => {
    candidates([]);
    const { runDialAttemptLink } = await load();
    expect(await runDialAttemptLink()).toEqual({ linked: 0, ambiguous: 0 });
    // The candidate read, and nothing else. A dial that never connected is
    // the NORMAL case - it is the whole reason dial_attempts is not folded
    // into calls - so "no match" must cost one query and no writes.
    expect(issued()).toHaveLength(1);
  });
});

describe("two or more candidates - the case that must not guess", () => {
  it("refuses an attempt with two possible calls, and links nothing", async () => {
    // An agent redialling the same number inside two minutes. 0146 set the
    // precedent: a collision means ask a person, never pick the newest.
    candidates([
      ["att-1", "call-1", 2, 1],
      ["att-1", "call-2", 2, 1],
    ]);
    const { runDialAttemptLink } = await load();
    expect(await runDialAttemptLink()).toEqual({ linked: 0, ambiguous: 1 });

    expect(issued().some((q) => /SET call_id = v.call_id/.test(q.text))).toBe(false);
    const amb = issued().find((q) => /link_ambiguous_at = now\(\)/.test(q.text));
    expect(amb?.values).toEqual([["att-1"], [2]]);
  });

  it("stamps the attempt once, not once per candidate", async () => {
    candidates([
      ["att-1", "call-1", 3, 1],
      ["att-1", "call-2", 3, 1],
      ["att-1", "call-3", 3, 1],
    ]);
    const { runDialAttemptLink } = await load();
    await runDialAttemptLink();
    const amb = issued().find((q) => /link_ambiguous_at = now\(\)/.test(q.text));
    expect(amb?.values).toEqual([["att-1"], [3]]);
  });

  it("refuses the mirror case too: two attempts, one call", async () => {
    // §10 names only "two calls for one attempt". This direction is just as
    // real and fails worse - 0159's unique index on call_id makes the second
    // write throw - so both attempts are left for a person.
    candidates([
      ["att-1", "call-1", 1, 2],
      ["att-2", "call-1", 1, 2],
    ]);
    const { runDialAttemptLink } = await load();
    expect(await runDialAttemptLink()).toEqual({ linked: 0, ambiguous: 2 });
    const amb = issued().find((q) => /link_ambiguous_at = now\(\)/.test(q.text));
    expect(amb?.values).toEqual([
      ["att-1", "att-2"],
      [1, 1],
    ]);
  });

  it("still links the unambiguous pairs in the same tick", async () => {
    // One agent's collision must not stall the rest of the floor's matching.
    candidates([
      ["att-1", "call-1", 2, 1],
      ["att-1", "call-2", 2, 1],
      ["att-9", "call-9", 1, 1],
    ]);
    const { runDialAttemptLink } = await load();
    expect(await runDialAttemptLink()).toEqual({ linked: 1, ambiguous: 1 });
    const link = issued().find((q) => /SET call_id = v.call_id/.test(q.text));
    expect(link?.values).toEqual([["att-9"], ["call-9"]]);
  });

  it("never revisits an attempt it already refused", async () => {
    candidates([]);
    const { runDialAttemptLink } = await load();
    await runDialAttemptLink();
    // In the candidate read AND in the ambiguity write, so a second tick
    // cannot re-stamp (and re-count) a decision somebody is already looking at.
    expect(issued()[0].text).toContain("a.link_ambiguous_at IS NULL");
  });
});

describe("startDialAttemptLinkSweep", () => {
  it("single-flights, so a slow tick cannot overlap itself", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    adminQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ rows: [] });
        }),
    );
    const { startDialAttemptLinkSweep } = await load();
    const timer = startDialAttemptLinkSweep();

    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    expect(adminQuery).toHaveBeenCalledTimes(1);

    release?.();
    clearInterval(timer);
    vi.useRealTimers();
  });

  it("is configurable, and defaults to a minute", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(global, "setInterval");
    const { startDialAttemptLinkSweep } = await load();
    clearInterval(startDialAttemptLinkSweep());
    expect(spy.mock.calls[0]?.[1]).toBe(60_000);
    spy.mockRestore();
    vi.useRealTimers();
  });
});
