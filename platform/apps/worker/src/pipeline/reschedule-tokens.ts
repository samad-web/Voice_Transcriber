import { createHash, randomBytes } from "node:crypto";
import { getAdminPool } from "@aura/db";
import { funnelSiteUrl } from "./resume-tokens";

/**
 * Minting the link that lets somebody move their own booked call.
 *
 * Deliberately the same shape as `resume-tokens.ts`, because it is the same
 * kind of object and the differences would be the bugs:
 *
 *   · 32 bytes from a CSPRNG, base64url. Not a uuid - uuids identify rows, and
 *     a recognisable shape invites guessing at the rest of the table.
 *   · Only sha256 of it is stored, so a dump of `reschedule_tokens` is not a
 *     set of working handles on other people's appointments.
 *   · It expires, and the marketing app refuses it once the booking it points
 *     at is no longer live - so the window in which a leaked link is useful is
 *     bounded from both ends.
 *   · The WORKER mints it. Migration 0053 gives `aura_marketing` SELECT and
 *     `UPDATE (used_at)` and nothing else; an internet-facing server that can
 *     INSERT here is one that can mint a working link into anybody's booking.
 *
 * ── KEYED ON THE BOOKING, NOT THE PERSON ───────────────────────────────────
 *
 * A resume token points at a submission because the thing it resumes is the
 * enquiry. This points at a `booking_slots` row because the thing it moves is
 * that specific reservation - and once the move happens, the old row is
 * released and the token stops resolving to anything live, which is exactly the
 * revocation you want without a separate revoke step.
 */

/**
 * How long a reschedule link stays usable.
 *
 * Longer than it sounds like it needs to be. The 24-hour reminder carries one,
 * and somebody who reads that message, moves the call a week out, and then
 * wants to move it again is following the link from the NEW booking's own
 * reminder - a fresh token. Seven days covers the realistic "I saw this
 * yesterday and am acting on it now" case without leaving bearer credentials
 * alive for a month.
 */
const TTL_DAYS = positiveInt(process.env.FUNNEL_RESCHEDULE_TTL_DAYS, 7);

export function hashRescheduleToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Mint a token for this booking and return the full link, or null.
 *
 * Null when there is no site URL to build against - a link reading
 * `undefined/reschedule/…` is worse than no link, because the second is visible
 * in the outbox and the first is only visible on somebody's phone. Every
 * template that uses `{{reschedule_link}}` treats it as OPTIONAL, so a null
 * here drops the offer to reschedule and still sends the reminder.
 *
 * A NEW token every call, deliberately. Only the hash is stored, so the 24-hour
 * reminder's raw token cannot be recovered to reuse in the 1-hour one. Both
 * stay valid until they expire, which is harmless: they are two links to the
 * same booking.
 */
export async function mintRescheduleLink(bookingSlotId: string): Promise<string | null> {
  const site = funnelSiteUrl();
  if (!site) {
    console.error(
      "[reschedule-tokens] neither FUNNEL_SITE_URL nor SITE_DOMAIN is set, " +
        "cannot build a reschedule link",
    );
    return null;
  }

  const raw = randomBytes(32).toString("base64url");

  await getAdminPool().query(
    `INSERT INTO marketing.reschedule_tokens (token_hash, booking_slot_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashRescheduleToken(raw), bookingSlotId, TTL_DAYS],
  );

  return `${site}/reschedule/${raw}`;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
