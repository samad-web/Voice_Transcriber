import { getAdminPool } from "@aura/db";
import { enqueueFollowUp } from "./funnel-followup-outbox";

/**
 * The follow-up reminder: one nudge to an enquirer who went quiet.
 *
 * This is the job the `reminder_followup` template was written for. It finds
 * enquiries that are still open and have not booked anything, and queues a
 * single WhatsApp message. The outbox does the sending.
 *
 * ── OFF BY DEFAULT, AND IT STAYS THAT WAY UNTIL SOMEBODY DECIDES ───────────
 *
 * Every other message this platform sends is provoked by a human: an operator
 * presses Reject, a visitor submits a form. This one is not - it messages
 * people who did nothing, on a timer, from an unofficial WhatsApp account. That
 * is close enough to unsolicited marketing that switching it on has to be a
 * deliberate act, so it requires FUNNEL_REMINDERS_ENABLED=true and does nothing
 * at all without it.
 *
 * ── THE BACKLOG GUARD IS THE IMPORTANT PART ────────────────────────────────
 *
 * The obvious query - "open, no booking, older than three days" - matches every
 * enquiry ever received the first time it runs. Switching this on would send a
 * "just following up" message to people who enquired six months ago and have
 * long since forgotten, dozens at once, from an account that gets banned for
 * exactly that pattern.
 *
 * So there are two bounds, not one: a submission must be older than
 * FUNNEL_REMINDER_AFTER_DAYS *and younger than* FUNNEL_REMINDER_MAX_AGE_DAYS.
 * Anything outside that window is never reminded. Turning the feature on
 * therefore affects the last few days of enquiries, not the entire history.
 */

const AFTER_DAYS = positiveInt(process.env.FUNNEL_REMINDER_AFTER_DAYS, 3);

/**
 * The far edge of the window. Must exceed AFTER_DAYS or nothing ever matches -
 * checked at startup rather than discovered as silence.
 */
const MAX_AGE_DAYS = positiveInt(process.env.FUNNEL_REMINDER_MAX_AGE_DAYS, 14);

/** How many to queue per sweep. A cap on the blast radius of a bad query. */
const BATCH = positiveInt(process.env.FUNNEL_REMINDER_BATCH, 25);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function remindersEnabled(): boolean {
  return process.env.FUNNEL_REMINDERS_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * Queue reminders for everyone due one. Returns how many were queued.
 *
 * Idempotency comes from the outbox's unique index on
 * (submission_id, template, channel) rather than from a flag on the submission:
 * `enqueueFollowUp` uses ON CONFLICT DO NOTHING, so a person can only ever have
 * one `reminder_followup` row. There is no state to keep in sync and no way for
 * a crash between "sent" and "marked" to produce a second message.
 */
export async function sweepFunnelReminders(limit = BATCH): Promise<number> {
  if (!remindersEnabled()) return 0;

  const pool = getAdminPool();

  const { rows } = await pool.query<{ id: string }>(
    `SELECT s.id
       FROM marketing.funnel_submissions s
      WHERE s.status IN ('contact_captured', 'qualified')
        -- Never nudge someone the funnel or a human already said no to, and
        -- never nudge a customer. 'disqualified' and 'rejected' are excluded by
        -- the status filter above; these two cover the rest.
        AND s.converted_org_id IS NULL
        AND s.rejected_at IS NULL
        -- The window. Older than one bound, younger than the other.
        AND s.created_at < now() - make_interval(days => $1)
        AND s.created_at > now() - make_interval(days => $2)
        -- Somewhere to send it. Queuing without a number would dead-letter
        -- after six attempts and read as a delivery failure rather than as
        -- missing data.
        AND COALESCE(s.whatsapp_e164, s.phone_e164) IS NOT NULL
        -- Booked already: they did the thing the reminder asks for.
        AND NOT EXISTS (
              SELECT 1 FROM marketing.booking_slots b
               WHERE b.submission_id = s.id
            )
        -- Reminded already, on any channel. Belt to the unique index's braces,
        -- and it keeps the batch from being filled with rows that would all be
        -- discarded by ON CONFLICT.
        AND NOT EXISTS (
              SELECT 1 FROM marketing.funnel_followups f
               WHERE f.submission_id = s.id
                 AND f.template = 'reminder_followup'
            )
      ORDER BY s.created_at
      LIMIT $3`,
    [AFTER_DAYS, MAX_AGE_DAYS, limit],
  );

  let queued = 0;
  for (const row of rows) {
    await enqueueFollowUp(pool, row.id, "reminder_followup", "whatsapp");
    queued++;
  }

  if (queued > 0) {
    console.log(`funnel reminders: queued ${queued} reminder(s)`);
  }
  return queued;
}

/**
 * Hourly, not by the minute.
 *
 * The window is measured in days, so a tighter loop cannot make a reminder
 * arrive meaningfully sooner - it would only re-run the same query sixty times
 * to find the same nothing.
 */
export function startFunnelReminderSweep(): NodeJS.Timeout | null {
  if (!remindersEnabled()) {
    console.log(
      "funnel reminders: OFF (set FUNNEL_REMINDERS_ENABLED=true to send follow-up nudges)",
    );
    return null;
  }

  if (MAX_AGE_DAYS <= AFTER_DAYS) {
    // Refuse rather than run: this configuration matches nothing, and a feature
    // that is switched on and silently does nothing is worse than one that is
    // off, because nobody goes looking for it.
    console.error(
      `funnel reminders: DISABLED - FUNNEL_REMINDER_MAX_AGE_DAYS (${MAX_AGE_DAYS}) must be ` +
        `greater than FUNNEL_REMINDER_AFTER_DAYS (${AFTER_DAYS}), or no enquiry can ever match.`,
    );
    return null;
  }

  console.log(
    `funnel reminders: ON - nudging open enquiries between ${AFTER_DAYS} and ${MAX_AGE_DAYS} ` +
      `days old, up to ${BATCH} per hour`,
  );

  const interval = positiveInt(process.env.FUNNEL_REMINDER_INTERVAL_MS, 3_600_000);
  return setInterval(
    () => void sweepFunnelReminders().catch((err) => console.error("funnel reminders:", err)),
    interval,
  );
}
