import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Bookable slots — the sales team's diary, owned by the application.
 *
 * Cross-tenant: a slot belongs to the platform, not to any customer org, so
 * this uses the admin pool like the rest of the operator surface.
 *
 * ── WHY POSTGRES DOES THE TIME-ZONE ARITHMETIC ──────────────────────────────
 *
 * The console sends a wall-clock date and time plus a zone name — "11 August,
 * 18:30, Asia/Kolkata" — and the column is `timestamptz`, an absolute instant.
 * Converting between them correctly means knowing that zone's UTC offset ON
 * THAT DATE, which changes across a DST boundary.
 *
 * Node has no zone database in its date arithmetic, so doing this in TypeScript
 * means either a dependency or hand-rolled offset maths that is wrong twice a
 * year. Postgres already carries the IANA database:
 *
 *     ($1::date + $2::time) AT TIME ZONE $3
 *
 * India has no DST so this is currently academic — but the scheduler's zone is
 * configurable, and "correct only for Asia/Kolkata" is the kind of assumption
 * that surfaces as a one-hour-wrong appointment in a market you just entered.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

const ListQuery = z.object({
  /** Inclusive date bounds, in the given zone. Defaults to the month around today. */
  from: z.string().regex(ISO_DATE).optional(),
  to: z.string().regex(ISO_DATE).optional(),
  timeZone: z.string().min(1).max(64).optional(),
});

const BookedQuery = z.object({
  /** How far ahead to look. Capped so a typo cannot ask for the whole table. */
  days: z.coerce.number().int().min(1).max(365).optional(),
  timeZone: z.string().min(1).max(64).optional(),
  /** Include calls that have already happened — for "did we do that one?". */
  includePast: z.coerce.boolean().optional(),
});

const CreateBody = z.object({
  date: z.string().regex(ISO_DATE),
  /** One or more "HH:MM" start times on that date. */
  times: z.array(z.string().regex(HH_MM)).min(1).max(48),
  durationMinutes: z.number().int().min(5).max(480).default(30),
  timeZone: z.string().min(1).max(64).default("Asia/Kolkata"),
  actor: z.string().min(1).max(200).optional(),
});

/** Guard rails on a bulk write. A typo'd year must not create 400,000 rows. */
const MAX_DAYS = 92;
const MAX_SLOTS = 600;

const GenerateBody = z.object({
  fromDate: z.string().regex(ISO_DATE),
  toDate: z.string().regex(ISO_DATE),
  /** 0 = Sunday … 6 = Saturday, matching JS getDay() and Postgres DOW. */
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  dayStart: z.string().regex(HH_MM),
  dayEnd: z.string().regex(HH_MM),
  durationMinutes: z.number().int().min(5).max(480),
  /** 0 is legitimate — back-to-back is a choice, just not the default. */
  bufferMinutes: z.number().int().min(0).max(240).default(0),
  timeZone: z.string().min(1).max(64).default("Asia/Kolkata"),
  actor: z.string().min(1).max(200).optional(),
});

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

const fromMinutes = (mins: number): string =>
  `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

/**
 * Inclusive list of YYYY-MM-DD strings.
 *
 * `Date.UTC` and `getUTCDay`, deliberately: this walks calendar dates, and
 * using local-time constructors would shift the whole range by a day for any
 * server running west of UTC. There is no zone here — these are labels, and the
 * zone is applied to them later by Postgres.
 */
function datesBetween(from: string, to: string): string[] {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const end = Date.UTC(ty!, tm! - 1, td!);
  const out: string[] = [];
  for (let t = Date.UTC(fy!, fm! - 1, fd!); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
    if (out.length > MAX_DAYS) break;
  }
  return out;
}

function dayOfWeek(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

@Controller("admin/slots")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class SlotsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@Query() query: unknown) {
    const parsed = ListQuery.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { from, to, timeZone = "Asia/Kolkata" } = parsed.data;

    // `local_date` and `local_time` are computed server-side in the target zone
    // so the console never has to re-derive them from an instant and risk
    // disagreeing about which day a 23:30 slot belongs to.
    const { rows } = await this.db.adminPool().query(
      `SELECT s.id,
              s.starts_at,
              s.ends_at,
              s.status,
              s.booked_name,
              s.booked_at,
              s.submission_id,
              to_char(s.starts_at AT TIME ZONE $3, 'YYYY-MM-DD') AS local_date,
              to_char(s.starts_at AT TIME ZONE $3, 'HH24:MI')    AS local_time,
              EXTRACT(EPOCH FROM (s.ends_at - s.starts_at))/60   AS duration_minutes
         FROM marketing.booking_slots s
        WHERE s.status <> 'cancelled'
          AND ($1::date IS NULL OR (s.starts_at AT TIME ZONE $3)::date >= $1::date)
          AND ($2::date IS NULL OR (s.starts_at AT TIME ZONE $3)::date <= $2::date)
        ORDER BY s.starts_at`,
      [from ?? null, to ?? null, timeZone],
    );
    return { slots: rows, timeZone };
  }

  /**
   * The calls that are actually booked, with the details needed to make them.
   *
   * ── WHY THIS IS NOT JUST A FILTER ON THE LIST ABOVE ──────────────────────
   *
   * That endpoint answers "what does my diary look like", and the console
   * renders it as a month grid where a dot means SLOTS EXIST on that day. It
   * cannot answer "who am I speaking to today" — an empty Tuesday and a
   * fully-booked Tuesday look identical, and finding out costs a click per day.
   *
   * It also could not answer it even with a filter, because the useful part is
   * not on `booking_slots`: a name is not enough to make a call. This joins the
   * submission for the phone number and email, which is the actual reason
   * somebody opens this page in the morning.
   *
   * LEFT JOIN, not INNER. `submission_id` is ON DELETE SET NULL (0023) so an
   * enquirer erased under a DPDP request leaves the appointment standing with
   * the person detached — deliberately, so the operator's calendar does not
   * silently lose an hour they have committed. An inner join would hide exactly
   * those rows, which is the opposite of what the operator needs to see.
   */
  @Get("booked")
  async booked(@Query() query: unknown) {
    const parsed = BookedQuery.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { days = 14, timeZone = "Asia/Kolkata", includePast = false } = parsed.data;

    const { rows } = await this.db.adminPool().query(
      `SELECT s.id,
              s.starts_at,
              s.booked_at,
              s.booked_name,
              s.submission_id,
              s.calendar_event_id,
              s.calendar_error,
              to_char(s.starts_at AT TIME ZONE $2, 'Dy, DD Mon') AS day_label,
              to_char(s.starts_at AT TIME ZONE $2, 'HH24:MI')    AS time_label,
              EXTRACT(EPOCH FROM (s.ends_at - s.starts_at))/60   AS duration_minutes,
              f.name  AS enquirer_name,
              f.email AS enquirer_email,
              COALESCE(f.whatsapp_e164, f.phone_e164) AS enquirer_phone,
              f.business_type,
              f.team_size,
              f.budget_inr,
              f.crm_name,
              f.crm_satisfied,
              f.status AS lead_status
         FROM marketing.booking_slots s
         LEFT JOIN marketing.funnel_submissions f ON f.id = s.submission_id
        WHERE s.status = 'booked'
          AND ($3::boolean OR s.starts_at > now())
          AND s.starts_at < now() + make_interval(days => $1)
        ORDER BY s.starts_at`,
      [days, timeZone, includePast],
    );
    return { bookings: rows, timeZone };
  }

  /**
   * Create one or more slots on a date.
   *
   * `ON CONFLICT DO NOTHING` against the partial unique index on starts_at, so
   * adding 18:30 twice is a no-op rather than a 500. The response reports what
   * was actually created, which is what lets the console say "3 added, 1 already
   * existed" instead of claiming four.
   */
  @Post()
  async create(@Body() body: unknown) {
    const parsed = CreateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { date, times, durationMinutes, timeZone, actor = "console" } = parsed.data;

    const unique = [...new Set(times)];
    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");
      const created: unknown[] = [];
      for (const t of unique) {
        const { rows } = await client.query(
          `INSERT INTO marketing.booking_slots (starts_at, ends_at, created_by)
           VALUES (
             ($1::date + $2::time) AT TIME ZONE $4,
             (($1::date + $2::time) AT TIME ZONE $4) + make_interval(mins => $3),
             $5
           )
           ON CONFLICT DO NOTHING
           RETURNING id, starts_at, ends_at, status`,
          [date, t, durationMinutes, timeZone, actor],
        );
        if (rows[0]) created.push(rows[0]);
      }
      await client.query("COMMIT");
      return { created, requested: unique.length, skipped: unique.length - created.length };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Generate a run of slots across a date range.
   *
   * ── THE BUFFER ──────────────────────────────────────────────────────────
   *
   * Slots advance by `durationMinutes + bufferMinutes`, so a 30-minute call
   * with a 10-minute buffer produces 10:00, 10:40, 11:20 — never 10:00, 10:30,
   * 11:00. The gap is built into the spacing rather than enforced at booking
   * time, which matters: a buffer that only exists as a rule at booking has to
   * be re-checked on every write and is invisible to anyone reading the table.
   * Baked into the times, it is simply true, and the funnel needs to know
   * nothing about it.
   *
   * A slot is only emitted if the WHOLE call fits before `dayEnd`. With a
   * 10:00-11:00 window and a 45-minute duration you get 10:00 and nothing else;
   * emitting 10:45 would book someone into a meeting that runs past the end of
   * the working day.
   *
   * ── WHY ONE STATEMENT ───────────────────────────────────────────────────
   *
   * A month of weekdays at 12 a day is ~250 rows. As 250 round trips over a
   * pooled connection to Seoul that is a visibly slow button; as one multi-row
   * INSERT it is a single hop. The wall-clock date and time still go in as
   * parameters and Postgres still does the zone conversion — the same
   * `($n::date + $n::time) AT TIME ZONE $tz` as the single-slot path, just
   * repeated per row.
   *
   * `WHERE s > now()` drops anything already in the past, so generating "this
   * month" on the 20th quietly starts from today rather than filling the
   * console with dead mornings.
   */
  @Post("generate")
  async generate(@Body() body: unknown) {
    const parsed = GenerateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const {
      fromDate, toDate, weekdays, dayStart, dayEnd,
      durationMinutes, bufferMinutes, timeZone, actor = "console",
    } = parsed.data;

    const startMin = toMinutes(dayStart);
    const endMin = toMinutes(dayEnd);
    if (endMin <= startMin) throw new BadRequestException("dayEnd must be after dayStart");

    const days = datesBetween(fromDate, toDate);
    if (days.length === 0) throw new BadRequestException("toDate must not be before fromDate");
    if (days.length > MAX_DAYS) {
      throw new BadRequestException(`range is limited to ${MAX_DAYS} days`);
    }

    // (date, time) pairs on the local calendar. No Date objects, no zones —
    // this is wall-clock arithmetic in minutes, and the zone is applied once,
    // by Postgres, when the row is written.
    const pairs: Array<[string, string]> = [];
    const stride = durationMinutes + bufferMinutes;
    for (const d of days) {
      if (!weekdays.includes(dayOfWeek(d))) continue;
      for (let m = startMin; m + durationMinutes <= endMin; m += stride) {
        pairs.push([d, fromMinutes(m)]);
      }
    }

    if (pairs.length === 0) return { created: 0, requested: 0, skipped: 0 };
    if (pairs.length > MAX_SLOTS) {
      throw new BadRequestException(
        `that would create ${pairs.length} slots; the limit is ${MAX_SLOTS} per request`,
      );
    }

    const params: unknown[] = [durationMinutes, timeZone, actor];
    const tuples = pairs.map(([d, t]) => {
      const di = params.push(d);
      const ti = params.push(t);
      return `(($${di}::date + $${ti}::time) AT TIME ZONE $2, ` +
             `(($${di}::date + $${ti}::time) AT TIME ZONE $2) + make_interval(mins => $1), $3)`;
    });

    const { rows } = await this.db.adminPool().query(
      `INSERT INTO marketing.booking_slots (starts_at, ends_at, created_by)
       SELECT s, e, c FROM (VALUES ${tuples.join(", ")}) AS v(s, e, c)
        WHERE s > now()
       ON CONFLICT DO NOTHING
       RETURNING id`,
      params,
    );

    return { created: rows.length, requested: pairs.length, skipped: pairs.length - rows.length };
  }

  /**
   * Cancel a slot.
   *
   * Never a hard DELETE. A booked slot has someone's expectation attached to it,
   * and a row that vanishes takes the evidence of that appointment with it —
   * including who was booked and when. Cancelling keeps the record and frees the
   * time, because the unique index that reserves `starts_at` ignores cancelled
   * rows.
   */
  /**
   * Cancel a slot, booked or not.
   *
   * ── THIS USED TO 500 ON EXACTLY THE SLOTS THAT MATTER ────────────────────
   *
   * It set `status = 'cancelled'` and nothing else, which trips 0023's
   * constraint `(status = 'booked') = (booked_at IS NOT NULL)`: a cancelled row
   * still carrying `booked_at` satisfies neither side. So cancelling an OPEN
   * slot worked and cancelling a BOOKED one threw a check-constraint error,
   * surfaced in the console as a bare "API 500" with no hint that the booking
   * was the problem. An operator could not cancel the one kind of slot they
   * most need to.
   *
   * The booking fields are therefore cleared alongside the status, and the
   * booking that was destroyed is RETURNED rather than silently dropped: a
   * human agreed to that time and is still expecting the call, and the console
   * has to be able to say so.
   */
  @Delete(":id")
  async cancel(@Param("id") id: string) {
    if (!z.string().uuid().safeParse(id).success) {
      throw new BadRequestException("slot id must be a uuid");
    }

    // Read first: `UPDATE ... RETURNING` yields the NEW row, so the booking
    // details would come back already blanked.
    const { rows: before } = await this.db.adminPool().query<{
      booked_name: string | null;
      submission_id: string | null;
      calendar_event_id: string | null;
    }>(
      `SELECT booked_name, submission_id, calendar_event_id
         FROM marketing.booking_slots
        WHERE id = $1 AND status <> 'cancelled'`,
      [id],
    );
    if (before.length === 0) throw new NotFoundException("slot not found, or already cancelled");

    const { rows } = await this.db.adminPool().query(
      `UPDATE marketing.booking_slots
          SET status            = 'cancelled',
              submission_id     = NULL,
              booked_at         = NULL,
              booked_name       = NULL,
              calendar_event_id = NULL,
              calendar_error    = NULL
        WHERE id = $1 AND status <> 'cancelled'
      RETURNING id, starts_at, status`,
      [id],
    );
    if (rows.length === 0) throw new NotFoundException("slot not found, or already cancelled");

    const had = before[0]!;
    return {
      slot: rows[0],
      // Non-null when the cancellation destroyed a real appointment. The
      // console warns; nothing here contacts the person, because an automatic
      // "your call is cancelled" with no reason attached is worse than a human
      // sending one.
      cancelledBooking: had.submission_id
        ? {
            name: had.booked_name,
            submissionId: had.submission_id,
            calendarEventId: had.calendar_event_id,
          }
        : null,
    };
  }
}
