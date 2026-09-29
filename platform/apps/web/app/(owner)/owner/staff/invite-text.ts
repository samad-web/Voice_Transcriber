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
