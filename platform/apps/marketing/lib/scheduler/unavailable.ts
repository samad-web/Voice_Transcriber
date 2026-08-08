import type { Scheduler, Slot } from "./types";

/**
 * The scheduler you get when Google Calendar is not configured — doc 16 §0.4.
 *
 * It offers nothing and can book nothing. That is the whole design: the "no
 * fake slot" rule is enforced by making a fake slot unrepresentable rather than
 * by asking every caller to remember the rule.
 *
 * `availableSlots` resolving to `[]` (not rejecting) is deliberate. The
 * qualified path's own logic is "render the picker if there are slots, else
 * render the contact screen", which is the correct behaviour for a full
 * calendar too — so the unconfigured case travels the exact same code path a
 * configured-but-busy calendar does, and that path is therefore exercised in
 * every build rather than only after credentials land.
 *
 * `book` throws, and is never reached in normal operation: there is no slot to
 * pass it. It throws rather than returning a placeholder id because the only
 * way to arrive here is a caller that fabricated a slot, and that caller needs
 * to fail loudly in a test, not quietly ship a confirmation to a human who
 * would then show up to a meeting that does not exist.
 */
export class UnavailableScheduler implements Scheduler {
  readonly configured = false;

  /** The reason config is missing, surfaced in logs so an operator can fix it. */
  constructor(private readonly reason: string = "Google Calendar is not configured") {}

  async availableSlots(): Promise<Slot[]> {
    return [];
  }

  async book(): Promise<{ eventId: string }> {
    throw new Error(
      `UnavailableScheduler cannot book: ${this.reason}. ` +
        "Reaching this means a caller invented a slot, no slot can come from availableSlots().",
    );
  }
}
