import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The booking outbox, tested at the point where a wrong answer reaches a
 * person: the three state checks the drain re-runs at SEND time.
 *
 * Every row here is queued minutes to days before it goes out, and in that gap
 * the world moves. Someone converts; someone cancels; the call starts. Each of
 * those makes a queued message wrong rather than merely late, and none of them
 * is visible from the row itself - which is why they are re-checked against the
 * joined state instead of trusted from when the row was written.
 */

const query = vi.fn();
vi.mock("@aura/db", () => ({
  getAdminPool: () => ({ query }),
}));

const send = vi.fn();
vi.mock("./whatsapp", () => ({
  getWhatsAppSender: () => ({ name: "test-wa", send }),
}));

const dispatcherSend = vi.fn();
vi.mock("./funnel-followup", () => ({
  getFollowUpDispatcher: () => ({ name: "test-mail", send: dispatcherSend }),
}));

const renderMessage = vi.fn();
vi.mock("./message-templates", () => ({
  renderMessage: (...args: unknown[]) => renderMessage(...args),
}));

vi.mock("./reschedule-tokens", () => ({
  mintRescheduleLink: async () => "https://example.test/reschedule/tok",
}));

beforeEach(() => {
  vi.resetModules();
  query.mockReset();
  send.mockReset().mockResolvedValue({ ok: true, providerMessageId: "wa-1" });
  dispatcherSend.mockReset().mockResolvedValue({ ok: true, messageId: "mail-1" });
  renderMessage.mockReset().mockResolvedValue({ ok: true, text: "hello", subject: "hi" });
});

async function load() {
  return import("./booking-notifications-outbox");
}

/** A due row, with the joined state the drain reads. */
function due(over: Record<string, unknown> = {}) {
  return {
    id: "n-1",
    booking_slot_id: "slot-1",
    template: "reminder_call_1h",
    channel: "whatsapp",
    attempts: 0,
    name: "Ramesh Kumar",
    salutation: "mr",
    email: "r@example.com",
    phone_e164: "+919876543210",
    whatsapp_e164: null,
    converted: false,
    slot_label: "Tue, 12 Aug at 18:30",
    meeting_url: null,
    starts_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    slot_status: "booked",
    ...over,
  };
}

/**
 * Wire the query mock for one drain pass: table check, expiry sweep, the due
 * SELECT, then whatever UPDATEs follow.
 */
function drainWith(rows: ReturnType<typeof due>[]) {
  query
    .mockResolvedValueOnce({ rows: [{ exists: "marketing.booking_notifications" }] })
    .mockResolvedValueOnce({ rowCount: 0 })
    .mockResolvedValueOnce({ rows })
    .mockResolvedValue({ rows: [], rowCount: 1 });
}

/** The status written back for the row, from the final UPDATE's params. */
function writtenStatus(): { status: string; error: string | null } {
  const update = query.mock.calls.find((c) =>
    String(c[0]).includes("UPDATE marketing.booking_notifications SET status"),
  ) ?? query.mock.calls.at(-1)!;
  const params = update[1] as unknown[];
  return { status: params[1] as string, error: params[3] as string | null };
}

describe("the send-time state checks", () => {
  it("sends when everything still holds", async () => {
    drainWith([due()]);
    const { drainBookingNotifications } = await load();

    expect(await drainBookingNotifications()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(writtenStatus().status).toBe("sent");
  });

  it("refuses when the booking is no longer held", async () => {
    // Released by a rejection or a reschedule after this row was queued. The
    // API stands these down at the moment of release; this is the backstop for
    // a release that happened by some other path.
    drainWith([due({ slot_status: "open" })]);
    const { drainBookingNotifications } = await load();

    await drainBookingNotifications();
    expect(send).not.toHaveBeenCalled();
    const { status, error } = writtenStatus();
    expect(status).toBe("dead");
    expect(error).toContain("no longer held");
  });

  it("refuses a nurture message to somebody who has since converted", async () => {
    // The whole premise of the drip is that they have not bought. Three days is
    // plenty of time for them to have signed, and "still worth a look?" to a
    // new customer is the worst message in the catalogue.
    drainWith([due({ template: "nurture_1", converted: true })]);
    const { drainBookingNotifications } = await load();

    await drainBookingNotifications();
    expect(send).not.toHaveBeenCalled();
    const { status, error } = writtenStatus();
    expect(status).toBe("dead");
    expect(error).toContain("converted");
  });

  it("still sends a nurture message to somebody who has not", async () => {
    drainWith([due({ template: "nurture_1", converted: false })]);
    const { drainBookingNotifications } = await load();

    await drainBookingNotifications();
    expect(send).toHaveBeenCalledTimes(1);
    expect(writtenStatus().status).toBe("sent");
  });

  it("refuses a reminder for a call that has already started", async () => {
    // A "your call is in an hour" that escapes a stuck queue afterwards tells
    // someone to join a meeting that is over. Worse than silence.
    drainWith([due({ starts_at: new Date(Date.now() - 60_000).toISOString() })]);
    const { drainBookingNotifications } = await load();

    await drainBookingNotifications();
    expect(send).not.toHaveBeenCalled();
    const { status, error } = writtenStatus();
    expect(status).toBe("dead");
    expect(error).toContain("already started");
  });

  it("does NOT apply the started-call check to an outcome message", async () => {
    // call_attended is queued precisely BECAUSE the call has happened. Sharing
    // the reminder's guard would dead-letter every thank-you ever sent.
    drainWith([
      due({
        template: "call_attended",
        starts_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      }),
    ]);
    const { drainBookingNotifications } = await load();

    await drainBookingNotifications();
    expect(send).toHaveBeenCalledTimes(1);
    expect(writtenStatus().status).toBe("sent");
  });
});

describe("channel routing", () => {
  it("prefers the WhatsApp number the person gave over their phone", async () => {
    drainWith([due({ whatsapp_e164: "+919000000000" })]);
    const { drainBookingNotifications } = await load();

    await drainBookingNotifications();
    expect(send.mock.calls[0][0].to).toBe("+919000000000");
  });

  it("sends email through the mail dispatcher, with the rendered subject", async () => {
    drainWith([due({ channel: "email" })]);
    const { drainBookingNotifications } = await load();

    await drainBookingNotifications();
    expect(send).not.toHaveBeenCalled();
    expect(dispatcherSend).toHaveBeenCalledTimes(1);
    expect(dispatcherSend.mock.calls[0][0]).toMatchObject({
      to: { email: "r@example.com" },
      subject: "hi",
    });
  });

  it("dead-letters a template that is switched off, rather than retrying it", async () => {
    // Retrying one an operator deliberately disabled would send the message
    // they told us not to, as soon as a backoff landed after they re-enabled it.
    renderMessage.mockResolvedValue({ ok: false, reason: "switched off in the console" });
    drainWith([due()]);
    const { drainBookingNotifications } = await load();

    await drainBookingNotifications();
    expect(send).not.toHaveBeenCalled();
    expect(writtenStatus().status).toBe("dead");
  });

  it("retries a transport failure the gateway says is transient", async () => {
    send.mockResolvedValue({ ok: false, retryable: true, error: "gateway 502" });
    drainWith([due()]);
    const { drainBookingNotifications } = await load();

    await drainBookingNotifications();
    expect(writtenStatus().status).toBe("pending");
  });
});

describe("enqueueing", () => {
  it("is idempotent per booking, template and channel", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const { enqueueBookingNotification } = await load();

    await enqueueBookingNotification(client, "slot-1", "nurture_1", "whatsapp");
    const text = String(client.query.mock.calls[0][0]).replace(/\s+/g, " ");

    // The unique key is what stops a re-run of a sweep, or two workers racing,
    // producing two reminders for one call.
    expect(text).toContain("ON CONFLICT (booking_slot_id, template, channel) DO NOTHING");
  });

  it("stamps a future send instant when one is given", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const when = new Date(Date.now() + 86_400_000);
    const { enqueueBookingNotification } = await load();

    await enqueueBookingNotification(client, "slot-1", "nurture_1", "whatsapp", when);
    expect(client.query.mock.calls[0][1]).toContain(when.toISOString());
  });

  it("defaults to now, as a null the SQL coalesces", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    const { enqueueBookingNotification } = await load();

    await enqueueBookingNotification(client, "slot-1", "call_attended", "whatsapp");
    expect((client.query.mock.calls[0][1] as unknown[])[3]).toBeNull();
  });
});

describe("standing notifications down", () => {
  it("kills only the pending ones, and records why", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 2 }) };
    const { cancelBookingNotifications } = await load();

    await cancelBookingNotifications(client, "slot-1", "the booking was cancelled");
    const text = String(client.query.mock.calls[0][0]).replace(/\s+/g, " ");

    // 'dead' with a reason rather than deleted: the outbox is what an operator
    // consults to find out what was sent, and a message deliberately not sent
    // is a fact worth keeping.
    expect(text).toContain("SET status = 'dead'");
    expect(text).toContain("status = 'pending'");
    expect(text).toContain("next_attempt_at = NULL");
  });
});
