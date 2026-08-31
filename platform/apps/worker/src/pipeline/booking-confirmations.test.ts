import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The booking-confirmation sweep, tested where it can actually hurt: WHICH
 * bookings it decides to message.
 *
 * A wrong predicate here does not throw. It sends a WhatsApp message to a real
 * person - possibly one who booked days ago under an explicit promise that we
 * would not message them, possibly about a call that has already happened. The
 * account this sends from carries a ban risk for exactly that. So the guard
 * clauses are asserted as query text: delete one and a test fails, rather than
 * a stranger getting a message.
 */

const query = vi.fn();

vi.mock("@aura/db", () => ({
  getAdminPool: () => ({ query }),
}));

const enqueueFollowUp = vi.fn();
vi.mock("./funnel-followup-outbox", () => ({
  enqueueFollowUp: (...args: unknown[]) => enqueueFollowUp(...args),
}));

beforeEach(() => {
  vi.resetModules();
  query.mockReset().mockResolvedValue({ rows: [] });
  enqueueFollowUp.mockReset().mockResolvedValue(undefined);
});

async function load() {
  return import("./booking-confirmations");
}

/** The SQL the sweep issued, whitespace-collapsed for readable assertions. */
function sql(): string {
  return String(query.mock.calls[0]?.[0] ?? "").replace(/\s+/g, " ");
}

describe("which bookings it selects", () => {
  it("only booked slots", async () => {
    const { sweepBookingConfirmations } = await load();
    await sweepBookingConfirmations();
    // An open slot has nobody to confirm to; a cancelled one had its booking
    // taken back, and confirming that would be actively wrong.
    expect(sql()).toContain("b.status = 'booked'");
  });

  it("only slots in the future", async () => {
    const { sweepBookingConfirmations } = await load();
    await sweepBookingConfirmations();
    // A confirmation for a call that already happened is noise at best. If the
    // worker was down across someone's appointment, telling them to join a
    // meeting that finished two hours ago is worse than silence.
    expect(sql()).toContain("b.starts_at > now()");
  });

  it("skips anyone who already has a confirmation row, whatever its status", async () => {
    const { sweepBookingConfirmations } = await load();
    await sweepBookingConfirmations();
    const text = sql();

    // This NOT EXISTS is the whole safety mechanism. Migration 0032 wrote a
    // 'dead' row for every booking that existed when this shipped, so the
    // backlog is skipped by virtue of having a row at all. A status filter
    // added here - `AND f.status = 'sent'`, say - would make those rows
    // invisible and message the entire backlog on the next tick.
    expect(text).toContain("NOT EXISTS");
    expect(text).toContain("f.template = 'booking_confirmed'");
    expect(text).toContain("f.channel = 'whatsapp'");
    expect(text).not.toMatch(/f\.status\s*=/);
  });

  it("ignores slots with no submission attached", async () => {
    const { sweepBookingConfirmations } = await load();
    await sweepBookingConfirmations();
    // booking_slots.submission_id is ON DELETE SET NULL, so an erased enquiry
    // leaves the slot behind with a null. There is nobody to message.
    expect(sql()).toContain("b.submission_id IS NOT NULL");
  });
});

describe("what it queues", () => {
  it("queues one WhatsApp confirmation per submission", async () => {
    query.mockResolvedValueOnce({
      rows: [{ submission_id: "sub-1" }, { submission_id: "sub-2" }],
    });
    const { sweepBookingConfirmations } = await load();

    expect(await sweepBookingConfirmations()).toBe(2);
    expect(enqueueFollowUp).toHaveBeenCalledTimes(2);
    for (const call of enqueueFollowUp.mock.calls) {
      expect(call[2]).toBe("booking_confirmed");
      expect(call[3]).toBe("whatsapp");
    }
  });

  it("queues nothing when nothing is due", async () => {
    const { sweepBookingConfirmations } = await load();
    expect(await sweepBookingConfirmations()).toBe(0);
    expect(enqueueFollowUp).not.toHaveBeenCalled();
  });

  it("keeps going when one submission fails", async () => {
    query.mockResolvedValueOnce({
      rows: [{ submission_id: "bad" }, { submission_id: "good" }],
    });
    enqueueFollowUp
      .mockRejectedValueOnce(new Error("constraint violation"))
      .mockResolvedValueOnce(undefined);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { sweepBookingConfirmations } = await load();

    // One bad row must not strand the confirmations behind it - the failure
    // mode a plain `for … await` without the try/catch would produce.
    expect(await sweepBookingConfirmations()).toBe(1);
    expect(enqueueFollowUp).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
