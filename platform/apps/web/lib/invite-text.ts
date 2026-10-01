/**
 * What goes on the clipboard when somebody copies an invite link.
 *
 * ── WHY THE LINK ALONE IS NOT ENOUGH ────────────────────────────────────────
 *
 * An invite is bound to ONE email address. The link is copied out of this
 * console and pasted into WhatsApp, and by the time it reaches the person the
 * address it belongs to has been left behind on the screen it was copied from.
 * They then sign in with whichever Google account their browser was already
 * holding - a personal one, an old work one - and the invite refuses them, with
 * no way to tell from the link which address it wanted.
 *
 * So the address travels WITH the link. The sender does not have to remember to
 * type it, and the recipient cannot follow the link without seeing which
 * account to use.
 *
 * Plain text and short, because it is going into a chat message: no markdown
 * (WhatsApp does not render it and the asterisks arrive literally), and the
 * link last so it is the easiest thing to tap.
 */
export function inviteMessage(input: { email: string; link: string; workspace?: string | null }): string {
  const where = input.workspace?.trim() ? `${input.workspace.trim()} on Aura` : "Aura";
  return [
    `You have been invited to ${where}.`,
    "",
    `Sign in with this email: ${input.email}`,
    "The invite only works for that address.",
    "",
    input.link,
  ].join("\n");
}

/**
 * The same thing for a SUPERADMIN invite (0145, doc 34 Part C).
 *
 * Separate from `inviteMessage` for the reason `operatorInviteMailContent` is
 * separate from `inviteMailContent` on the API side: a superadmin belongs to no
 * workspace, so there is no name to put in "invited to ___", and threading an
 * optional one through is how "invited to Aura." arrives where a sentence about
 * administering the platform belonged.
 *
 * It says what is being granted, because this message is what the recipient
 * reads before they click. "You have been invited to Aura" would describe
 * administrative access across every customer as though it were a seat in one
 * workspace, and somebody who was not expecting the invite should be able to
 * tell the difference from the message alone.
 */
export function operatorInviteMessage(input: {
  email: string;
  link: string;
  /**
   * ISO. Omitted when the caller does not know it, and then the sentence is left
   * out rather than guessed - a wrong expiry is worse than none.
   */
  expiresAt?: string | null;
}): string {
  return [
    "You have been invited to administer the Aura platform as a superadmin.",
    "This is access across every customer workspace, not access to one of them.",
    "",
    `Sign in with this email: ${input.email}`,
    `The invite only works for that address, and it can be used once.${expiryLine(input.expiresAt)}`,
    "",
    input.link,
  ].join("\n");
}

/**
 * The same thing for an OWNER invite issued from the operator console (the
 * instance page's Owner Logins card, 0137).
 *
 * Separate from `inviteMessage` because it grants more: the recipient becomes
 * the owner of the whole workspace, not a seat on someone else's team, and the
 * message they read before clicking should say so. The workspace is always
 * known here, but a blank name still falls back to a sentence that reads.
 */
export function ownerInviteMessage(input: {
  email: string;
  link: string;
  workspace?: string | null;
  /** ISO. Omitted or unparseable drops the sentence - see `expiryLine`. */
  expiresAt?: string | null;
}): string {
  const workspace = input.workspace?.trim();
  return [
    workspace
      ? `You have been invited to ${workspace} on Aura as its owner.`
      : "You have been invited to Aura as the owner of a workspace.",
    "",
    `Sign in with this email: ${input.email}`,
    `The invite only works for that address, and it can be used once.${expiryLine(input.expiresAt)}`,
    "",
    input.link,
  ].join("\n");
}

/**
 * " It expires on 2 Oct 2026 (UTC)." or nothing at all.
 *
 * UTC and spelled out, matching the sentence the emailed version carries, so the
 * recipient is told the same thing however the invite reached them.
 *
 * Deliberately NOT the reader's local time: this string is composed in the
 * browser of whoever is SENDING it, so a local format would state the sender's
 * timezone as though it were the recipient's.
 */
function expiryLine(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const when = at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return ` It expires on ${when} (UTC).`;
}
