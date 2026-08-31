import { getAdminPool } from "@aura/db";
import {
  FUNNEL_ENQUIRY_RETENTION_DAYS,
  FUNNEL_ENQUIRY_RETENTION_FLOOR_DAYS,
} from "@aura/shared";

/**
 * Deleting enquiries once we said we would.
 *
 * The published privacy policy (§5) states a retention period for the marketing
 * funnel. This is what makes that sentence true. Until it existed the marketing
 * database had no expiry at all, and a stated period that nothing enforces is a
 * worse position than stating none - it is a disclosure you are visibly not
 * honouring, which is the version a regulator finds interesting.
 *
 * The number is NOT configurable by environment variable, on purpose. It is
 * published on a public page as a commitment; letting a deployment quietly run
 * a different one would recreate exactly the mismatch this job exists to close.
 * It comes from @aura/shared, which the marketing page reads too.
 *
 * ── WHAT IT DELETES, AND WHAT SURVIVES ─────────────────────────────────────
 *
 * DELETE on `marketing.funnel_submissions` cascades to `funnel_contact_history`
 * and `funnel_followups` (both ON DELETE CASCADE). `booking_slots.submission_id`
 * is ON DELETE SET NULL rather than cascade, deliberately: erasing a person must
 * not delete the operator's calendar out from under them.
 *
 * That leaves a trap, and step 2 below exists for it. `booking_slots.booked_name`
 * is plain text and SET NULL does not touch it, so a deleted enquirer's NAME
 * would sit in the calendar indefinitely. Deleting the submission while keeping
 * the name is not retention, it is the appearance of retention. The scrub also
 * catches slots orphaned by a DPDP erasure request, which had the same gap.
 *
 * ── WHAT IS EXEMPT ─────────────────────────────────────────────────────────
 *
 * Enquiries that became customers (`converted_org_id IS NOT NULL`). The privacy
 * policy says so in the same paragraph: once you are a customer the enquiry
 * forms part of the contractual record and is kept with the account. Sweeping it
 * up would delete the provenance of a live commercial relationship.
 */

/**
 * Ceiling per sweep.
 *
 * A cap on how wrong this can go in one tick. The steady state deletes a
 * handful a day; anything near this number means either a long backlog on first
 * run or a bug, and both are worth a human seeing before the rest goes. Hitting
 * it is logged loudly and the remainder simply goes on the next tick.
 */
const BATCH = 500;

export function retentionDays(): number {
  return FUNNEL_ENQUIRY_RETENTION_DAYS;
}

/**
 * Delete expired enquiries. Returns what it removed.
 *
 * Not wrapped in an explicit transaction: each statement is atomic on its own,
 * the second is idempotent, and a crash between them leaves orphaned names that
 * the next tick scrubs anyway. A transaction here would hold locks on the
 * calendar table for the duration of a bulk delete for no gain.
 */
export async function sweepExpiredEnquiries(
  limit = BATCH,
): Promise<{ deleted: number; namesScrubbed: number }> {
  const days = retentionDays();

  // The floor check is inside the function, not just at startup, so a direct
  // call from a script or a test cannot bypass it either.
  if (!Number.isInteger(days) || days < FUNNEL_ENQUIRY_RETENTION_FLOOR_DAYS) {
    throw new Error(
      `funnel retention: refusing to run with ${days} days - the floor is ` +
        `${FUNNEL_ENQUIRY_RETENTION_FLOOR_DAYS}. This deletes real enquiries and is not reversible.`,
    );
  }

  const pool = getAdminPool();

  const { rows: deleted } = await pool.query<{ id: string }>(
    `DELETE FROM marketing.funnel_submissions
      WHERE id IN (
        SELECT id FROM marketing.funnel_submissions
         WHERE created_at < now() - make_interval(days => $1)
           AND converted_org_id IS NULL
         ORDER BY created_at
         LIMIT $2
      )
      RETURNING id`,
    [days, limit],
  );

  // Step 2 - see the header. Runs unconditionally, not only when step 1 deleted
  // something, because it is also the repair for slots orphaned by an erasure.
  const { rowCount: scrubbed } = await pool.query(
    `UPDATE marketing.booking_slots
        SET booked_name = NULL
      WHERE submission_id IS NULL
        AND booked_name IS NOT NULL`,
  );

  const namesScrubbed = scrubbed ?? 0;

  if (deleted.length > 0 || namesScrubbed > 0) {
    console.log(
      `funnel retention: deleted ${deleted.length} enquiry(ies) older than ${days}d, ` +
        `scrubbed ${namesScrubbed} orphaned booking name(s)`,
    );
  }
  if (deleted.length >= limit) {
    console.warn(
      `funnel retention: hit the ${limit}-row cap. More remain and will go on the next sweep. ` +
        `If this repeats, check that the retention period is what you intended.`,
    );
  }

  return { deleted: deleted.length, namesScrubbed };
}

/**
 * Daily. Retention is measured in a year; anything tighter is a query that
 * finds nothing, run repeatedly.
 *
 * No enable flag, unlike the reminder sweep. That one sends messages to people
 * who did not ask for them and should be a deliberate act; this one honours a
 * published commitment, and defaulting it OFF would mean the promise is unkept
 * in exactly the deployments nobody has configured - which is all of them.
 */
export function startFunnelRetentionSweep(): NodeJS.Timeout | null {
  const days = retentionDays();
  if (!Number.isInteger(days) || days < FUNNEL_ENQUIRY_RETENTION_FLOOR_DAYS) {
    console.error(
      `funnel retention: DISABLED - ${days} days is below the ${FUNNEL_ENQUIRY_RETENTION_FLOOR_DAYS}-day floor. ` +
        `Fix FUNNEL_ENQUIRY_RETENTION_DAYS in @aura/shared.`,
    );
    return null;
  }

  console.log(`funnel retention: ON - enquiries deleted after ${days} days`);

  // First pass shortly after boot rather than a full day later, so a fresh
  // deployment does not sit for 24 hours with expired data it has promised to
  // have deleted. Delayed a minute so it does not compete with startup.
  setTimeout(() => {
    void sweepExpiredEnquiries().catch((err) => console.error("funnel retention:", err));
  }, 60_000).unref?.();

  return setInterval(
    () => void sweepExpiredEnquiries().catch((err) => console.error("funnel retention:", err)),
    24 * 60 * 60 * 1000,
  );
}
