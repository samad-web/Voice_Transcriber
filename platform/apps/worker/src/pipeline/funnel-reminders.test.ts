import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reminder sweep, tested at the seam that actually matters: WHICH enquiries
 * it selects.
 *
 * This is the only job in the platform that messages someone who did not ask to
 * be messaged, from an unofficial WhatsApp account. A wrong predicate here does
 * not produce a stack trace - it produces real messages to real people, and the
 * account carries a ban risk for exactly that. So the query is asserted as
 * text: every guard clause has a test that fails if it is deleted.
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

afterEach(() => {
  process.env = { ...ENV };
});

async function load() {
  return import("./funnel-reminders");
}

describe("the switch", () => {
  it("does nothing at all when the flag is unset", async () => {
    delete process.env.FUNNEL_REMINDERS_ENABLED;
    const { sweepFunnelReminders } = await load();
    expect(await sweepFunnelReminders()).toBe(0);
    // Not one query. The point is that an unconfigured deployment cannot send
    // anything, not that it sends nothing it happens to find.
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["false", "1", "yes", "TRUE ", ""])("treats %o as off unless it is 'true'", async (v) => {
    process.env.FUNNEL_REMINDERS_ENABLED = v;
    const { sweepFunnelReminders, remindersEnabled } = await load();
    const expected = v.trim().toLowerCase() === "true";
    expect(remindersEnabled()).toBe(expected);
    if (!expected) expect(await sweepFunnelReminders()).toBe(0);
  });

  it("runs when the flag is exactly true", async () => {
    process.env.FUNNEL_REMINDERS_ENABLED = "true";
    const { sweepFunnelReminders } = await load();
    await sweepFunnelReminders();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("who it selects", () => {
  beforeEach(() => {
    process.env.FUNNEL_REMINDERS_ENABLED = "true";
  });

  const sql = async (): Promise<string> => {
    const { sweepFunnelReminders } = await load();
    await sweepFunnelReminders();
    return (query.mock.calls[0]?.[0] as string).replace(/\s+/g, " ");
  };

  it("only nudges enquiries that are still open", async () => {
    // 'disqualified' and 'rejected' must never match: being told no and then
    // chased is the worst message this system could send.
    expect(await sql()).toContain("s.status IN ('contact_captured', 'qualified')");
  });

  it("excludes customers and anyone a human rejected", async () => {
    const q = await sql();
    expect(q).toContain("s.converted_org_id IS NULL");
    expect(q).toContain("s.rejected_at IS NULL");
  });

  it("bounds the window at BOTH ends", async () => {
    // The lower bound alone would sweep up every enquiry ever received on the
    // first run - months-old contacts, dozens at once, from an account that
    // gets banned for precisely that pattern.
    const q = await sql();
    expect(q).toContain("s.created_at < now() - make_interval(days => $1)");
    expect(q).toContain("s.created_at > now() - make_interval(days => $2)");
  });

  it("skips anyone who already booked", async () => {
    expect(await sql()).toContain("FROM marketing.booking_slots b WHERE b.submission_id = s.id");
  });

  it("skips anyone already reminded, on any channel", async () => {
    const q = await sql();
    expect(q).toContain("f.template = 'reminder_followup'");
    // Deliberately NOT scoped to a channel: one reminder per person, full stop.
    expect(q).not.toContain("f.channel");
  });

  it("requires a number to send to", async () => {
    expect(await sql()).toContain("COALESCE(s.whatsapp_e164, s.phone_e164) IS NOT NULL");
  });

  it("passes the configured window and batch as parameters", async () => {
    process.env.FUNNEL_REMINDER_AFTER_DAYS = "5";
    process.env.FUNNEL_REMINDER_MAX_AGE_DAYS = "21";
    process.env.FUNNEL_REMINDER_BATCH = "7";
    const { sweepFunnelReminders } = await load();
    await sweepFunnelReminders();
    expect(query.mock.calls[0]?.[1]).toEqual([5, 21, 7]);
  });

  it("falls back to sane defaults for nonsense config", async () => {
    process.env.FUNNEL_REMINDER_AFTER_DAYS = "not-a-number";
    process.env.FUNNEL_REMINDER_MAX_AGE_DAYS = "-3";
    const { sweepFunnelReminders } = await load();
    await sweepFunnelReminders();
    expect(query.mock.calls[0]?.[1]).toEqual([3, 14, 25]);
  });
});

describe("what it queues", () => {
  beforeEach(() => {
    process.env.FUNNEL_REMINDERS_ENABLED = "true";
  });

  it("queues one WhatsApp reminder per match", async () => {
    query.mockResolvedValue({ rows: [{ id: "a" }, { id: "b" }] });
    const { sweepFunnelReminders } = await load();
    expect(await sweepFunnelReminders()).toBe(2);
    expect(enqueueFollowUp).toHaveBeenCalledTimes(2);
    for (const call of enqueueFollowUp.mock.calls) {
      // Channel is explicit. The column defaults to 'email' in the database, so
      // an omitted argument here would quietly queue mail - the channel that is
      // on hold and cannot be delivered.
      expect(call.slice(2)).toEqual(["reminder_followup", "whatsapp"]);
    }
  });

  it("queues nothing when nothing matches", async () => {
    query.mockResolvedValue({ rows: [] });
    const { sweepFunnelReminders } = await load();
    expect(await sweepFunnelReminders()).toBe(0);
    expect(enqueueFollowUp).not.toHaveBeenCalled();
  });
});

describe("startFunnelReminderSweep", () => {
  it("returns null and does not schedule anything when off", async () => {
    delete process.env.FUNNEL_REMINDERS_ENABLED;
    const { startFunnelReminderSweep } = await load();
    expect(startFunnelReminderSweep()).toBeNull();
  });

  it("refuses to run a window that can never match", async () => {
    // after=10, max=5 selects "older than 10 days AND younger than 5", which is
    // empty. Running it would look enabled and do nothing forever - the failure
    // nobody investigates because there is no error.
    process.env.FUNNEL_REMINDERS_ENABLED = "true";
    process.env.FUNNEL_REMINDER_AFTER_DAYS = "10";
    process.env.FUNNEL_REMINDER_MAX_AGE_DAYS = "5";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { startFunnelReminderSweep } = await load();
    expect(startFunnelReminderSweep()).toBeNull();
    expect(err.mock.calls[0]?.[0]).toContain("must be greater than");
    err.mockRestore();
  });

  it("schedules a timer when the configuration is usable", async () => {
    process.env.FUNNEL_REMINDERS_ENABLED = "true";
    const { startFunnelReminderSweep } = await load();
    const timer = startFunnelReminderSweep();
    expect(timer).not.toBeNull();
    if (timer) clearInterval(timer);
  });
});
