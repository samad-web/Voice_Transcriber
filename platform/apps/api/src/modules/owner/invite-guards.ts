import { HttpException } from "@nestjs/common";
import { inviteStatus, maskEmail } from "./invite-token";
import type { AuthUser } from "./supabase-admin.service";

/**
 * The refusals an invite can end in, and the two checks every kind of invite
 * shares.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 *
 * These were private methods on `InvitesService`, which is tenant-scoped in its
 * bones - every read in it goes through `db.withOrg(orgId, ...)`. Doc 34 Part C
 * adds a second kind of invite that has no org at all (a superadmin belongs to no
 * organization), and it must answer "may this Google account accept this link?"
 * with exactly the same rules. Two copies of that answer is the last thing an
 * authorization check should have, so it moved here rather than being
 * reimplemented.
 *
 * Each function takes the narrowest row shape it actually reads, so neither
 * invite table's full type has to be known here.
 */

export type InviteRefusal =
  | "invalid"
  | "expired"
  | "accepted"
  | "revoked"
  | "not_signed_in"
  | "unverified_email"
  | "not_google"
  | "email_mismatch"
  | "unlinked_login"
  | "other_login"
  | "not_configured";

export function refuse(
  status: number,
  code: InviteRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new HttpException({ code, message, ...extra }, status);
}

/** The lifecycle columns every invite table carries. */
export interface InviteLifecycle {
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

export function assertInvitePending(row: InviteLifecycle): void {
  const status = inviteStatus(row);
  if (status === "expired")
    refuse(410, "expired", "This invite has expired. Ask whoever invited you to send a new one.");
  if (status === "accepted")
    refuse(410, "accepted", "This invite has already been used. Sign in instead.");
  if (status === "revoked")
    refuse(410, "revoked", "This invite was withdrawn. Ask whoever invited you for a new one.");
}

/**
 * May this Google session accept this invite?
 *
 * Holding the token is necessary and NOT sufficient. The three checks are the
 * whole of what makes a link safe to mail: the address has to be one Google has
 * proven, the session has to have come through Google rather than a password
 * somebody chose, and it has to be the address the invite was actually sent to.
 *
 * The mismatch message masks the invited address. It is shown to whoever holds
 * the link, who is not necessarily the person it was meant for - so it must say
 * enough to fix an honest mistake without disclosing a colleague's full address
 * to someone who merely found the URL.
 */
export function assertMayAcceptInvite(invite: { email: string }, user: AuthUser): void {
  if (!user.emailVerified || !user.email) {
    refuse(403, "unverified_email", "Google didn't confirm an email address for that account.");
  }
  if (!user.providers.includes("google")) {
    refuse(403, "not_google", "Finish accepting this invite by continuing with Google.");
  }
  if (user.email !== invite.email) {
    refuse(
      403,
      "email_mismatch",
      `This invite is for ${maskEmail(invite.email)}. Continue with the Google account for that address.`,
      { invitedEmail: maskEmail(invite.email) },
    );
  }
}
