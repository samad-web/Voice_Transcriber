import { getScheduler } from "@/lib/scheduler";
import { query, withTransaction } from "./db";

/**
 * Reading and claiming booking slots from the public funnel. SERVER ONLY.
 *
 * The marketing site connects as `aura_marketing`, which migrations 0023 and
 * 0027 give SELECT on this table plus UPDATE on exactly six columns — status,
 * submission_id, booked_at, booked_name, calendar_event_id, calendar_error. It
 * cannot INSERT. That is the whole security model of this file: the website may
 * show the diary and take an appointment out of it, and it categorically cannot
 * invent availability. Slots are created by an operator in the console.
 *
 * ── HOW THIS RELATES TO lib/scheduler (GOOGLE CALENDAR) ────────────────────
 *
 * Both exist, and they are not alternatives — they were, and that was the bug.
 * Until 0027 the funnel booked into this table and `lib/scheduler` was reached
 * only by /booked, so a real booking produced a confirmed visitor, a 'booked'
 * row, and no calendar event anywhere.
 *
 * The division now:
 *
 *   THIS FILE          owns availability and concurrency. The operator defines
 *                      when the team is free, in the console; the atomic UPDATE
 *                      below is what stops two people taking the same slot.
 *   lib/scheduler      owns the calendar event and the attendee's invite.
 *
 * The database decides, then Google is told. Not the other way round, and never
 * both deciding.
 */

export interface OpenSlot {
  id: string;
  /** e.g. "Tue, 11 Aug" — rendered by Postgres in the team's zone. */
  dayLabel: string;
  /** e.g. "18:30" */
  timeLabel: string;
  durationMinutes: number;
}

/**
 * How far ahead a slot must be before anyone can take it.
 *
 * FOUR HOURS, set 2026-08-10 on the owner's instruction (was two). Overridable
 * with SCHEDULER_MIN_NOTICE_MINUTES, and this is the floor the code assumes
 * when nothing is set — the two places that need it agree because they both
 * read this constant rather than repeating a number.
 */
export const DEFAULT_NOTICE_MINUTES = 240;

/**
 * The next few genuinely bookable slots.
 *
 * `starts_at > now() + notice` is not decoration. Offering a slot twenty minutes
 * from now produces a booking nobody on the team sees in time, which is worse
 * than offering nothing — the visitor believes they have an appointment and the
 * calendar agrees, and only the human is missing.
 *
 * `external_busy_at IS NULL` is the other half, and it comes from the opposite
 * direction: the worker's calendar sweep sets it on any open slot the team is
 * already busy for in Google (migration 0030). Without it the funnel offers
 * times that look free here and are not free to the human who has to show up.
 * Applied to the CLAIM as well, for the same reason the notice window is — the
 * picker can sit open while a sweep runs behind it.
 */
export async function listOpenSlots(
  timeZone: string,
  noticeMinutes = DEFAULT_NOTICE_MINUTES,
  limit = 12,
): Promise<OpenSlot[]> {
  const rows = await query<{
    id: string;
    day_label: string;
    time_label: string;
    duration_minutes: string;
  }>(
    `SELECT id,
            to_char(starts_at AT TIME ZONE $1, 'Dy, DD Mon')   AS day_label,
            to_char(starts_at AT TIME ZONE $1, 'HH24:MI')      AS time_label,
            EXTRACT(EPOCH FROM (ends_at - starts_at))/60       AS duration_minutes
       FROM marketing.booking_slots
      WHERE status = 'open'
        AND external_busy_at IS NULL
        AND starts_at > now() + make_interval(mins => $2)
      ORDER BY starts_at
      LIMIT $3`,
    [timeZone, noticeMinutes, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    dayLabel: r.day_label,
    timeLabel: r.time_label,
    durationMinutes: Math.round(Number(r.duration_minutes)),
  }));
}

export type BookResult =
  | {
      ok: true;
      dayLabel: string;
      timeLabel: string;
      /**
       * The Google Meet link, when there is one. Absent whenever Google
       * Calendar is unconfigured or returned no conference, which is the
       * common case today - the confirmation drops the join line rather than
       * rendering an empty link.
       */
      meetingUrl?: string | null;
    }
  | { ok: false; reason: "taken" };

/**
 * Claim a slot.
 *
 * The `AND status = 'open'` in the WHERE clause is the entire concurrency
 * control, and it is enough: a single UPDATE is atomic, so of two visitors
 * pressing the same 18:30 at the same moment exactly one matches a row and the
 * other updates nothing. No transaction, no lock, no read-then-write race.
 *
 * The loser is told plainly that the time went. Silently booking them into the
 * next slot instead would be the kind of helpfulness nobody asked for, and they
 * would turn up at the wrong time.
 *
 * ── THE NOTICE WINDOW IS CHECKED HERE TOO, NOT ONLY IN listOpenSlots ───────
 *
 * The claim used to guard on `starts_at > now()`, which only rules out a slot
 * that has already begun. The picker is rendered once and can sit on screen for
 * as long as the visitor likes — read the page at 09:00, choose 13:00, submit
 * at 12:30 — so the minimum-notice rule was enforceable only at the moment the
 * list was drawn, and a booking inside the window was reachable by doing
 * nothing more unusual than hesitating. Both queries now apply the same
 * interval, so the guarantee holds at the point it actually matters.
 *
 * A slot lost this way returns `taken`, which is the honest answer from the
 * visitor's side: the time is no longer available to them, and the picker
 * re-renders with what is.
 */
export async function bookSlot(
  slotId: string,
  submissionId: string,
  name: string,
  timeZone: string,
  noticeMinutes = DEFAULT_NOTICE_MINUTES,
): Promise<BookResult> {
  const rows = await query<{
    day_label: string;
    time_label: string;
    starts_at: Date;
    ends_at: Date;
  }>(
    `UPDATE marketing.booking_slots
        SET status = 'booked',
            submission_id = $2,
            booked_at = now(),
            booked_name = $3
      WHERE id = $1
        AND status = 'open'
        AND external_busy_at IS NULL
        AND starts_at > now() + make_interval(mins => $5)
    RETURNING to_char(starts_at AT TIME ZONE $4, 'Dy, DD Mon') AS day_label,
              to_char(starts_at AT TIME ZONE $4, 'HH24:MI')    AS time_label,
              starts_at, ends_at`,
    [slotId, submissionId, name.slice(0, 200), timeZone, noticeMinutes],
  );

  if (rows.length === 0) return { ok: false, reason: "taken" };
  const row = rows[0]!;

  // The slot is now genuinely claimed. Mirroring it into Google Calendar comes
  // second and cannot undo it — see syncBookingToCalendar.
  const meetingUrl = await syncBookingToCalendar(
    slotId,
    submissionId,
    row.starts_at,
    row.ends_at,
  );

  return { ok: true, dayLabel: row.day_label, timeLabel: row.time_label, meetingUrl };
}

export type RescheduleResult =
  | {
      ok: true;
      dayLabel: string;
      timeLabel: string;
      startsAt: Date;
      endsAt: Date;
      /** The event to cancel in Google, if the old booking had one. */
      oldCalendarEventId: string | null;
    }
  /** The new time went to somebody else, or slipped inside the notice window. */
  | { ok: false; reason: "taken" }
  /** The old booking is no longer theirs to move — cancelled, or already moved. */
  | { ok: false; reason: "gone" };

/**
 * Move a booking from one slot to another.
 *
 * ── WHY THIS IS ONE TRANSACTION AND `bookSlot` IS NOT ──────────────────────
 *
 * A plain claim is a single atomic UPDATE, and that is genuinely sufficient:
 * one statement either matches an open row or does not. A reschedule is two
 * statements that must both hold, and each of the four ways to get that wrong
 * is a real failure someone would experience:
 *
 *   release then fail to claim   they lose their appointment and get nothing
 *   claim then fail to release   the team's diary shows them twice
 *
 * So both run inside `withTransaction`, and a zero-row result on either rolls
 * the whole thing back. The visitor ends up exactly where they started, which
 * is the only acceptable outcome for a failed move.
 *
 * ── ORDER: RELEASE FIRST ───────────────────────────────────────────────────
 *
 * Releasing before claiming lets somebody move to an ADJACENT slot without
 * fighting themselves for it, and — more importantly — it is the order that
 * makes `booking_slots_starts_uniq` a non-issue, since the old row goes back to
 * 'open' before the new one is touched.
 *
 * ── THE `submission_id = $2` GUARD IS THE AUTHORISATION CHECK ──────────────
 *
 * The submission id comes from the signed httpOnly cookie the token exchange
 * set, never from the request body. Pinning the release to it means a token for
 * one booking cannot release a different one, even if a slot id were guessed.
 *
 * Google is told AFTER the commit, in the caller — the database decides, the
 * calendar mirrors, and a Google failure must never undo a real reservation.
 */
export async function rescheduleSlot(
  oldSlotId: string,
  newSlotId: string,
  submissionId: string,
  name: string,
  timeZone: string,
  noticeMinutes = DEFAULT_NOTICE_MINUTES,
): Promise<RescheduleResult> {
  return withTransaction<RescheduleResult>(async (client) => {
    const { rows: released } = await client.query<{ calendar_event_id: string | null }>(
      `UPDATE marketing.booking_slots
          SET status            = 'open',
              submission_id     = NULL,
              booked_at         = NULL,
              booked_name       = NULL,
              calendar_event_id = NULL,
              calendar_error    = NULL,
              meeting_url       = NULL
        WHERE id = $1
          AND submission_id = $2
          AND status = 'booked'
      RETURNING calendar_event_id`,
      [oldSlotId, submissionId],
    );
    if (released.length === 0) return { ok: false as const, reason: "gone" as const };

    // The same notice window and busy check the picker was drawn with, so a
    // slot that has slipped inside it while the page sat open is refused rather
    // than silently taken.
    const { rows: claimed } = await client.query<{
      day_label: string;
      time_label: string;
      starts_at: Date;
      ends_at: Date;
    }>(
      `UPDATE marketing.booking_slots
          SET status = 'booked',
              submission_id = $2,
              booked_at = now(),
              booked_name = $3
        WHERE id = $1
          AND status = 'open'
          AND external_busy_at IS NULL
          AND starts_at > now() + make_interval(mins => $5)
      RETURNING to_char(starts_at AT TIME ZONE $4, 'Dy, DD Mon') AS day_label,
                to_char(starts_at AT TIME ZONE $4, 'HH24:MI')    AS time_label,
                starts_at, ends_at`,
      [newSlotId, submissionId, name.slice(0, 200), timeZone, noticeMinutes],
    );
    if (claimed.length === 0) {
      // Throwing is what rolls back the release above. Caught immediately below
      // and turned back into an ordinary "taken" answer — the visitor sees the
      // same message they would from a lost race on a first booking, and their
      // original slot is still theirs.
      throw new SlotUnavailable();
    }

    const row = claimed[0]!;
    return {
      ok: true as const,
      dayLabel: row.day_label,
      timeLabel: row.time_label,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      oldCalendarEventId: released[0]!.calendar_event_id,
    };
  }).catch((err) => {
    if (err instanceof SlotUnavailable) return { ok: false as const, reason: "taken" as const };
    throw err;
  });
}

/** Internal control flow for `rescheduleSlot` — never escapes this module. */
class SlotUnavailable extends Error {}

/**
 * Mirror a claimed slot into Google Calendar.
 *
 * ── WHY THE DATABASE GOES FIRST, AND WHY THIS CANNOT UNDO IT ───────────────
 *
 * The atomic `UPDATE ... WHERE status = 'open'` is the concurrency control: it
 * is what stops two visitors both taking 18:30. Creating the calendar event
 * first would leave that race open, and a Google failure would then strand an
 * orphan event on a slot still showing as free.
 *
 * So the claim lands first, which means by the time this runs the visitor is
 * already being shown a confirmation. A calendar failure therefore MUST NOT
 * fail the booking. Throwing here would tell someone their booking failed when
 * the slot is genuinely reserved for them — and they would try again and find
 * their own slot taken. The error is recorded on the row instead, and migration
 * 0027's partial index makes "booked but not in the calendar" a one-line query.
 *
 * ── UNCONFIGURED IS NOT AN ERROR ───────────────────────────────────────────
 *
 * Without Google credentials `getScheduler()` returns `UnavailableScheduler`,
 * whose `book()` throws by design. That throw means "a caller invented a slot",
 * which is not what happened here — the slot is real, it came out of the
 * operator's own diary. The DB-backed booking system works standalone and
 * always has. So `configured` is checked first and the sync is skipped quietly
 * rather than writing a misleading error onto every booking in a deployment
 * that simply has not connected a calendar.
 */
async function syncBookingToCalendar(
  slotId: string,
  submissionId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<string | null> {
  const scheduler = getScheduler();
  if (!scheduler.configured) {
    /**
     * Two very different situations arrive here, and conflating them is what
     * made this invisible for three bookings.
     *
     *   Nobody configured a calendar  — expected, and correctly silent. The
     *                                   DB-backed booking system works alone.
     *   A calendar IS configured and was REJECTED — a misconfiguration. The
     *                                   booking looks identical to the visitor
     *                                   and the row looks identical to an
     *                                   operator: event id NULL, error NULL.
     *
     * The second is now recorded, so "booked but not in the calendar" points at
     * a cause instead of at nothing. The trigger was an OPTIONAL setting passed
     * as an empty string by docker-compose; the Google credentials were fine
     * the whole time and nothing said otherwise.
     */
    const configured = Boolean(
      process.env.GOOGLE_CALENDAR_ID?.trim() &&
        process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() &&
        process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    );
    if (configured) {
      const why = (scheduler as { reason?: string }).reason ?? "scheduler unavailable";
      console.error(`[funnel] Google Calendar is configured but unusable: ${why}`);
      await recordCalendarOutcome(slotId, null, `calendar configured but unusable: ${why}`);
    }
    return null;
  }

  try {
    // The scheduler titles the event and invites the attendee, so it needs more
    // than the name the visitor typed at step 3. SELECT is granted to
    // aura_marketing on this table (0020); nothing here widens that.
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
      // The submission vanished between claiming the slot and reading it back —
      // an erasure request landing mid-booking is the only realistic cause.
      // Recorded rather than thrown: the slot is still legitimately taken.
      await recordCalendarOutcome(slotId, null, "submission not found when creating the event");
      return null;
    }

    const { eventId, meetingUrl } = await scheduler.book(
      { start: startsAt, end: endsAt },
      submission,
    );
    await recordCalendarOutcome(slotId, eventId, null, meetingUrl ?? null);
    return meetingUrl ?? null;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(`[funnel] calendar sync failed for slot ${slotId}:`, message);
    await recordCalendarOutcome(slotId, null, message);
    return null;
  }
}

/**
 * Record the sync result. Deliberately swallows its own failure.
 *
 * This is bookkeeping about a booking that has already succeeded. If writing the
 * outcome fails too, the booking is still valid and the visitor is still
 * expected; turning a failed audit write into a failed booking would be the tail
 * wagging the dog. The log is the fallback record.
 */
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
      `[funnel] could not record calendar outcome for slot ${slotId} ` +
        `(event=${eventId ?? "none"}, error=${error ?? "none"}):`,
      (err as Error).message,
    );
  }
}
