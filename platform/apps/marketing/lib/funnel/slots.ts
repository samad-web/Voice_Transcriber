import { getScheduler } from "@/lib/scheduler";
import { query } from "./db";

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
 * The next few genuinely bookable slots.
 *
 * `starts_at > now() + notice` is not decoration. Offering a slot twenty minutes
 * from now produces a booking nobody on the team sees in time, which is worse
 * than offering nothing — the visitor believes they have an appointment and the
 * calendar agrees, and only the human is missing.
 */
export async function listOpenSlots(
  timeZone: string,
  noticeMinutes = 120,
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
  | { ok: true; dayLabel: string; timeLabel: string }
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
 */
export async function bookSlot(
  slotId: string,
  submissionId: string,
  name: string,
  timeZone: string,
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
        AND starts_at > now()
    RETURNING to_char(starts_at AT TIME ZONE $4, 'Dy, DD Mon') AS day_label,
              to_char(starts_at AT TIME ZONE $4, 'HH24:MI')    AS time_label,
              starts_at, ends_at`,
    [slotId, submissionId, name.slice(0, 200), timeZone],
  );

  if (rows.length === 0) return { ok: false, reason: "taken" };
  const row = rows[0]!;

  // The slot is now genuinely claimed. Mirroring it into Google Calendar comes
  // second and cannot undo it — see syncBookingToCalendar.
  await syncBookingToCalendar(slotId, submissionId, row.starts_at, row.ends_at);

  return { ok: true, dayLabel: row.day_label, timeLabel: row.time_label };
}

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
): Promise<void> {
  const scheduler = getScheduler();
  if (!scheduler.configured) return;

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
      return;
    }

    const { eventId } = await scheduler.book({ start: startsAt, end: endsAt }, submission);
    await recordCalendarOutcome(slotId, eventId, null);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(`[funnel] calendar sync failed for slot ${slotId}:`, message);
    await recordCalendarOutcome(slotId, null, message);
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
): Promise<void> {
  try {
    await query(
      `UPDATE marketing.booking_slots
          SET calendar_event_id = $2,
              calendar_error    = $3
        WHERE id = $1`,
      [slotId, eventId, error ? error.slice(0, 500) : null],
    );
  } catch (err) {
    console.error(
      `[funnel] could not record calendar outcome for slot ${slotId} ` +
        `(event=${eventId ?? "none"}, error=${error ?? "none"}):`,
      (err as Error).message,
    );
  }
}
