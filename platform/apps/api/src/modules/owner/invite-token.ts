import { createHash, randomBytes } from "node:crypto";
import { consoleBaseUrl } from "../../common/console-redirect";

/**
 * The invite link's token, and everything that decides whether one still works
 * (migration 0137).
 *
 * Pure on purpose: every rule that can let a stranger into a workspace is in
 * this file and tested without a database (invite-token.spec.ts).
 */

/** How long an invite lasts unless the owner picks otherwise. */
export const INVITE_TTL_DEFAULT_HOURS = 72;
/** Bounds on the owner's choice. A week is long enough for a holiday. */
export const INVITE_TTL_MIN_HOURS = 1;
export const INVITE_TTL_MAX_HOURS = 168;

/**
 * 32 random bytes, base64url - 256 bits, 43 characters. Long enough that
 * guessing is not a thing anybody needs to rate-limit.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The only form of the token the database ever sees. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Shape check before any lookup. Anything else is refused without touching the
 * database - a malformed token cannot match, so there is nothing to look up.
 */
export function isWellFormedInviteToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export type InviteStatus = "pending" | "expired" | "accepted" | "revoked";

/**
 * Accepted and revoked outrank expired: an invite that was used and has since
 * aged out is "already used", which is the more useful thing to tell somebody
 * clicking it twice.
 */
export function inviteStatus(
  row: { accepted_at: Date | string | null; revoked_at: Date | string | null; expires_at: Date | string },
  now: Date = new Date(),
): InviteStatus {
  if (row.accepted_at) return "accepted";
  if (row.revoked_at) return "revoked";
  return new Date(row.expires_at).getTime() <= now.getTime() ? "expired" : "pending";
}

/** Clamp the owner's requested lifetime; absent or junk means the default. */
export function inviteTtlHours(requested: number | null | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) return INVITE_TTL_DEFAULT_HOURS;
  return Math.min(INVITE_TTL_MAX_HOURS, Math.max(INVITE_TTL_MIN_HOURS, Math.round(requested)));
}

/**
 * `${PUBLIC_APP_URL}/invite/<token>`.
 *
 * Built from configuration, NEVER from the request. An invite link is mailed
 * to somebody who trusts it because it came from their employer; building it
 * from a Host header would let anyone who can reach the API with a forged
 * header mint a real invite that points at their own server (classic
 * password-reset poisoning). Same base `console-redirect.ts` uses for OAuth.
 */
export function inviteLink(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${consoleBaseUrl(env)}/invite/${encodeURIComponent(token)}`;
}

/** Case- and whitespace-insensitive, the way GoTrue itself compares addresses. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `a***@example.com` - for the refusal shown to somebody who signed in with
 * the wrong Google account. Enough for the right person to recognise which
 * address to use; not the address itself, since the person reading it is by
 * definition not (yet) proven to be its owner.
 */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}
