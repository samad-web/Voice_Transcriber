import { cookies } from "next/headers";

import { signPayload, verifyPayload } from "./signing";

/**
 * The token → picker handoff for a reschedule. SERVER ONLY.
 *
 * `/reschedule/<token>` verifies the token and needs `/reschedule` to know
 * which booking is being moved. The obvious implementation - the slot id in the
 * URL or a hidden input - is a broken-access-control bug on a public page:
 * anyone could post any slot id and release a stranger's appointment.
 *
 * So the ids never reach the DOM. They live in a signed, httpOnly cookie that
 * only this server can mint and only this server can read - the same design
 * ./session.ts uses for the step-1 → step-2 handoff, reusing the same HMAC
 * primitives rather than growing a second one.
 *
 * ── WHY NOT REUSE `aura_funnel_sid` ────────────────────────────────────────
 *
 * It carries `hid`, a contact-history row, which is meaningless here; it does
 * not carry a booking id, which is the whole point; and it lives for 24 hours
 * to cover somebody finishing a form tomorrow. A reschedule is one sitting -
 * open the link, look at the times, pick one - so it gets a short life of its
 * own rather than borrowing a long one. Two purposes, two cookies, neither able
 * to be mistaken for the other.
 */

const COOKIE = "aura_reschedule_sid";

/**
 * One hour.
 *
 * Long enough to be interrupted mid-decision and come back; short enough that a
 * shared or public machine does not leave a stranger's appointment movable for
 * the rest of the day. Unlike the funnel session there is nothing to type here,
 * so the "I'll finish this tomorrow" case that forced that one to 24 hours does
 * not arise - and if it does, the link itself still works and mints a new
 * cookie.
 */
const TTL_MS = 60 * 60 * 1000;

export interface RescheduleSession {
  /** booking_slots.id - the booking being moved. */
  bid: string;
  /** funnel_submissions.id - who it belongs to. The authorisation check. */
  sid: string;
  /** issued-at, epoch ms */
  iat: number;
}

export async function setRescheduleSession(
  bookingSlotId: string,
  submissionId: string,
): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, signPayload({ bid: bookingSlotId, sid: submissionId, iat: Date.now() }), {
    httpOnly: true,
    // Signed AND httpOnly AND SameSite=Lax. The signature stops forgery, but a
    // cross-site POST carrying a legitimately-issued cookie is a different
    // attack, and Lax is what stops it.
    sameSite: "lax",
    // A `secure` cookie is silently dropped over http://localhost, and the
    // page would appear to lose its session with no error anywhere.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

/**
 * The booking this browser may move, or null.
 *
 * Expiry is enforced against `iat` as well as `maxAge`: `maxAge` is a request
 * the browser may ignore, and a cookie replayed from a saved profile would
 * otherwise be honoured indefinitely.
 */
export async function getRescheduleSession(): Promise<RescheduleSession | null> {
  const jar = await cookies();
  const payload = verifyPayload<RescheduleSession>(jar.get(COOKIE)?.value);
  if (!payload || typeof payload.iat !== "number") return null;
  if (Date.now() - payload.iat > TTL_MS) return null;
  // Shape check on both ids. They travel into parameterised queries, so this is
  // not an injection defence - it is what stops a malformed value turning into
  // a Postgres `invalid input syntax for type uuid`, which is a 500 rather than
  // the "this link has expired" the visitor should see.
  if (!isUuid(payload.bid) || !isUuid(payload.sid)) return null;
  return payload;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** Clear it once the move lands, so a shared browser does not leave the
 *  previous person's appointment movable by the next one. */
export async function clearRescheduleSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
