"use server";

import { getScheduler, schedulerTimeZone } from "@/lib/scheduler";
import { funnelConfigured, query } from "@/lib/funnel/db";
import {
  clearRescheduleSession,
  getRescheduleSession,
} from "@/lib/funnel/reschedule-session";
import { DEFAULT_NOTICE_MINUTES, listOpenSlots, rescheduleSlot, type OpenSlot } from "@/lib/funnel/slots";

/**
 * Moving a booked call to a different time.
 *
 * The person arriving here has already been authenticated by the token
 * exchange in ./[token]/route.ts, which set a signed httpOnly cookie naming the
 * booking and the submission. NOTHING in this file trusts the client for
 * either: the slot id it accepts is the NEW time only, and the swap is pinned
 * to the submission id from the cookie.
 */

const TEAM_TIME_ZONE = schedulerTimeZone();
const NOTICE_MINUTES =
  Number(process.env.SCHEDULER_MIN_NOTICE_MINUTES ?? DEFAULT_NOTICE_MINUTES) ||
  DEFAULT_NOTICE_MINUTES;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RescheduleSlotsResult {
  slots: OpenSlot[];
  timeZone: string;
}

/**
 * The times to offer. Empty on ANY failure, exactly like the funnel's own
 * picker - doc 16 §0.4: a slot that is not real must never reach a page.
 *
 * The slot the person currently holds is NOT in this list, because it is
 * `booked` and `listOpenSlots` only returns `open` rows. That is the right
 * behaviour: an option to move a call to the time it is already at is a button
 * that does nothing.
 */
export async function listRescheduleSlotsAction(): Promise<RescheduleSlotsResult> {
  if (!funnelConfigured()) return { slots: [], timeZone: TEAM_TIME_ZONE };
  try {
    return {
      slots: await listOpenSlots(TEAM_TIME_ZONE, NOTICE_MINUTES),
      timeZone: TEAM_TIME_ZONE,
    };
  } catch (err) {
    console.error("[reschedule] listOpenSlots failed", err);
    return { slots: [], timeZone: TEAM_TIME_ZONE };
  }
}

export interface RescheduleResultPayload {
  ok: boolean;
  dayLabel?: string;
  timeLabel?: string;
  meetingUrl?: string | null;
  error?: string;
  /**
   * The link's session is gone, so NO slot on this page can be taken.
   *
   * Distinguished from "that time was taken" for the reason the booking flow
   * distinguishes them: a taken slot means try another one and the picker
   * refreshes, while an expired session means every button will fail
   * identically and refreshing only invites a second failure.
   */
  sessionExpired?: boolean;
}

export async function rescheduleToSlotAction(
  newSlotId: string,
): Promise<RescheduleResultPayload> {
  const session = await getRescheduleSession();
  if (!session) {
    return {
      ok: false,
      sessionExpired: true,
      error: "This reschedule link has expired.",
    };
  }

  // Shape-checked before it reaches a query: a malformed id would otherwise be
  // a Postgres "invalid input syntax for type uuid", which is a 500 rather than
  // the sentence the visitor should see.
  if (!UUID.test(newSlotId)) {
    return { ok: false, error: "That time is no longer available." };
  }

  // Moving to the slot you are already in is a no-op the swap would report as
  // "gone" (the release succeeds, then the claim finds a row that is no longer
  // open - itself). Caught here so the message matches what happened.
  if (newSlotId === session.bid) {
    return { ok: false, error: "That is the time you are already booked for." };
  }

  let name = "";
  try {
    const rows = await query<{ name: string }>(
      `SELECT name FROM marketing.funnel_submissions WHERE id = $1`,
      [session.sid],
    );
    name = rows[0]?.name ?? "";
  } catch {
    // Non-fatal: the move is still worth making without the label.
  }

  let result;
  try {
    result = await rescheduleSlot(
      session.bid,
      newSlotId,
      session.sid,
      name,
      TEAM_TIME_ZONE,
      NOTICE_MINUTES,
    );
  } catch (err) {
    console.error("[reschedule] rescheduleSlot failed", err);
    return { ok: false, error: "We could not move that booking. Please try again." };
  }

  if (!result.ok) {
    return result.reason === "taken"
      ? { ok: false, error: "Someone just took that time. Please pick another." }
      : {
          ok: false,
          sessionExpired: true,
          error:
            "That booking is no longer held - it may already have been moved or cancelled. " +
            "Please get in touch and we'll sort out a new time.",
        };
  }

  /**
   * Google is told AFTER the swap has committed, and its failure cannot undo
   * it - the same rule `syncBookingToCalendar` follows for a first booking. The
   * database is the source of truth for who is booked when; the calendar is a
   * mirror, and a mirror that is briefly wrong is repairable by hand where a
   * lost reservation is not.
   *
   * The cancel comes first so that a failure there does not leave the person
   * without a NEW invite as well - worst case they hold two, which is visible
   * and fixable, rather than none.
   */
  const meetingUrl = await syncMove(
    session.bid,
    newSlotId,
    session.sid,
    result.oldCalendarEventId,
    result.startsAt,
    result.endsAt,
  );

  await clearRescheduleSession();

  return {
    ok: true,
    dayLabel: result.dayLabel,
    timeLabel: result.timeLabel,
    meetingUrl,
  };
}

/**
 * Cancel the old calendar event and create a new one.
 *
 * Every failure is recorded on the row and swallowed. Both halves are
 * bookkeeping about a reservation that has already moved - see the caller.
 */
async function syncMove(
  oldSlotId: string,
  newSlotId: string,
  submissionId: string,
  oldEventId: string | null,
  startsAt: Date,
  endsAt: Date,
): Promise<string | null> {
  const scheduler = getScheduler();
  if (!scheduler.configured) return null;

  if (oldEventId) {
    try {
      await scheduler.cancel(oldEventId);
    } catch (err) {
      // The old slot is already released and re-bookable, so there is no row
      // left to hang this on that anybody would read. The log is the record,
      // and the symptom - a stale event on the team's calendar - is visible in
      // the calendar itself.
      console.error(
        `[reschedule] could not cancel event ${oldEventId} for released slot ${oldSlotId}:`,
        (err as Error).message,
      );
    }
  }

  try {
    const people = await query<{
      id: string;
      name: string;
      email: string;
      phone_e164: string;
      crm_name: string | null;
      business_type: string | null;
      team_size: string | null;
    }>(
      `SELECT id, name, email, phone_e164, crm_name, business_type, team_size
         FROM marketing.funnel_submissions
        WHERE id = $1`,
      [submissionId],
    );

    const submission = people[0];
    if (!submission) {
      await recordCalendarOutcome(newSlotId, null, "submission not found when moving the event");
      return null;
    }

    const { eventId, meetingUrl } = await scheduler.book(
      { start: startsAt, end: endsAt },
      submission,
    );
    await recordCalendarOutcome(newSlotId, eventId, null, meetingUrl ?? null);
    return meetingUrl ?? null;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(`[reschedule] calendar sync failed for slot ${newSlotId}:`, message);
    await recordCalendarOutcome(newSlotId, null, message);
    return null;
  }
}

async function recordCalendarOutcome(
  slotId: string,
  eventId: string | null,
  error: string | null,
  meetingUrl: string | null = null,
): Promise<void> {
  try {
    await query(
      `UPDATE marketing.booking_slots
          SET calendar_event_id = $2,
              calendar_error    = $3,
              meeting_url       = $4
        WHERE id = $1`,
      [slotId, eventId, error ? error.slice(0, 500) : null, meetingUrl],
    );
  } catch (err) {
    console.error(
      `[reschedule] could not record calendar outcome for slot ${slotId}:`,
      (err as Error).message,
    );
  }
}
