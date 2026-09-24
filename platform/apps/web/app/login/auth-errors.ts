/**
 * The sentence for each `?error=` code the Google callback redirects with.
 *
 * Codes travel in the URL, never text: the callback's inputs are a URL anybody
 * can build, so the page must only ever render wording from this table - an
 * unknown code gets the generic line, not an echo of itself.
 */
const MESSAGES: Record<string, string> = {
  google_cancelled: "Google sign-in was cancelled. Nothing was changed.",
  google_failed: "Google sign-in didn't complete. Try again.",
  no_workspace:
    "That Google account isn't linked to any workspace. Ask your administrator for an invite, or sign in with the account they set up for you.",
  unavailable: "The platform didn't answer. Try again in a moment.",
  // Invite refusals - the codes invites.service.ts answers with.
  invalid: "This invite link isn't valid. Check you opened the whole link from the email.",
  expired: "This invite has expired. Ask whoever invited you to send a new one.",
  accepted: "This invite has already been used. Sign in instead.",
  revoked: "This invite was withdrawn. Ask whoever invited you for a new one.",
  not_signed_in: "Your Google sign-in didn't complete. Try again.",
  unverified_email: "Google didn't confirm an email address for that account. Try a different Google account.",
  not_google: "Finish accepting this invite by continuing with Google.",
  email_mismatch:
    "That Google account's address doesn't match this invite. Continue again and choose the Google account for the address the invite was sent to.",
  unlinked_login:
    "This address already has a sign-in that isn't linked to any workspace. Ask your administrator to sort it out before accepting.",
  other_login: "This address already signs in with a different account. Ask your administrator to sort it out.",
  not_configured: "Sign-in isn't configured on this platform yet. Ask your administrator.",
  accept_failed: "The invite couldn't be accepted. Try again, or ask whoever invited you for a new link.",
};

export function authErrorMessage(code: string | undefined | null): string | null {
  if (!code) return null;
  // Own keys only: `?error=constructor` must not find Object.prototype's.
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code]! : "Something went wrong signing you in. Try again.";
}
