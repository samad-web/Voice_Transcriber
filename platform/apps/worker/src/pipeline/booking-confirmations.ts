import { getAdminPool } from "@aura/db";
import { enqueueFollowUp } from "./funnel-followup-outbox";

/**
 * Queue a WhatsApp confirmation for anyone who has booked a call and not had
 * one.
 *
 * ── WHY A SWEEP AND NOT AN ENQUEUE IN THE BOOKING ITSELF ───────────────────
 *
 * The obvious design is to insert the outbox row inside the transaction that
 * claims the slot. That transaction runs in the marketing app, as
 * `aura_marketing`, which holds NO grant on `marketing.funnel_followups` — a
 * deliberate refusal repeated by migrations 0024, 0025 and 0032. The marketing
 * container is the only one serving unauthenticated public traffic; a public
 * server that can insert into the outbox is a public server that can make us
 * send WhatsApp messages to arbitrary numbers.
 *
 * So the booking writes only what it owns — the slot — and the worker, which is
 * unreachable from the internet, notices and queues the message. The cost is up
 * to one sweep interval of delay on a confirmation. That is the right trade:
 * the person has just seen a confirmation screen with the Meet link on it, so
 * the WhatsApp is a record rather than the first they hear of it.
 *
 * ── WHY IT NEEDS NO TIME WINDOW ────────────────────────────────────────────
 *
 * "Bookings in the last N hours" was the first design and it is wrong in both
 * directions: narrow enough to be safe after a deploy, and a worker restart
 * during an outage silently drops a real confirmation; wide enough to survive
 * an outage, and it messages the whole backlog on the first tick.
 *
 * Migration 0032 settled every booking that existed when this shipped, so the
 * outbox's own unique key is the marker and the query can simply ask "booked,
 * with no confirmation row" for all time. A worker that has been down for a
 * week catches up correctly on the next tick.
 *
 * ── PAST SLOTS ARE SKIPPED ─────────────────────────────────────────────────
 *
 * `starts_at > now()` because a confirmation for a call that already happened
 * is noise at best. If the worker was down across someone's appointment, a
 * message telling them to join a meeting that finished two hours ago is worse
 * than silence. They are left with no outbox row at all rather than a dead one,
 * so a later manual send from the console is still possible.
 */

const BATCH = 200;

export async function sweepBookingConfirmations(): Promise<number> {
  const pool = getAdminPool();

  const { rows } = await pool.query<{ submission_id: string }>(
    `SELECT DISTINCT b.submission_id
       FROM marketing.booking_slots b
      WHERE b.status = 'booked'
        AND b.submission_id IS NOT NULL
        AND b.starts_at > now()
        AND NOT EXISTS (
              SELECT 1
                FROM marketing.funnel_followups f
               WHERE f.submission_id = b.submission_id
                 AND f.template = 'booking_confirmed'
                 AND f.channel  = 'whatsapp'
            )
      LIMIT $1`,
    [BATCH],
  );

  if (rows.length === 0) return 0;

  let queued = 0;
  for (const row of rows) {
    try {
      // ON CONFLICT DO NOTHING inside, so a second sweeper racing this one
      // cannot produce two confirmations for one person.
      await enqueueFollowUp(pool, row.submission_id, "booking_confirmed", "whatsapp");
      queued++;
    } catch (err) {
      // One bad row must not stop the rest. Logged rather than thrown, because
      // the alternative is a sweep that dies on submission #1 and never reaches
      // the ninety-nine confirmations behind it.
      console.error(
        `booking confirmations: could not queue for ${row.submission_id}:`,
        (err as Error).message,
      );
    }
  }

  if (queued > 0) console.log(`booking confirmations: queued ${queued} message(s)`);
  return queued;
}

/**
 * Every 60 seconds, matching the follow-up drain it feeds.
 *
 * A tighter loop would not make delivery meaningfully faster — the drain it
 * queues into runs on the same interval — and this is one more timer on a
 * process already running several.
 */
export function startBookingConfirmations(): NodeJS.Timeout {
  const interval = positiveInt(process.env.BOOKING_CONFIRM_INTERVAL_MS, 60_000);
  return setInterval(
    () => void sweepBookingConfirmations().catch((err) => console.error("booking confirmations:", err)),
    interval,
  );
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
