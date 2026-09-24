import { buildMime } from "../connections/email-send";
import { sendSmtpMessage, type SmtpConfig } from "../connections/smtp";

/**
 * The one email the platform itself sends: an invite, to the one address an
 * owner typed, when that owner pressed "Send".
 *
 * ── OFF UNLESS CONFIGURED ──────────────────────────────────────────────────
 *
 * Until now nothing in this platform mailed anybody on its own account - the
 * Team page showed a password for the owner to pass on. Invites keep that as
 * the default: with no `PLATFORM_SMTP_*` set, the link is shown for copying
 * and nothing is sent. Configuring SMTP is the deliberate act that turns
 * sending on, and even then each message is one owner, one button, one
 * recipient - never a batch, never a retry, never a reminder.
 *
 * ── WHY NOT THE OWNER'S CONNECTED MAILBOX ──────────────────────────────────
 *
 * email-send.ts can send from a person's own Gmail/Outlook, but only to a CRM
 * contact and only behind EMAIL_SENDING_ENABLED - rules written for customer
 * mail. An invite is platform mail to a future colleague, and most owners
 * inviting their first telecaller have connected no mailbox at all.
 *
 * Same wire code as that path (buildMime + the hand-written SMTP client), so
 * the header-injection guard in buildMime covers the org name and inviter
 * name that end up in the subject line.
 */

export interface PlatformMailConfig {
  smtp: SmtpConfig;
  fromEmail: string;
  fromName: string;
}

/** The SMTP settings, or null when invites cannot be mailed from here. */
export function platformMailConfig(env: NodeJS.ProcessEnv = process.env): PlatformMailConfig | null {
  const host = env.PLATFORM_SMTP_HOST?.trim();
  const user = env.PLATFORM_SMTP_USER?.trim();
  const password = env.PLATFORM_SMTP_PASSWORD ?? "";
  const fromEmail = env.PLATFORM_MAIL_FROM?.trim();
  // All four or nothing: smtp.ts always authenticates (it has no anonymous
  // relay mode), so a host without credentials would fail on every send.
  if (!host || !user || !password || !fromEmail) return null;
  const port = Number(env.PLATFORM_SMTP_PORT ?? 587);
  return {
    smtp: {
      host,
      port: Number.isFinite(port) && port > 0 ? port : 587,
      user,
      password,
      // 465 is implicit TLS; everything else upgrades with STARTTLS. smtp.ts
      // never sends credentials in the clear, whichever this is.
      secure: env.PLATFORM_SMTP_SECURE ? env.PLATFORM_SMTP_SECURE === "true" : port === 465,
    },
    fromEmail,
    fromName: env.PLATFORM_MAIL_FROM_NAME?.trim() || "Aura",
  };
}

export interface InviteMailInput {
  to: string;
  orgName: string;
  inviterName: string | null;
  roleLabel: string;
  link: string;
  expiresAt: Date;
}

/** Subject and plain-text body. Plain text: nothing to render, nothing to spoof. */
export function inviteMailContent(input: InviteMailInput): { subject: string; body: string } {
  const who = input.inviterName?.trim() || "Your team";
  const expires = input.expiresAt.toUTCString().replace(" GMT", " UTC");
  return {
    subject: `${who} invited you to ${input.orgName}`,
    body: [
      `${who} has invited you to join ${input.orgName} as ${input.roleLabel}.`,
      "",
      "Accept the invite and sign in with your Google account:",
      input.link,
      "",
      `Use the Google account for ${input.to} - the invite only works for that address.`,
      `This link expires on ${expires} and can be used once.`,
      "",
      "If you weren't expecting this, you can ignore this email.",
    ].join("\n"),
  };
}

/** Send one invite. Throws on any SMTP failure; the caller reports it. */
export async function sendInviteMail(
  config: PlatformMailConfig,
  input: InviteMailInput,
  send: typeof sendSmtpMessage = sendSmtpMessage,
): Promise<void> {
  const { subject, body } = inviteMailContent(input);
  await send(config.smtp, {
    from: config.fromEmail,
    to: input.to,
    mime: buildMime({ to: input.to, subject, body, fromEmail: config.fromEmail, fromName: config.fromName }),
  });
}
