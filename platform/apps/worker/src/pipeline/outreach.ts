import { getAdminPool } from "@aura/db";

/**
 * The outreach sweep — what moves a follow-up ladder forward (migration 0058).
 *
 * ── IT DOES NOT SEND. THAT IS THE DESIGN, NOT AN OMISSION ───────────────
 *
 * The schema this is modelled on (B2 Consultants') dispatches a WhatsApp
 * message at each rung on a timer. Aura's third safety rule is that nothing
 * automated can send, so this sweep's entire job is to move a step from
 * 'waiting' to 'due' and stop. A human opens the console, sees what is owed,
 * and acts. There is no dispatcher imported here and no outbox written to —
 * if one ever appears in this file, the rule has been broken.
 *
 * ── SET-BASED, NOT PER-TENANT ───────────────────────────────────────────
 *
 * Every statement below is one UPDATE across every org, on the admin pool,
 * with the tenant boundary expressed as a join rather than a loop — the same
 * shape sweepAutomationTriggers uses. Iterating orgs would be N round trips
 * to do what the database does in one, and the join to `outreach_journeys`
 * keeps a step from ever being touched outside its own journey's org.
 *
 * ── ORDER MATTERS ───────────────────────────────────────────────────────
 *
 * Stop before promote. A journey whose stop condition became true five
 * minutes ago must not have another rung fall due in the same tick — that is
 * exactly the "we kept chasing someone who had already booked" failure the
 * stop condition exists to prevent.
 */

/** How many journeys were stopped, steps made due, and journeys completed. */
export interface OutreachSweepResult {
  stopped: number;
  madeDue: number;
  completed: number;
}

export async function sweepOutreach(): Promise<OutreachSweepResult> {
  const pool = getAdminPool();

  // ── 1. stop journeys whose condition has been met ────────────────────
  //
  // Each condition is evaluated against something that actually exists in
  // this platform, and only counts evidence from AFTER the journey started —
  // a reply from last month is not a reason to stop chasing about this week's
  // enquiry.
  const { rowCount: stopped } = await pool.query(
    `UPDATE outreach_journeys j
        SET status       = 'stopped',
            completed_at = now(),
            stop_reason  = CASE c.stop_on
                             WHEN 'booked'  THEN 'they booked a call'
                             WHEN 'replied' THEN 'they replied'
                             WHEN 'won'     THEN 'the deal was won'
                             ELSE 'stopped'
                           END
       FROM outreach_cadences c
      WHERE c.id = j.cadence_id
        AND j.status = 'active'
        AND c.stop_on <> 'none'
        AND (
          -- Booked: a meeting landed on the contact's timeline. interactions
          -- is the only place a booked call for a CRM contact is recorded --
          -- marketing.booking_slots belongs to the platform's own funnel and
          -- has no join to a tenant's contacts.
          (c.stop_on = 'booked' AND EXISTS (
             SELECT 1 FROM interactions i
              WHERE i.contact_id = j.contact_id
                AND i.type = 'meeting'
                AND i.occurred_at >= j.started_at))
          -- Replied: an inbound message in the inbox (0055).
          OR (c.stop_on = 'replied' AND EXISTS (
             SELECT 1 FROM conversations cv
              WHERE cv.contact_id = j.contact_id
                AND cv.last_inbound_at IS NOT NULL
                AND cv.last_inbound_at >= j.started_at))
          -- Won: any deal for this contact reached a won status.
          OR (c.stop_on = 'won' AND EXISTS (
             SELECT 1 FROM deals d
              WHERE d.contact_id = j.contact_id
                AND d.status = 'won'))
        )`,
  );

  // Everything still owed on a stopped journey is CANCELLED, not skipped.
  // A rep chose to skip; the ladder stopping underneath them was not their
  // decision, and conflating the two would quietly dent their numbers.
  await pool.query(
    `UPDATE outreach_journey_steps s
        SET status = 'cancelled'
       FROM outreach_journeys j
      WHERE s.journey_id = j.id
        AND j.status <> 'active'
        AND s.status IN ('waiting', 'due')`,
  );

  // ── 2. promote what has fallen due ───────────────────────────────────
  const { rowCount: madeDue } = await pool.query(
    `UPDATE outreach_journey_steps s
        SET status = 'due'
       FROM outreach_journeys j
      WHERE s.journey_id = j.id
        AND j.status = 'active'
        AND s.status = 'waiting'
        AND s.due_at <= now()`,
  );

  // ── 3. finish journeys with nothing left to do ───────────────────────
  //
  // 'completed' rather than 'stopped': the ladder ran its course. The
  // distinction is the one a report cares about — "how many did we chase all
  // the way to the end without a reply" is a different number from "how many
  // stopped because it worked".
  const { rowCount: completed } = await pool.query(
    `UPDATE outreach_journeys j
        SET status = 'completed', completed_at = now(),
            stop_reason = COALESCE(j.stop_reason, 'the cadence finished')
      WHERE j.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM outreach_journey_steps s
           WHERE s.journey_id = j.id
             AND s.status IN ('waiting', 'due'))`,
  );

  return {
    stopped: stopped ?? 0,
    madeDue: madeDue ?? 0,
    completed: completed ?? 0,
  };
}

/**
 * Whether migration 0058 has landed.
 *
 * The same tolerance the booking outbox keeps: without it, an environment
 * where the migration has not run throws an undefined-table error on every
 * tick forever, burying real errors. Only the positive answer is cached, so
 * the sweep starts working the moment the migration runs, with no restart.
 */
let tableConfirmed = false;
async function tableReady(): Promise<boolean> {
  if (tableConfirmed) return true;
  const { rows } = await getAdminPool().query<{ exists: string | null }>(
    `SELECT to_regclass('outreach_journeys')::text AS exists`,
  );
  tableConfirmed = Boolean(rows[0]?.exists);
  return tableConfirmed;
}

/** Tests only. */
export function resetOutreachCacheForTests(): void {
  tableConfirmed = false;
}

/** One tick, guarded and logged the way the other sweeps are. */
export async function runOutreachSweep(): Promise<OutreachSweepResult | null> {
  if (!(await tableReady())) return null;
  const result = await sweepOutreach();
  if (result.stopped || result.madeDue || result.completed) {
    console.log(
      `outreach: ${result.madeDue} step(s) due, ${result.stopped} journey(s) stopped, ${result.completed} completed`,
    );
  }
  return result;
}

/**
 * Run the sweep on a timer.
 *
 * `unref()` so a pending tick never holds the process open during shutdown —
 * the same treatment every other sweep in this worker gets.
 */
export function startOutreachSweep(intervalMs = 5 * 60_000): NodeJS.Timeout {
  const tick = (): void => {
    void runOutreachSweep().catch((err: unknown) => {
      // Logged, never thrown: an unhandled rejection here would take the
      // whole worker down and stop the ingest pipeline with it.
      console.error("outreach sweep failed", err);
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}
