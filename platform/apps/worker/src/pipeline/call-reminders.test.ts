import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pre-call reminder sweep, tested where it can actually hurt: WHICH
 * reminders it decides to schedule, and for WHEN.
 *
 * A wrong instant here does not throw. It sends "your call is tomorrow" to
 * somebody whose call is in fifteen minutes, or fires all three reminders at
 * once the moment a slot is booked. The account this sends from carries a ban
 * risk for exactly that pattern, so the arithmetic and the guard clauses are
 * both asserted directly.
 */

const query = vi.fn();

vi.mock("@aura/db", () => ({
  getAdminPool: () => ({ query }),
}));

const enqueueBookingNotification = vi.fn();
vi.mock("./booking-notifications-outbox", () => ({
  enqueueBookingNotification: (...args: unknown[]) => enqueueBookingNotification(...args),
}));

const emailConfigured = vi.fn();
vi.mock("./funnel-followup", () => ({
  emailConfigured: () => emailConfigured(),
}));

beforeEach(() => {
  vi.resetModules();
  query.mockReset().mockResolvedValue({ rows: [] });
  enqueueBookingNotification.mockReset().mockResolvedValue(undefined);
  emailConfigured.mockReset().mockReturnValue(false);
});

async function load() {
  return import("./call-reminders");
}

/** The SQL the sweep issued, whitespace-collapsed for readable assertions. */
function sql(): string {
  return String(query.mock.calls[0]?.[0] ?? "").replace(/\s+/g, " ");
}

/** A booking `minutes` from now, as the row shape the sweep reads. */
function bookingIn(minutes: number, id = "slot-1") {
  return { id, starts_at: new Date(Date.now() + minutes * 60_000).toISOString() };
}

/** The (template, sendAt) pairs handed to the outbox, in call order. */
function scheduled(): Array<[string, string, number]> {
  return enqueueBookingNotification.mock.calls.map((c) => [
    c[2] as string,
    c[3] as string,
    (c[4] as Date).getTime(),
  ]);
}

describe("which bookings it selects", () => {
  it("only booked slots that are still ahead", async () => {
    const { sweepCallReminders } = await load();
    await sweepCallReminders();
    const text = sql();
    expect(text).toContain("b.status = 'booked'");
    // A call in the past cannot be reminded about, and including them would
    // make the horizon query walk the whole table forever.
    expect(text).toContain("b.starts_at > now()");
  });

  it("joins the submission, so an erased enquirer is skipped", async () => {
    const { sweepCallReminders } = await load();
    await sweepCallReminders();
    // booking_slots.submission_id is ON DELETE SET NULL. An INNER join is what
    // drops those rows; a LEFT join would queue reminders with no recipient,
    // which the drain could only dead-letter.
    expect(sql()).toContain("JOIN marketing.funnel_submissions s ON s.id = b.submission_id");
  });

  it("skips bookings that already have reminders", async () => {
    const { sweepCallReminders } = await load();
    await sweepCallReminders();
    const text = sql();
    // Belt to the unique index's braces. Without it every future call is
    // re-examined on every tick and three inserts bounce off ON CONFLICT.
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain("n.template LIKE 'reminder_call_%'");
  });
});

describe("when each reminder is scheduled", () => {
  it("stamps all three at their exact instants before the call", async () => {
    const booking = bookingIn(60 * 24 * 3); // three days out, so all three fit
    query.mockResolvedValueOnce({ rows: [booking] });
    const startsAt = new Date(booking.starts_at).getTime();

    const { sweepCallReminders } = await load();
    expect(await sweepCallReminders()).toBe(3);

    // The whole design: the instant lives on the row, so the drain's ordinary
    // `next_attempt_at <= now()` fires it. No timing window, and a worker that
    // was down catches up rather than losing the reminder.
    expect(scheduled()).toEqual([
      ["reminder_call_24h", "whatsapp", startsAt - 24 * 60 * 60_000],
      ["reminder_call_1h", "whatsapp", startsAt - 60 * 60_000],
      ["reminder_call_5m", "whatsapp", startsAt - 5 * 60_000],
    ]);
  });

  it("SKIPS the stages whose moment has already passed", async () => {
    // Booked 30 minutes out: the 24-hour and 1-hour reminders are both in the
    // past. Queueing them would either fire "your call is tomorrow" instantly -
    // for a call in half an hour - or land as overdue and be expired. Both are
    // noise, and the first is actively wrong.
    query.mockResolvedValueOnce({ rows: [bookingIn(30)] });

    const { sweepCallReminders } = await load();
    expect(await sweepCallReminders()).toBe(1);
    expect(scheduled().map((s) => s[0])).toEqual(["reminder_call_5m"]);
  });

  it("queues nothing at all for a booking inside five minutes", async () => {
    query.mockResolvedValueOnce({ rows: [bookingIn(2)] });
    const { sweepCallReminders } = await load();
    expect(await sweepCallReminders()).toBe(0);
    expect(enqueueBookingNotification).not.toHaveBeenCalled();
  });
});

describe("the email half", () => {
  it("queues WhatsApp only when no mail provider is configured", async () => {
    query.mockResolvedValueOnce({ rows: [bookingIn(60 * 24 * 3)] });
    const { sweepCallReminders } = await load();
    await sweepCallReminders();

    // Log-only email marks a row `sent` with a `log-only:` id. Queueing an
    // undeliverable second copy of every reminder would double the table an
    // operator reads to find out what was sent, for no gain.
    expect(scheduled().every(([, channel]) => channel === "whatsapp")).toBe(true);
  });

  it("adds the email copies once a provider exists - except the 5-minute one", async () => {
    emailConfigured.mockReturnValue(true);
    query.mockResolvedValueOnce({ rows: [bookingIn(60 * 24 * 3)] });
    const { sweepCallReminders } = await load();

    // 24h and 1h on both channels, 5m on WhatsApp alone: five minutes is not
    // enough notice for mail to be read, so that stage has no email copy and
    // renderMessage would refuse it.
    expect(await sweepCallReminders()).toBe(5);
    expect(scheduled().map(([t, c]) => `${t}/${c}`)).toEqual([
      "reminder_call_24h/whatsapp",
      "reminder_call_24h/email",
      "reminder_call_1h/whatsapp",
      "reminder_call_1h/email",
      "reminder_call_5m/whatsapp",
    ]);
  });
});

describe("failure isolation", () => {
  it("keeps going when one booking fails", async () => {
    query.mockResolvedValueOnce({
      rows: [bookingIn(60 * 24 * 3, "bad"), bookingIn(60 * 24 * 3, "good")],
    });
    enqueueBookingNotification.mockRejectedValueOnce(new Error("constraint violation"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { sweepCallReminders } = await load();

    // One bad booking must not strand the reminders behind it. 3 for the good
    // one plus the 2 that still succeeded on the bad one after its first throw.
    expect(await sweepCallReminders()).toBe(5);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("queues nothing when nothing is due", async () => {
    const { sweepCallReminders } = await load();
    expect(await sweepCallReminders()).toBe(0);
    expect(enqueueBookingNotification).not.toHaveBeenCalled();
  });
});
