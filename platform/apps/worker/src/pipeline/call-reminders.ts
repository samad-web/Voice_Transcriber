import { getAdminPool } from "@aura/db";
import type { MessageTemplateKey } from "@aura/shared";
import { enqueueBookingNotification } from "./booking-notifications-outbox";
import { emailConfigured } from "./funnel-followup";

/**
 * Scheduling the reminders for a booked call: a day before, an hour before,
 * five minutes before.
 *
 * ── THE SCHEDULE LIVES IN THE ROW, NOT IN THE SWEEP ────────────────────────
 *
 * The obvious design is a sweep that runs every minute and asks "is any call
 * starting in roughly an hour?". It is wrong in a way that only shows up in
 * production: "roughly" has to be a window, the window has to be at least as
 * wide as the sweep interval, and if the worker is down across that window the
 * reminder is lost forever with nothing recording that it was owed.
 *
 * So this sweep does not decide WHEN to send. It notices a booking once, works
 * out the three instants from `starts_at`, and inserts three rows already
 * stamped with those instants. The drain's ordinary `next_attempt_at <= now()`
 * check then fires each one at its hour — no window, no tolerance constant, and
 * a worker that was down for six hours sends what it owes on the next tick
 * (subject to the drain's own overdue expiry, which is what stops it sending a
 * reminder for a call that has already happened).
 *
 * Idempotency is the outbox's unique key on (booking_slot_id, template,
 * channel), so re-running this over the same booking inserts nothing.
 *
 * ── PAST INSTANTS ARE SKIPPED, NOT QUEUED ──────────────────────────────────
 *
 * Somebody can book a slot ninety minutes out. Queueing the 24-hour reminder
 * for them means queueing a row whose send time is yesterday, which the drain
 * would either fire immediately ("your call is tomorrow" — it is not) or expire
 * as overdue. Both are noise. A booking gets only the reminders that are still
 * in its future, so a same-day booking gets one or two rather than three.
 *
 * ── EMAIL IS QUEUED ONLY WHEN MAIL ACTUALLY WORKS ──────────────────────────
 *
 * `getFollowUpDispatcher()` falls back to a log-only dispatcher when no
 * provider is configured, and log-only marks a row `sent` with a `log-only:`
 * id. That convention is right for a rejection — the row is the record that the
 * message existed, and the prefix makes the never-delivered ones findable — but
 * queueing a second, undeliverable copy of every reminder would double this
 * table for no gain and make "what did we send this person" harder to read. So
 * the email half turns itself on the day a provider is configured, and stays
 * out of the way until then.
 */

/** Minutes before `starts_at` that each stage fires. */
const STAGES: ReadonlyArray<{ template: MessageTemplateKey; minutesBefore: number }> = [
  { template: "reminder_call_24h", minutesBefore: 24 * 60 },
  { template: "reminder_call_1h", minutesBefore: 60 },
  { template: "reminder_call_5m", minutesBefore: 5 },
];

/**
 * How far ahead to look.
 *
 * Bounded rather than "all future bookings" so the first tick after a deploy
 * does not walk the whole diary. Anything further out is picked up on a later
 * tick, long before its 24-hour reminder is due — the sweep runs every five
 * minutes and the window is measured in days.
 */
const HORIZON_DAYS = positiveInt(process.env.CALL_REMINDER_HORIZON_DAYS, 30);

const BATCH = positiveInt(process.env.CALL_REMINDER_BATCH, 200);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Queue whatever reminders are still owed. Returns how many rows were added. */
export async function sweepCallReminders(): Promise<number> {
  const pool = getAdminPool();

  const { rows } = await pool.query<{ id: string; starts_at: string }>(
    `SELECT b.id, b.starts_at
       FROM marketing.booking_slots b
       -- INNER join: a booking whose enquirer was erased (submission_id is
       -- ON DELETE SET NULL) has nobody to remind, and the drain would only
       -- dead-letter it with "no recipient".
       JOIN marketing.funnel_submissions s ON s.id = b.submission_id
      WHERE b.status = 'booked'
        AND b.starts_at > now()
        AND b.starts_at < now() + make_interval(days => $1)
        -- Nothing queued for this booking yet. Cheaper than letting all three
        -- inserts bounce off ON CONFLICT on every tick for every future call.
        AND NOT EXISTS (
              SELECT 1 FROM marketing.booking_notifications n
               WHERE n.booking_slot_id = b.id
                 AND n.template LIKE 'reminder_call_%'
            )
      ORDER BY b.starts_at
      LIMIT $2`,
    [HORIZON_DAYS, BATCH],
  );

  if (rows.length === 0) return 0;

  const withEmail = emailConfigured();
  const now = Date.now();
  let queued = 0;

  for (const row of rows) {
    const startsAt = new Date(row.starts_at).getTime();

    for (const stage of STAGES) {
      const sendAt = new Date(startsAt - stage.minutesBefore * 60_000);
      if (sendAt.getTime() <= now) continue;

      try {
        await enqueueBookingNotification(pool, row.id, stage.template, "whatsapp", sendAt);
        queued++;
        // reminder_call_5m has no email copy on purpose — five minutes is not
        // enough notice for mail to be read, and renderMessage would refuse it.
        if (withEmail && stage.template !== "reminder_call_5m") {
          await enqueueBookingNotification(pool, row.id, stage.template, "email", sendAt);
          queued++;
        }
      } catch (err) {
        // One bad booking must not strand the reminders behind it.
        console.error(
          `call reminders: could not queue ${stage.template} for ${row.id}:`,
          (err as Error).message,
        );
      }
    }
  }

  if (queued > 0) console.log(`call reminders: scheduled ${queued} reminder(s)`);
  return queued;
}

/**
 * Every 5 minutes.
 *
 * Nothing here is time-critical, because this sweep only SCHEDULES — the drain
 * is what sends, and it reads the instant off the row. A booking made three
 * minutes ago being noticed two minutes from now changes nothing about when its
 * reminders arrive. The only case that cares is a booking made less than five
 * minutes before its own call, which cannot happen: the slot picker refuses
 * anything inside its minimum-notice window.
 */
export function startCallReminders(): NodeJS.Timeout {
  const interval = positiveInt(process.env.CALL_REMINDER_INTERVAL_MS, 5 * 60_000);
  return setInterval(
    () => void sweepCallReminders().catch((err) => console.error("call reminders:", err)),
    interval,
  );
}
