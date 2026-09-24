import { randomUUID } from "node:crypto";
import type { ResolvedOAuthClient } from "@aura/db";
import { connectionProvider } from "@aura/shared";
import { sendSmtpMessage, type SmtpConfig } from "./smtp";

/**
 * Sending mail from a user's own connected mailbox (PRD Layer 1).
 *
 * ── WHY THIS IS DELIBERATELY SMALL ────────────────────────────────────────
 *
 * An automated sender that can put mail in front of a real customer is a
 * different risk class from everything else in this CRM, and the mistakes are
 * not recoverable: a message that goes out cannot be recalled, and the person
 * who receives it does not care that a rule misfired. So this module can only
 * do one thing - send one message, composed by a person, to a contact that
 * already exists, from that person's own mailbox - and every part of that
 * sentence is enforced somewhere in the path:
 *
 *   - composed by a person   → the route requires a resolvable user identity;
 *                              a bare admin key cannot reach it
 *   - one message            → one recipient, no bcc, no lists
 *   - to a contact           → the recipient is READ FROM the contact row,
 *                              never supplied by the caller
 *   - own mailbox            → the connection is looked up by the caller's own
 *                              user_id and cannot be another user's
 *
 * And above all of it, `EMAIL_SENDING_ENABLED` defaults to OFF, so a fresh
 * deployment cannot emit mail at all until somebody deliberately turns it on.
 *
 * Nothing in the automation engine calls this. That is on purpose, and stated
 * here because "we could just add a send action" is the obvious next thought
 * and it is the wrong one.
 */

export interface OutgoingMessage {
  to: string;
  subject: string;
  body: string;
  fromEmail: string;
  fromName?: string | null;
  /** RFC 5322 Message-ID, angle brackets included. Written as a header when set. */
  messageId?: string | null;
}

export interface SendResult {
  /** The provider's own id, so the sent message can be deduplicated by the sync. */
  externalId: string | null;
  /**
   * The RFC 5322 Message-ID the message went out with, where we know it.
   *
   * The de-duplication key when there is no usable provider id - Outlook's
   * case (see the Graph path below). Stored on the interaction's metadata as
   * `internet_message_id`, which is the key the worker's mail sync checks
   * (apps/worker/src/pipeline/email-sync.ts) before writing a synced copy.
   */
  internetMessageId: string | null;
}

/**
 * A fresh Message-ID in the sender's own domain, as RFC 5322 §3.6.4 asks.
 * Random rather than derived from anything, so two sends can never collide.
 */
export function newMessageId(fromEmail: string): string {
  const domain = header(fromEmail.split("@")[1] ?? "").replace(/[<>\s]/g, "") || "localhost";
  return `<${randomUUID()}@${domain}>`;
}

/**
 * The master switch. OFF unless explicitly set.
 *
 * Opt-in rather than opt-out because the failure modes are asymmetric: a
 * deployment that cannot send mail is an inconvenience somebody notices in
 * seconds, and a deployment that sends mail nobody meant to send is an
 * incident with a customer on the other end of it.
 */
export function sendingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EMAIL_SENDING_ENABLED === "true";
}

/**
 * How many messages one connection may send per day.
 *
 * Not a performance guard - a correctness one. Whatever bug or misuse ends up
 * pointing a loop at this module, the blast radius is one day's cap on one
 * mailbox rather than every contact in the tenant.
 */
export function dailySendLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EMAIL_SEND_DAILY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

/** Which providers this module can actually send through. */
/**
 * `imap` joined the OAuth two once SMTP was implemented (smtp.ts).
 *
 * It was excluded before not as a policy but as a gap: the IMAP connection
 * could READ a tenant's mail onto the customer timeline and could not reply
 * from the console, which is half a feature and the half people notice.
 */
export function canSend(provider: string): boolean {
  return provider === "google" || provider === "microsoft" || provider === "imap";
}

/**
 * RFC 5322 message, built by hand.
 *
 * Headers are stripped of CR and LF before they go anywhere near the
 * envelope. Without that, a subject containing a newline lets the caller
 * inject arbitrary headers - a Bcc to somewhere else being the obvious one -
 * which is header injection, one of the oldest holes in mail handling.
 */
export function buildMime(message: OutgoingMessage): string {
  const from = message.fromName
    ? `${header(message.fromName)} <${header(message.fromEmail)}>`
    : header(message.fromEmail);

  return [
    `From: ${from}`,
    `To: ${header(message.to)}`,
    `Subject: ${header(message.subject)}`,
    ...(message.messageId ? [`Message-ID: ${header(message.messageId)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    // The body may legitimately contain newlines; only the HEADERS are the
    // injection surface, and they are sanitised individually above.
    message.body,
  ].join("\r\n");
}

function header(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export async function sendMessage(
  provider: string,
  accessToken: string,
  message: OutgoingMessage,
  fetchImpl: typeof fetch = fetch,
  /**
   * SMTP settings, for the `imap` provider. Absent for the OAuth two, which
   * carry everything they need in the access token - which is why this is a
   * trailing optional rather than a field on `OutgoingMessage`: a Gmail send
   * has no host, port or password and should not have to pass nulls for them.
   */
  smtp?: SmtpConfig,
): Promise<SendResult> {
  const spec = connectionProvider(provider);
  if (!spec || !canSend(provider)) {
    throw new Error(`${provider} cannot send mail from this deployment`);
  }

  if (provider === "imap") {
    if (!smtp) throw new Error("this mailbox has no SMTP settings saved - reconnect it");
    // Our own Message-ID, because SMTP gives back nothing we can key on: its
    // 250 response carries a queue id that is the server's and means nothing
    // to us, and without a header of ours the server would invent the
    // Message-ID where we could not see it. Recorded on the interaction, it
    // is what a future IMAP sync of the Sent folder would dedupe against.
    // (There is no IMAP sync today - emailAdapter('imap') is null - so today
    // nothing re-reads these and nothing can duplicate them.)
    const messageId = newMessageId(message.fromEmail);
    // The SAME buildMime as the Gmail path, so a reply looks identical
    // whichever mailbox it left from - and so the header-injection guard that
    // function applies is not something the SMTP path could forget.
    await sendSmtpMessage(smtp, {
      from: message.fromEmail,
      to: message.to,
      mime: buildMime({ ...message, messageId }),
    });
    return { externalId: null, internetMessageId: messageId };
  }

  if (provider === "google") {
    const raw = Buffer.from(buildMime(message), "utf8").toString("base64url");
    const res = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw await sendError(res);
    // Gmail's id is the message's id in the mailbox - the same one the sync
    // reads from Sent - so the unique index on external_id does the dedupe.
    const body = (await res.json()) as { id?: string };
    return { externalId: body.id ?? null, internetMessageId: null };
  }

  // ── Microsoft Graph: create a draft, then send it ──────────────────────────
  //
  // NOT the one-call `/me/sendMail`. That returns 202 with an empty body, so
  // the console had nothing to record, and the sync then wrote the Sent Items
  // copy as a second row - every Outlook send appeared twice on the timeline.
  // (The comment that used to sit here said the sync deduped "by subject and
  // time"; no such check ever existed.)
  //
  // Creating the draft first (201, the full message) hands back the
  // `internetMessageId` Exchange assigned, and the draft's `/send` keeps it.
  // Its Graph `id` is no use as a key: ids change when an item changes folder
  // unless every caller opts into immutable ids, and sending moves the draft
  // to Sent Items. The Message-ID does not change, so that is what the
  // interaction records and what the sync matches on.
  //
  // We do not SET internetMessageId ourselves: Graph documents it without
  // saying it is writable on create, and a guess that turned into a 400
  // would fail real sends. Reading back Exchange's own is certain.
  //
  // `/send` saves to Sent Items (Graph's documented behaviour for a draft),
  // which keeps what `saveToSentItems: true` guaranteed before - a CRM that
  // sends on someone's behalf and leaves no trace in their own mailbox is not
  // a tool they can audit. Needs Mail.ReadWrite for the draft, which the
  // Microsoft connection already requests (@aura/shared connection-providers).
  const auth = { authorization: `Bearer ${accessToken}` };
  const created = await fetchImpl("https://graph.microsoft.com/v1.0/me/messages", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      subject: header(message.subject),
      body: { contentType: "Text", content: message.body },
      toRecipients: [{ emailAddress: { address: header(message.to) } }],
    }),
  });
  if (!created.ok) throw await sendError(created);
  const draft = (await created.json()) as { id?: string; internetMessageId?: string };
  if (!draft.id) throw new Error("the mail provider created no draft to send");

  const draftUrl = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draft.id)}`;
  const sent = await fetchImpl(`${draftUrl}/send`, { method: "POST", headers: auth });
  if (!sent.ok) {
    const error = await sendError(sent);
    // Nothing went out; don't leave a half-made message sitting in the
    // person's Drafts to be sent by hand later by mistake. Best-effort - the
    // error the caller sees is the send failure, not this.
    await fetchImpl(draftUrl, { method: "DELETE", headers: auth }).catch(() => undefined);
    throw error;
  }
  return { externalId: null, internetMessageId: draft.internetMessageId ?? null };
}

/**
 * Refresh an access token.
 *
 * A near-twin of the worker's `refreshAccessToken` (apps/worker/src/pipeline/
 * email-sync.ts) and it lives here rather than being shared, because the two
 * apps cannot import each other and neither belongs in @aura/shared, which is
 * deliberately network-free. It sits next to `exchangeCode` in this module
 * instead - the other half of the same handshake, against the same endpoint,
 * with the same client credentials.
 *
 * Takes the RESOLVED app (@aura/db's resolveOAuthClient) rather than looking
 * one up: which app may refresh a token depends on the organisation and on
 * the app the connection was made through, and only the caller has both.
 */
export async function refreshAccessToken(
  client: ResolvedOAuthClient,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number | null; refreshToken: string | null }> {
  const res = await fetchImpl(client.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`token refresh failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in ?? null,
    refreshToken: body.refresh_token ?? null,
  };
}

async function sendError(res: Response): Promise<Error> {
  const detail = await res.text().catch(() => "");
  return new Error(`the mail provider refused the message (${res.status}): ${detail.slice(0, 200)}`);
}
