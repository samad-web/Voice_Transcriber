/**
 * The scheduler seam - doc 16 §0.4.
 *
 * Real booking needs a Google Cloud project with the Calendar API enabled and
 * either a service account with domain-wide delegation or an OAuth consent
 * screen. None of that exists yet, so the funnel talks to this interface and
 * never to Google directly. Two implementations are selected by env:
 * `GoogleCalendarScheduler` (real, see ./google-calendar.ts) and
 * `UnavailableScheduler` (see ./unavailable.ts).
 *
 * ── The rule this interface exists to enforce ──────────────────────────────
 *
 * `lead-funnel-spec.md` Step 3A: "No decoy/fake calendar - every slot shown is
 * real and every booking is real." Doc 16 §0.4 restates it as absolute. That is
 * the entire reason for the abstraction: an unconfigured scheduler must be
 * *unable* to produce a slot, rather than relying on every future caller to
 * remember not to render one.
 *
 * So `availableSlots` returning `[]` is not an error state - it is the honest
 * answer both when the scheduler is unconfigured and when the calendar is
 * genuinely full, and the caller's job in BOTH cases is identical: show the
 * "our team will reach out" screen. That symmetry is deliberate. A caller that
 * branches on `configured` to pick different copy would leak our configuration
 * state into the page and would drift the moment the calendar fills up.
 */

/** A real, bookable window on a real calendar. Never synthesised for display. */
export type Slot = {
  start: Date;
  end: Date;
};

/**
 * What the scheduler needs to know about the person booking.
 *
 * ⚠️ LOCAL STRUCTURAL TYPE, temporary. Dev C owns the funnel's data types
 * (`apps/marketing/lib/funnel`, doc 16 slice 4) and at the time this was
 * written that module did not exist yet. This declares only the columns the
 * scheduler actually reads, named exactly as doc 16 §3.1's
 * `marketing.funnel_submissions` DDL names them, so the real type structurally
 * satisfies it and the import is a one-line swap. Do not add fields here to
 * make some other module compile - extend the real type instead.
 */
export type FunnelSubmission = {
  id: string;
  name: string;
  email: string;
  phone_e164: string;
  /** Free text from §3.7's "which CRM" question. Used only to title the event. */
  crm_name?: string | null;
  business_type?: string | null;
  team_size?: string | null;
};

export interface Scheduler {
  /**
   * Real free windows between `from` and `to`, in chronological order.
   *
   * Returns `[]` rather than throwing when there is nothing to offer - see the
   * note above. Implementations MUST NOT invent, pad or round up a window: a
   * slot in this array is a promise that the time is genuinely free.
   */
  availableSlots(from: Date, to: Date): Promise<Slot[]>;

  /**
   * Book `slot` for `submission`. Creates a real calendar event.
   *
   * Throws on failure. It must never resolve with a fabricated id, because the
   * caller's success path renders a booking confirmation to a human who will
   * then show up.
   */
  book(
    slot: Slot,
    submission: FunnelSubmission,
  ): Promise<{
    eventId: string;
    /**
     * The Google Meet URL, when Google returned one.
     *
     * Nullable on purpose. A conference is requested on every insert, but the
     * response does not always carry one back, and the meeting is real and in
     * the calendar either way. Failing a booking over a missing video link
     * would be the tail wagging the dog.
     */
    meetingUrl?: string | null;
  }>;

  /**
   * Cancel a previously booked event, notifying the attendee.
   *
   * Used by the reschedule flow, which releases one slot and claims another -
   * leaving the old event standing would put two appointments in the team's
   * diary for one person, and the lead would still hold an invite to the time
   * they just moved away from.
   *
   * MUST NOT throw for an event that is already gone. A 404 or 410 from Google
   * means the desired state is the actual state, and treating it as a failure
   * would make a reschedule fail on a retry of a request that had in fact
   * already succeeded.
   *
   * A genuine failure DOES throw, and the caller records it rather than undoing
   * the swap - the database is the source of truth for who is booked when, and
   * the calendar is a mirror that can be repaired by hand.
   */
  cancel(eventId: string): Promise<void>;

  /**
   * Whether this implementation can talk to a real calendar at all.
   *
   * NOT for choosing what to render - `availableSlots().length` is the signal
   * for that, so a full calendar and an unconfigured one behave identically.
   * This exists for two narrower jobs: skipping a pointless network round trip,
   * and letting `/booked` refuse to render a booking confirmation in a build
   * where no booking can possibly have happened.
   */
  readonly configured: boolean;
}
