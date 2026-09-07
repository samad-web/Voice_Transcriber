import { createHmac, timingSafeEqual } from "node:crypto";
import type { ConversationChannel } from "@aura/shared";

/**
 * Meta's three messaging surfaces - WhatsApp Cloud API, Instagram Direct and
 * Facebook Messenger - as one adapter.
 *
 * ── WHY ONE FILE FOR THREE PRODUCTS ─────────────────────────────────────────
 *
 * They arrive on the same webhook, signed the same way, wrapped in the same
 * `entry[]` envelope, and they are subscribed per Page through the same Graph
 * API. What differs is one layer down: WhatsApp puts messages under
 * `changes[].value.messages[]` and identifies people by phone number;
 * Messenger and Instagram put them under `messaging[]` and identify people by
 * a page-scoped id. Splitting them into three files would triple the envelope
 * handling - the part that is genuinely identical - to isolate the twenty
 * lines that are not.
 *
 * ── THE PAGE-SCOPED ID IS NOT A PHONE NUMBER, AND THAT MATTERS ──────────────
 *
 * A WhatsApp message dedupes against a contact's mobile, so it can join the
 * customer somebody already knows. An Instagram sender id is scoped to the
 * Page and means nothing anywhere else - there is no way to match it to a
 * contact unless the person tells you who they are. So an IG or Messenger
 * thread starts unmatched by design, and the console asks a human to link it,
 * exactly as the WhatsApp qualification flow (0080) already does. Guessing
 * would attach a stranger's DM to a real customer's record.
 */

export interface MetaInbound {
  channel: ConversationChannel;
  /** Phone number for WhatsApp; the page-scoped sender id for IG/Messenger. */
  peerAddress: string;
  peerLabel: string | null;
  body: string;
  externalId: string;
  occurredAt: Date;
  /** Which of our own numbers/pages it arrived at, when Meta says. */
  recipient: string | null;
}

export interface MetaStatusUpdate {
  externalId: string;
  status: string;
  error: string | null;
}

/**
 * Verify `X-Hub-Signature-256` against the RAW request bytes.
 *
 * Raw and never the re-serialised body: `JSON.parse` then `JSON.stringify`
 * can differ by a byte - key order, unicode escaping, number formatting - and
 * every one of those differences produces a valid-looking rejection of a
 * genuine delivery. The Razorpay and Wasi webhooks in this codebase make the
 * same choice for the same reason, which is why main.ts asks Express for
 * `rawBody`.
 *
 * `timingSafeEqual` and a length check first, because it throws on a length
 * mismatch rather than returning false.
 */
export function verifyMetaSignature(
  raw: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(raw).digest("hex");
  const got = header.slice("sha256=".length);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
}

/**
 * Meta's subscription handshake: echo `hub.challenge` when the token matches.
 *
 * Returns the challenge to echo, or null to refuse. A refusal is a 403 with no
 * body, which is what Meta's own documentation expects and also the least
 * informative thing to hand somebody probing webhook URLs.
 *
 * The verify token is compared with `timingSafeEqual` like any other shared
 * secret. It is low-value - it only lets somebody complete a subscription
 * handshake - but it is still a secret compared on a public endpoint, and
 * writing that comparison the careless way here would make it the example
 * somebody copies for a higher-value one.
 */
export function verifySubscription(
  query: Record<string, unknown>,
  expectedToken: string,
): string | null {
  const mode = String(query["hub.mode"] ?? "");
  const token = String(query["hub.verify_token"] ?? "");
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || typeof challenge !== "string") return null;
  if (token.length !== expectedToken.length) return null;
  if (!timingSafeEqual(Buffer.from(token, "utf8"), Buffer.from(expectedToken, "utf8"))) {
    return null;
  }
  return challenge;
}

interface Envelope {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    changes?: Array<{ field?: string; value?: unknown }>;
    messaging?: Array<unknown>;
  }>;
}

/**
 * Every message in one delivery.
 *
 * Meta batches: one POST can carry several entries, each with several changes,
 * each with several messages. Returning an array rather than the first one is
 * not tidiness - dropping the rest silently loses customer messages under
 * load, which is exactly when it would not be noticed.
 */
export function parseMetaInbound(body: unknown): MetaInbound[] {
  const envelope = body as Envelope;
  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.entry)) return [];

  const out: MetaInbound[] = [];
  for (const entry of envelope.entry) {
    // ── WhatsApp Cloud API ────────────────────────────────────────────────
    for (const change of entry.changes ?? []) {
      const value = change.value as
        | {
            metadata?: { display_phone_number?: string; phone_number_id?: string };
            contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
            messages?: Array<{
              id?: string;
              from?: string;
              timestamp?: string;
              type?: string;
              text?: { body?: string };
              button?: { text?: string };
              interactive?: {
                button_reply?: { title?: string };
                list_reply?: { title?: string };
              };
            }>;
          }
        | undefined;
      if (!value?.messages) continue;

      const label = value.contacts?.[0]?.profile?.name ?? null;
      for (const message of value.messages) {
        const text = whatsappText(message);
        // A photo, a voice note or a location with no caption. Recorded as a
        // placeholder rather than dropped: a thread that silently skips the
        // customer's photo and shows only the reply reads as if they never
        // sent anything, and the rep answers the wrong question.
        const bodyText = text ?? `[${message.type ?? "attachment"}]`;
        if (!message.id || !message.from) continue;
        out.push({
          channel: "whatsapp",
          peerAddress: message.from,
          peerLabel: label,
          body: bodyText,
          externalId: message.id,
          occurredAt: fromUnix(message.timestamp),
          recipient: value.metadata?.display_phone_number ?? null,
        });
      }
    }

    // ── Messenger and Instagram ───────────────────────────────────────────
    //
    // `object` distinguishes them and nothing else does: the payload shape is
    // identical, and an Instagram DM delivered to a Page webhook looks exactly
    // like a Messenger message apart from this field.
    const channel: ConversationChannel | null =
      envelope.object === "instagram"
        ? "instagram"
        : envelope.object === "page"
          ? "facebook"
          : null;
    if (!channel) continue;

    for (const raw of entry.messaging ?? []) {
      const event = raw as {
        sender?: { id?: string };
        recipient?: { id?: string };
        timestamp?: number;
        message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: unknown[] };
      };
      // `is_echo` is our OWN message played back to us. Ingesting it would
      // duplicate every reply the console sends, and then thread it as if the
      // customer had said it.
      if (!event.message || event.message.is_echo) continue;
      if (!event.message.mid || !event.sender?.id) continue;
      out.push({
        channel,
        peerAddress: event.sender.id,
        peerLabel: null,
        body: event.message.text ?? "[attachment]",
        externalId: event.message.mid,
        occurredAt: event.timestamp ? new Date(event.timestamp) : new Date(),
        recipient: event.recipient?.id ?? null,
      });
    }
  }
  return out;
}

/** Delivery receipts, so a sent message can stop saying "sending". */
export function parseMetaStatuses(body: unknown): MetaStatusUpdate[] {
  const envelope = body as Envelope;
  if (!envelope || !Array.isArray(envelope.entry)) return [];
  const out: MetaStatusUpdate[] = [];
  for (const entry of envelope.entry) {
    for (const change of entry.changes ?? []) {
      const value = change.value as
        | {
            statuses?: Array<{
              id?: string;
              status?: string;
              errors?: Array<{ title?: string; message?: string }>;
            }>;
          }
        | undefined;
      for (const status of value?.statuses ?? []) {
        if (!status.id || !status.status) continue;
        out.push({
          externalId: status.id,
          status: status.status,
          error: status.errors?.[0]?.message ?? status.errors?.[0]?.title ?? null,
        });
      }
    }
  }
  return out;
}

/**
 * How long a free-form reply is still allowed.
 *
 * All three Meta channels close a 24-hour window from the customer's last
 * message; after it, WhatsApp needs an approved template and Instagram and
 * Messenger need a permitted tag or nothing at all. The console has to be able
 * to say "you have three hours left" rather than letting a rep write a reply
 * that will be refused on send.
 *
 * Derived from the last inbound message rather than stored, so there is no
 * second clock to fall out of step with the thread.
 */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function replyWindow(lastInboundAt: Date | null, now: Date = new Date()): {
  open: boolean;
  msRemaining: number;
} {
  if (!lastInboundAt) return { open: false, msRemaining: 0 };
  const remaining = lastInboundAt.getTime() + REPLY_WINDOW_MS - now.getTime();
  return { open: remaining > 0, msRemaining: Math.max(0, remaining) };
}

function whatsappText(message: {
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}): string | null {
  return (
    message.text?.body ??
    message.button?.text ??
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title ??
    null
  );
}

/** Meta sends seconds as a string; everything here works in Date. */
function fromUnix(value: string | undefined): Date {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}
