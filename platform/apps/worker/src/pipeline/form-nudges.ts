import { getAdminPool } from "@aura/db";
import { enqueueFollowUp } from "./funnel-followup-outbox";

/**
 * Nudging people who gave their details and never answered the questions.
 *
 * `status = 'contact_captured'` is exactly that state: step 1 wrote the row,
 * step 2 never came back. Nothing has ever contacted these people.
 *
 * ── TWO NUDGES, AS TWO TEMPLATES ───────────────────────────────────────────
 *
 * The outbox's unique key is (submission_id, template, channel), and that is
 * what makes "never message the same person twice for the same thing" a
 * database guarantee rather than a promise in application code. A second nudge
 * is therefore a second template rather than a counter - which also lets the
 * operator word the follow-up differently and switch either one off alone.
 *
 * Nobody ever gets a third. There is no template for one.
 *
 * ── WHY THE SECOND IS TIMED FROM THE ENQUIRY, NOT FROM THE FIRST NUDGE ─────
 *
 * Both delays are measured from `created_at`. Timing the second from when the
 * first was actually SENT would couple it to outbox latency and to however long
 * the worker happened to be down - a two-day gap could silently become five.
 * From the enquiry, the schedule is what it says it is.
 */

const FIRST_AFTER_MINUTES = positiveInt(process.env.FUNNEL_NUDGE_FIRST_MINUTES, 120);
const SECOND_AFTER_MINUTES = positiveInt(process.env.FUNNEL_NUDGE_SECOND_MINUTES, 2 * 24 * 60);

/**
 * Past this, stop. Somebody who half-filled a form five weeks ago and never
 * came back is not going to be recovered by a message that opens "you started
 * telling us about your business" - they will read it as a company that
 * harvested their number. The outbox has its own 14-day expiry for messages
 * that sat undelivered; this is about not QUEUING an ancient one in the first
 * place, which is a different question with a different answer.
 */
const GIVE_UP_AFTER_DAYS = positiveInt(process.env.FUNNEL_NUDGE_GIVE_UP_DAYS, 30);

const BATCH = 200;

type Stage = { template: "resume_form" | "resume_form_2"; afterMinutes: number };

const STAGES: Stage[] = [
  { template: "resume_form", afterMinutes: FIRST_AFTER_MINUTES },
  { template: "resume_form_2", afterMinutes: SECOND_AFTER_MINUTES },
];

export async function sweepFormNudges(): Promise<number> {
  const pool = getAdminPool();
  let queued = 0;

  for (const stage of STAGES) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT s.id
         FROM marketing.funnel_submissions s
        WHERE s.status = 'contact_captured'
          -- Still unfinished RIGHT NOW. The status is the whole predicate:
          -- step 2 moves it to qualified/disqualified, so a person who came
          -- back on their own is excluded without needing to know they did.
          AND s.created_at <= now() - make_interval(mins => $1)
          AND s.created_at >  now() - make_interval(days => $2)
          -- A number to message. WhatsApp is the only channel with a working
          -- sender; queuing without one dead-letters after six attempts and
          -- reads as a delivery failure rather than as missing data.
          AND COALESCE(s.whatsapp_e164, s.phone_e164) IS NOT NULL
          AND NOT EXISTS (
                SELECT 1
                  FROM marketing.funnel_followups f
                 WHERE f.submission_id = s.id
                   AND f.template = $3
                   AND f.channel  = 'whatsapp'
              )
        LIMIT $4`,
      [stage.afterMinutes, GIVE_UP_AFTER_DAYS, stage.template, BATCH],
    );

    for (const row of rows) {
      try {
        await enqueueFollowUp(pool, row.id, stage.template, "whatsapp");
        queued++;
      } catch (err) {
        // One bad row must not strand the nudges behind it.
        console.error(
          `form nudges: could not queue ${stage.template} for ${row.id}:`,
          (err as Error).message,
        );
      }
    }
  }

  if (queued > 0) console.log(`form nudges: queued ${queued} message(s)`);
  return queued;
}

/**
 * Every 5 minutes.
 *
 * Slower than the booking confirmation's minute, because nothing here is
 * time-critical: the first nudge is two hours out, so five minutes of jitter on
 * it is invisible. It is also a slightly heavier query, run against a table
 * that only grows.
 */
export function startFormNudges(): NodeJS.Timeout {
  const interval = positiveInt(process.env.FUNNEL_NUDGE_INTERVAL_MS, 5 * 60_000);
  return setInterval(
    () => void sweepFormNudges().catch((err) => console.error("form nudges:", err)),
    interval,
  );
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
