import { z } from "zod";

/**
 * The call-access gate (migration 0122).
 *
 * A platform operator reaching a gated org's call content needs a live grant
 * from that org's own administrator, bounded by a start and an end. This file
 * is the shape of that request and the one function that decides whether a
 * grant is live - shared so the API guard, the operator console and the owner
 * console cannot each invent their own answer.
 *
 * Nothing here is the enforcement. The enforcement is `CallAccessGuard` on the
 * API and the CHECK constraints in 0122; these are the types they agree on.
 */

export const CallAccessStatus = z.enum(["pending", "approved", "denied", "revoked"]);
export type CallAccessStatus = z.infer<typeof CallAccessStatus>;

export const CallAccessDecidedVia = z.enum(["console", "otp"]);
export type CallAccessDecidedVia = z.infer<typeof CallAccessDecidedVia>;

/**
 * The ceiling 0122's `call_access_window_is_bounded` enforces, restated so the
 * console can refuse a bad window before the database has to.
 *
 * Thirty days is not a round number chosen for looks: it is short enough that
 * an approval made once cannot still be live a season later, and long enough
 * that a genuine migration or investigation does not need re-approving weekly.
 * A tenant that wants standing access turns the gate off, which is an honest
 * statement, rather than holding a grant that pretends to expire.
 */
export const CALL_ACCESS_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a one-time code stays usable. Short: it is read aloud, not stored. */
export const CALL_ACCESS_OTP_TTL_MS = 10 * 60 * 1000;

/**
 * How many wrong codes a request tolerates before the code is dead.
 *
 * Six digits is ~20 bits, so the cap - not the length - is what makes guessing
 * hopeless. Burning the code rather than locking the request means the
 * administrator can simply send a new one; a lockout that needed support to
 * clear would make the safe path the annoying one.
 */
export const CALL_ACCESS_OTP_MAX_ATTEMPTS = 5;

const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime())
  .describe("ISO-8601 instant");

/**
 * What an operator asks for.
 *
 * The reason is REQUIRED and not defaulted. "Somebody at the vendor wants to
 * listen to your calls" is not a question a person can answer well, and a
 * blank reason would make every request identical to every other one.
 */
export const CallAccessRequestInput = z.object({
  reason: z.string().trim().min(1).max(500),
  /** Proposed window. The administrator may narrow or move it before granting. */
  requestedStart: isoDateTime,
  requestedEnd: isoDateTime,
});
export type CallAccessRequestInput = z.infer<typeof CallAccessRequestInput>;

/**
 * The administrator's approval.
 *
 * Start and end are BOTH required, with no `.default()` on either. A default
 * here would be the partial/default trap wearing a security hat: a PATCH that
 * omitted the end would silently receive one, and the field that decides how
 * long the vendor can hear your calls must never be filled in on your behalf.
 */
export const CallAccessApprovalInput = z.object({
  grantedStart: isoDateTime,
  grantedEnd: isoDateTime,
});
export type CallAccessApprovalInput = z.infer<typeof CallAccessApprovalInput>;

/** Redeeming a code the administrator read off their phone. */
export const CallAccessOtpInput = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, "a six-digit code"),
});
export type CallAccessOtpInput = z.infer<typeof CallAccessOtpInput>;

export interface CallAccessWindow {
  status: CallAccessStatus;
  grantedStart: Date | string | null;
  grantedEnd: Date | string | null;
}

/**
 * Is this grant live at `now`?
 *
 * The single definition, used by the guard and by both consoles. Three ways to
 * be not-live and they are deliberately not collapsed into one boolean
 * elsewhere: not approved, not started yet, and finished. A scheduled window
 * whose start is still in the future is a real state the console has to show -
 * "approved" and "usable" are different words.
 *
 * Fails closed on a malformed or missing bound: a grant we cannot read the end
 * of is not a grant.
 */
export function isCallAccessLive(grant: CallAccessWindow, now: Date = new Date()): boolean {
  if (grant.status !== "approved") return false;
  const start = toTime(grant.grantedStart);
  const end = toTime(grant.grantedEnd);
  if (start === null || end === null) return false;
  const at = now.getTime();
  return at >= start && at < end;
}

/**
 * Why a grant is not usable, for the console to say out loud.
 *
 * `null` means it IS usable. Separate from the boolean above rather than
 * replacing it, because the guard only ever needs yes/no and a guard that had
 * to interpret a string would be one typo away from failing open.
 */
export function callAccessBlockedReason(
  grant: CallAccessWindow | null,
  now: Date = new Date(),
): "none" | "pending" | "denied" | "revoked" | "not_started" | "expired" | null {
  if (!grant) return "none";
  if (grant.status === "pending") return "pending";
  if (grant.status === "denied") return "denied";
  if (grant.status === "revoked") return "revoked";
  const start = toTime(grant.grantedStart);
  const end = toTime(grant.grantedEnd);
  if (start === null || end === null) return "none";
  const at = now.getTime();
  if (at < start) return "not_started";
  if (at >= end) return "expired";
  return null;
}

/**
 * Is this window acceptable to grant?
 *
 * Mirrors 0122's CHECKs so the console can refuse before the database does -
 * a 500 from a constraint violation is a worse answer than a sentence. The
 * database stays the authority; this is the courtesy copy, and
 * call-access.test.ts pins the two together.
 */
export function validateCallAccessWindow(
  startIso: string,
  endIso: string,
): { ok: true } | { ok: false; message: string } {
  const start = toTime(startIso);
  const end = toTime(endIso);
  if (start === null || end === null) return { ok: false, message: "start and end must be valid times" };
  if (end <= start) return { ok: false, message: "the window must end after it starts" };
  if (end - start > CALL_ACCESS_MAX_WINDOW_MS) {
    return { ok: false, message: "a grant may not run longer than 30 days" };
  }
  return { ok: true };
}

function toTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}
