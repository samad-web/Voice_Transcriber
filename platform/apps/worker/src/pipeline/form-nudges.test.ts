import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The abandoned-form nudge, tested where it can hurt: WHO it decides to message.
 *
 * These go to people who did not finish a form — the least engaged audience the
 * funnel contacts — over an ordinary WhatsApp account on Evolution's unofficial
 * protocol, where volume to non-contacts is what gets a number banned. A wrong
 * predicate does not throw; it messages strangers. So every guard clause is
 * asserted as query text and fails if it is deleted.
 */

const query = vi.fn();

vi.mock("@aura/db", () => ({
  getAdminPool: () => ({ query }),
}));

const enqueueFollowUp = vi.fn();
vi.mock("./funnel-followup-outbox", () => ({
  enqueueFollowUp: (...args: unknown[]) => enqueueFollowUp(...args),
}));

const ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  query.mockReset().mockResolvedValue({ rows: [] });
  enqueueFollowUp.mockReset().mockResolvedValue(undefined);
  process.env = { ...ENV };
});

async function load() {
  return import("./form-nudges");
}

/** SQL of the nth query, whitespace-collapsed. */
function sql(n = 0): string {
  return String(query.mock.calls[n]?.[0] ?? "").replace(/\s+/g, " ");
}

describe("who it selects", () => {
  it("only enquiries still stuck at step 1", async () => {
    const { sweepFormNudges } = await load();
    await sweepFormNudges();
    // The status IS the freshness check. Step 2 moves the row to
    // qualified/disqualified, so somebody who came back on their own is
    // excluded without the sweep needing to know they did.
    expect(sql()).toContain("s.status = 'contact_captured'");
  });

  it("only those with a number to message", async () => {
    const { sweepFormNudges } = await load();
    await sweepFormNudges();
    // Queuing without one dead-letters after six attempts and reads in the
    // console as a delivery failure rather than as missing data.
    expect(sql()).toContain("COALESCE(s.whatsapp_e164, s.phone_e164) IS NOT NULL");
  });

  it("skips anyone who already has a row for that stage, whatever its status", async () => {
    const { sweepFormNudges } = await load();
    await sweepFormNudges();
    const text = sql();
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain("f.channel = 'whatsapp'");
    // A status filter here would make 'sent' and 'dead' rows invisible and
    // re-queue the same nudge on every tick, forever.
    expect(text).not.toMatch(/f\.status\s*=/);
  });

  it("has both an earliest AND a latest bound", async () => {
    const { sweepFormNudges } = await load();
    await sweepFormNudges();
    const text = sql();
    // Lower bound: do not nudge somebody who is still filling the form.
    expect(text).toContain("s.created_at <= now() - make_interval(mins =>");
    // Upper bound: a five-week-old half-filled form opened with "you started
    // telling us about your business" reads as a harvested number.
    expect(text).toContain("s.created_at > now() - make_interval(days =>");
  });
});

describe("the two stages", () => {
  it("runs exactly two, in order, and never a third", async () => {
    const { sweepFormNudges } = await load();
    await sweepFormNudges();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]?.[2]).toBe("resume_form");
    expect(query.mock.calls[1]?.[1]?.[2]).toBe("resume_form_2");
  });

  it("defaults to 2 hours and 2 days, both measured from the enquiry", async () => {
    const { sweepFormNudges } = await load();
    await sweepFormNudges();
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(120);
    expect(query.mock.calls[1]?.[1]?.[0]).toBe(2880);
  });

  it("takes the delays from the environment when set", async () => {
    process.env.FUNNEL_NUDGE_FIRST_MINUTES = "30";
    process.env.FUNNEL_NUDGE_SECOND_MINUTES = "4320";
    const { sweepFormNudges } = await load();
    await sweepFormNudges();
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(30);
    expect(query.mock.calls[1]?.[1]?.[0]).toBe(4320);
  });

  it("ignores a nonsense delay rather than sending immediately", async () => {
    // "" is what docker-compose `${VAR:-}` produces, and Number("") is 0 —
    // which as an interval means "nudge everyone the instant they arrive".
    // The same empty-string class of bug silently disabled the calendar on
    // 2026-08-10.
    process.env.FUNNEL_NUDGE_FIRST_MINUTES = "";
    const { sweepFormNudges } = await load();
    await sweepFormNudges();
    expect(query.mock.calls[0]?.[1]?.[0]).toBe(120);
  });
});

describe("what it queues", () => {
  it("queues one WhatsApp nudge per submission per stage", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "sub-1" }, { id: "sub-2" }] })
      .mockResolvedValueOnce({ rows: [{ id: "sub-3" }] });
    const { sweepFormNudges } = await load();

    expect(await sweepFormNudges()).toBe(3);
    expect(enqueueFollowUp).toHaveBeenCalledTimes(3);
    for (const call of enqueueFollowUp.mock.calls) expect(call[3]).toBe("whatsapp");
  });

  it("keeps going when one submission fails", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "bad" }, { id: "good" }] });
    enqueueFollowUp
      .mockRejectedValueOnce(new Error("constraint violation"))
      .mockResolvedValue(undefined);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { sweepFormNudges } = await load();
    expect(await sweepFormNudges()).toBe(1);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
