import { connectionProvider, type ConnectionProviderSpec } from "@aura/shared";
import { oauthClient } from "./oauth";

/**
 * Sending mail from a user's own connected mailbox (PRD Layer 1).
 *
 * ── WHY THIS IS DELIBERATELY SMALL ────────────────────────────────────────
 *
 * An automated sender that can put mail in front of a real customer is a
 * different risk class from everything else in this CRM, and the mistakes are
 * not recoverable: a message that goes out cannot be recalled, and the person
 * who receives it does not care that a rule misfired. So this module can only
 * do one thing — send one message, composed by a person, to a contact that
 * already exists, from that person's own mailbox — and every part of that
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
}

export interface SendResult {
  /** The provider's own id, so the sent message can be deduplicated by the sync. */
  externalId: string | null;
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
 * Not a performance guard — a correctness one. Whatever bug or misuse ends up
 * pointing a loop at this module, the blast radius is one day's cap on one
 * mailbox rather than every contact in the tenant.
 */
export function dailySendLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EMAIL_SEND_DAILY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100;
}

/** Which providers this module can actually send through. */
export function canSend(provider: string): boolean {
  return provider === "google" || provider === "microsoft";
}

/**
 * RFC 5322 message, built by hand.
 *
 * Headers are stripped of CR and LF before they go anywhere near the
 * envelope. Without that, a subject containing a newline lets the caller
 * inject arbitrary headers — a Bcc to somewhere else being the obvious one —
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
): Promise<SendResult> {
  const spec = connectionProvider(provider);
  if (!spec || !canSend(provider)) {
    throw new Error(`${provider} cannot send mail from this deployment`);
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
    const body = (await res.json()) as { id?: string };
    return { externalId: body.id ?? null };
  }

  // Microsoft Graph. `saveToSentItems` so the message appears in the user's
  // own Sent folder — a CRM that sends on someone's behalf and leaves no
  // trace in their own mailbox is not a tool they can audit.
  const res = await fetchImpl("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: header(message.subject),
        body: { contentType: "Text", content: message.body },
        toRecipients: [{ emailAddress: { address: header(message.to) } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) throw await sendError(res);
  // Graph's sendMail returns 202 with an empty body — no id to record. The
  // mail sync will pick the message up from the Sent folder on its next pass
  // and dedupe against the interaction row written here by subject and time.
  return { externalId: null };
}

/**
 * Refresh an access token.
 *
 * A near-twin of the worker's `refreshAccessToken` (apps/worker/src/pipeline/
 * email-sync.ts) and it lives here rather than being shared, because the two
 * apps cannot import each other and neither belongs in @aura/shared, which is
 * deliberately network-free. It sits next to `exchangeCode` in this module
 * instead — the other half of the same handshake, against the same endpoint,
 * with the same client credentials.
 */
export async function refreshAccessToken(
  spec: ConnectionProviderSpec,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; expiresIn: number | null; refreshToken: string | null }> {
  const client = oauthClient(spec);
  if (!spec.oauth || !client) throw new Error(`${spec.id} is not configured on this deployment`);

  const res = await fetchImpl(spec.oauth.tokenUrl, {
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
