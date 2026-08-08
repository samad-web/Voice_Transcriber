import { cookies } from "next/headers";

import { signPayload, verifyPayload } from "./signing";

/**
 * The step-1 → step-2 handoff. SERVER ONLY.
 *
 * Step 1 writes a `funnel_submissions` row and needs step 2 to update THAT row.
 * The obvious implementation — a hidden input carrying the uuid — is a
 * broken-access-control bug on a public form: anyone can post any uuid and
 * overwrite a stranger's enquiry, and uuids leak through screenshots, browser
 * history and shared devices.
 *
 * So the id never reaches the DOM. It lives in a signed, httpOnly cookie that
 * only this server can mint and only this server can read.
 */

const COOKIE = "aura_funnel_sid";

/**
 * Two hours. Long enough that someone can take a phone call in the middle of the
 * form and come back; short enough that a shared or public machine does not
 * leave a writable handle on someone else's submission open all day.
 */
const TTL_MS = 2 * 60 * 60 * 1000;

export interface FunnelSession {
  /** funnel_submissions.id */
  sid: string;
  /**
   * funnel_contact_history.id — THIS FILL's history row.
   *
   * Carried alongside the submission id because a returning enquirer's
   * submission row is shared across every fill they have ever made, so "the
   * latest history row for this submission" is not a safe way for step 2 to find
   * the row step 1 just created: two people filling the form from the same
   * office on the same shared number would race for it.
   */
  hid: string;
  /** issued-at, epoch ms */
  iat: number;
}

export async function setFunnelSession(submissionId: string, historyId: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, signPayload({ sid: submissionId, hid: historyId, iat: Date.now() }), {
    httpOnly: true,
    // Signed AND httpOnly AND SameSite=Lax. The signature stops forgery, but a
    // cross-site POST carrying a legitimately-issued cookie is a different
    // attack, and Lax is what stops it. Next's Server Actions add their own
    // origin check on top; this does not depend on that.
    sameSite: "lax",
    // In development this app is served over http://localhost:3200, and a
    // `secure` cookie is silently dropped there — the form would appear to lose
    // its session between steps with no error anywhere.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

/**
 * The submission id for this browser, or null.
 *
 * Expiry is enforced against `iat` as well as `maxAge`: `maxAge` is a request
 * the browser may ignore, and a cookie replayed from a saved profile would
 * otherwise be honoured indefinitely.
 */
export async function getFunnelSession(): Promise<FunnelSession | null> {
  const jar = await cookies();
  const payload = verifyPayload<FunnelSession>(jar.get(COOKIE)?.value);
  if (!payload || typeof payload.iat !== "number") return null;
  if (Date.now() - payload.iat > TTL_MS) return null;
  // Shape check on both ids. They travel into parameterised queries, so this is
  // not an injection defence — it is what stops a malformed value turning into a
  // Postgres `invalid input syntax for type uuid`, which is a 500 rather than
  // the "your session expired" the respondent should see.
  if (!isUuid(payload.sid) || !isUuid(payload.hid)) return null;
  return payload;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/**
 * Clear it. Called after step 2 completes, so a shared browser does not leave
 * the previous person's submission writable by the next one.
 */
export async function clearFunnelSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
