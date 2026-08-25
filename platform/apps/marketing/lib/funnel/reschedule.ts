import { createHash } from "node:crypto";
import { query } from "./db";

/**
 * Honouring a reschedule link. SERVER ONLY.
 *
 * The worker mints these (apps/worker/src/pipeline/reschedule-tokens.ts) and
 * puts them in the booking confirmation and every pre-call reminder. This is
 * the read side: the token arrives in a URL, and this decides whether it opens
 * anything.
 *
 * Deliberately the same shape as ./resume.ts, because it is the same kind of
 * object under the same rules — the differences between two near-identical
 * security paths are where the bugs live.
 *
 * ── THE WEBSITE CANNOT MINT ONE ────────────────────────────────────────────
 *
 * Migration 0053 grants `aura_marketing` SELECT and `UPDATE (used_at)` on the
 * token table. No INSERT, deliberately: this app serves unauthenticated public
 * traffic, and a public server that can create reschedule tokens can create a
 * working handle on anybody's appointment.
 *
 * ── FOUR WAYS A TOKEN IS REFUSED ───────────────────────────────────────────
 *
 * Unknown, expired, the booking is no longer held, or the enquirer has been
 * erased. The third is the one that does real work: a token stays valid for
 * days, and in that window the call can be cancelled, rejected, or already
 * moved — and once moved, the OLD slot is `open` again, so the old link stops
 * resolving without anybody having to revoke it.
 *
 * Every refusal returns the same thing, for the reason ./resume.ts gives: a
 * caller able to tell "expired" from "no such token" would eventually surface
 * the difference, and that difference tells a stranger holding a guessed token
 * whether they guessed a real one.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/funnel/reschedule is server-only");
}

export interface RescheduleTarget {
  bookingSlotId: string;
  submissionId: string;
  name: string;
  /** e.g. "Tue, 12 Aug" — what they are moving away from. */
  dayLabel: string;
  /** e.g. "18:30" */
  timeLabel: string;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Resolve a raw token to the booking it can move, or null. */
export async function resolveRescheduleToken(
  raw: string,
  timeZone: string,
): Promise<RescheduleTarget | null> {
  // Bound the input before it becomes a hash. 32 random bytes is 43 base64url
  // characters; anything wildly longer is someone probing, and there is no
  // reason to hash a megabyte of it.
  if (typeof raw !== "string" || raw.length < 20 || raw.length > 200) return null;

  const rows = await query<{
    booking_slot_id: string;
    submission_id: string | null;
    name: string | null;
    status: string;
    day_label: string;
    time_label: string;
  }>(
    `SELECT t.booking_slot_id,
            b.submission_id,
            b.status,
            s.name,
            to_char(b.starts_at AT TIME ZONE $2, 'Dy, DD Mon') AS day_label,
            to_char(b.starts_at AT TIME ZONE $2, 'HH24:MI')    AS time_label
       FROM marketing.reschedule_tokens t
       JOIN marketing.booking_slots b ON b.id = t.booking_slot_id
       -- LEFT, so an erased enquirer is caught by the explicit check below
       -- rather than by the row silently not matching. The two look the same
       -- from outside, but only one of them is a state we understand.
       LEFT JOIN marketing.funnel_submissions s ON s.id = b.submission_id
      WHERE t.token_hash = $1
        AND t.expires_at > now()`,
    [hashToken(raw), timeZone],
  );

  const row = rows[0];
  if (!row) return null;

  // The booking is no longer held. Cancelled by an operator, released by a
  // rejection, or already moved — in which case this slot is 'open' again and
  // somebody else may hold it now. Nothing here to reschedule.
  if (row.status !== "booked") return null;

  // Erased under a DPDP request. `submission_id` is ON DELETE SET NULL, so the
  // hour still stands in the operator's diary but there is no longer a person
  // attached to it, and re-attaching one from a link would recreate a record we
  // were asked to delete.
  if (!row.submission_id) return null;

  return {
    bookingSlotId: row.booking_slot_id,
    submissionId: row.submission_id,
    name: row.name ?? "",
    dayLabel: row.day_label,
    timeLabel: row.time_label,
  };
}

/**
 * Record that a link was opened. Best-effort, telemetry only.
 *
 * NOT single-use enforcement — see ./resume.ts. Somebody who opens the link,
 * looks at the times and comes back an hour later must still be able to move
 * their call. COALESCE keeps the FIRST open, which is the interesting one.
 */
export async function markRescheduleTokenUsed(raw: string): Promise<void> {
  try {
    await query(
      `UPDATE marketing.reschedule_tokens
          SET used_at = COALESCE(used_at, now())
        WHERE token_hash = $1`,
      [hashToken(raw)],
    );
  } catch (err) {
    console.error("[reschedule] could not stamp used_at:", (err as Error).message);
  }
}
