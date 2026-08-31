import { createHmac, timingSafeEqual } from "node:crypto";
import { Body, Controller, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { decryptSecret } from "@aura/db";
import {
  normalizePeerAddress,
  WasiInboundMessage,
  WasiMessageStatus,
  type ConversationChannel,
  type InboundMessage,
} from "@aura/shared";
import { DbService } from "../../db/db.service";
import { ConversationsService, type ResolvedChannel } from "./conversations.service";

/**
 * Inbound provider webhooks — the receive half of messaging (0055/0056).
 *
 * ── WHY THIS ROUTE CARRIES NO GUARD ─────────────────────────────────────
 *
 * A provider cannot present an admin key or an org header, so AdminKeyGuard
 * and TenantGuard cannot apply. The `:token` path segment IS the credential:
 * it is a CSPRNG value stored in `messaging_channels.webhook_token`, UNIQUE
 * platform-wide, and resolving it both authenticates the caller and names the
 * tenant. An unknown or disabled token gets a 404 and nothing else — no hint
 * that a token exists, no tenant name, no echo of the payload.
 *
 * It is registered in guard-mounting.spec.ts's UNGUARDED list for exactly the
 * same reason /auth/login is: unguarded by design, asserted so it cannot
 * become unguarded by accident.
 *
 * ── IT ALWAYS ANSWERS 2xx ONCE THE TOKEN IS GOOD ────────────────────────
 *
 * Providers retry on any non-2xx, and WATI-class providers retry aggressively.
 * A message we cannot parse is therefore NOT a 500 — that would have the
 * provider replay the same unparseable payload for hours. It is a 202 with
 * `stored: false`, which ends the retry and leaves the failure visible in the
 * response rather than in a retry loop.
 */
@Controller("messaging/webhook")
export class MessagingWebhookController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly db: DbService,
  ) {}

  @Post(":token")
  async receive(
    @Param("token") token: string,
    @Body() body: unknown,
    @Req() req: RawBodyRequest<Request>,
  ) {
    // Length-bounded before it reaches the database: the token is a fixed-size
    // generated value, so anything wildly outside that is a probe, not a typo.
    if (typeof token !== "string" || token.length < 16 || token.length > 200) {
      throw new NotFoundException("unknown webhook");
    }

    const channel = await this.conversations.resolveChannel(token);
    if (!channel) throw new NotFoundException("unknown webhook");

    // Wasi (the user's own WhatsApp BSP, see wasi.ts) signs every delivery —
    // verified against the RAW bytes (main.ts's `rawBody: true`), same
    // reasoning as the Razorpay webhook: re-serialising the parsed body can
    // byte-differ.
    if (channel.provider === "wasi") {
      return this.receiveWasi(channel, body, req);
    }

    // Evolution (or any other relay) has no fixed signature contract Aura can
    // rely on by default — the `:token` in the URL is the only credential,
    // and the header comment above documents that a leaked token (proxy/CDN/
    // error-tracker log) then forges messages with nothing else to stop it.
    // `forward_secret` is the same per-channel column Wasi uses, generic
    // across providers (messaging-channels.controller.ts's UpdateChannelBody
    // never restricts it to `provider = 'wasi'`), so a tenant who configures
    // one here — and points their relay's own webhook-signing setting at it,
    // where the relay supports that — gets the same HMAC verification Wasi
    // gets, closing the token-only gap. A channel with none configured keeps
    // today's behaviour: nothing in Aura's control can force an arbitrary
    // relay to start signing deliveries it was never told to sign.
    if (channel.forwardSecret) {
      const secret = decryptSecret(channel.forwardSecret);
      const signatureHeader = req.headers["x-webhook-signature-256"] as string | undefined;
      if (!secret || !req.rawBody || !verifyWasiSignature(req.rawBody, signatureHeader, secret)) {
        // Same non-disclosure shape as everything else in this handler.
        return { stored: false, reason: "signature verification failed" };
      }
    }

    const adapted = adaptInbound(channel.channel, body);
    if (!adapted) {
      // Parsed nothing usable. Accepted-but-not-stored, deliberately — see
      // the header. The shape is echoed back so a misconfigured provider is
      // diagnosable from a single curl instead of a log dig.
      return {
        stored: false,
        reason: "unrecognised payload shape",
        sawKeys: body && typeof body === "object" ? Object.keys(body).slice(0, 20) : [],
      };
    }

    const result = await this.conversations.ingestInbound(channel, adapted);
    return { stored: !result.deduped, ...result };
  }

  private async receiveWasi(channel: ResolvedChannel, body: unknown, req: RawBodyRequest<Request>) {
    const secret = decryptSecret(channel.forwardSecret);
    const signatureHeader = req.headers["x-wasi-signature-256"] as string | undefined;
    if (!secret || !req.rawBody || !verifyWasiSignature(req.rawBody, signatureHeader, secret)) {
      // Same non-disclosure shape as an unknown token: a bad signature and an
      // unknown channel look identical from the outside.
      return { stored: false, reason: "signature verification failed" };
    }

    const envelope = body as { event?: string; data?: unknown };
    const parsedReceived = WasiInboundMessage.safeParse(envelope.data);
    const parsedStatus = WasiMessageStatus.safeParse(envelope.data);

    if (envelope.event === "message.received" && parsedReceived.success) {
      const d = parsedReceived.data;
      const peerAddress = normalizePeerAddress("whatsapp", d.contact.wa_id);
      if (!peerAddress) return { stored: false, reason: "unusable peer address" };
      const result = await this.conversations.ingestInbound(channel, {
        channel: "whatsapp",
        peerAddress,
        peerLabel: d.contact.name,
        body: d.message.body,
        provider: "wasi",
        externalId: d.message_id,
        occurredAt: new Date(d.message.sent_at),
      });
      return { stored: !result.deduped, ...result };
    }

    if (envelope.event === "message.status" && parsedStatus.success) {
      const d = parsedStatus.data;
      await this.conversations.updateMessageStatus(
        channel.orgId,
        "wasi",
        d.message_id,
        d.status,
        d.error?.message ?? null,
      );
      return { stored: true, reason: "status updated" };
    }

    // message_template_status_update / account_update, or a payload that
    // didn't parse as either typed shape above — logged for later, not acted
    // on. See 0061's header for why this stays a passthrough for now.
    if (typeof envelope.event === "string") {
      await this.db.withOrg(channel.orgId, (client) =>
        client.query(
          `INSERT INTO messaging_channel_events (org_id, messaging_channel_id, event, payload)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [channel.orgId, channel.id, envelope.event, JSON.stringify(envelope.data ?? {})],
        ),
      );
      return { stored: true, reason: "logged" };
    }

    return { stored: false, reason: "unrecognised event" };
  }
}

/**
 * `<header>: sha256=<hex>` — HMAC-SHA256 over the raw JSON body, keyed by a
 * channel's forward secret. Constant-time compare, same technique as every
 * other HMAC check in this codebase. Used for Wasi's own
 * `x-wasi-signature-256` header and, when a tenant has configured a secret
 * on a non-Wasi channel, the platform's own `x-webhook-signature-256`.
 */
export function verifyWasiSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const provided = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Flatten a provider payload into InboundMessage.
 *
 * ── THIS MAPPING IS NOT VERIFIED AGAINST A LIVE INSTANCE ────────────────
 *
 * whatsapp-check.controller.ts documents Evolution's `/user/check` response
 * because it was checked against the real thing. The INBOUND webhook payload
 * was not — there was no instance to point at while this was written. So
 * rather than commit to one guessed field path, this reads several plausible
 * ones and returns null when none of them yield a body and a sender.
 *
 * A null is visible (`stored: false` with the keys it actually saw), which is
 * the failure mode you can fix in one request. Guessing a single path and
 * being wrong is the other one: every message 200s, nothing is stored, and it
 * looks like nobody is writing in.
 *
 * FIRST REAL PAYLOAD: paste it into the fixtures and narrow this to the one
 * true path.
 */
export function adaptInbound(channel: ConversationChannel, body: unknown): InboundMessage | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;

  // Evolution nests the message under `data`; some relays post it flat.
  const data = (isRecord(root.data) ? root.data : root) as Record<string, unknown>;

  const key = isRecord(data.key) ? data.key : {};
  const message = isRecord(data.message) ? data.message : {};

  // ── who sent it ───────────────────────────────────────────────────────
  // A WhatsApp JID looks like "919876543210@s.whatsapp.net"; everything left
  // of the "@" is the number. Group JIDs ("…@g.us") are rejected below.
  const rawPeer =
    firstString([
      key.remoteJid,
      data.from,
      data.sender,
      root.from,
      data.remoteJid,
      channel === "email" ? data.fromAddress : undefined,
    ]) ?? null;
  if (!rawPeer) return null;
  if (rawPeer.includes("@g.us")) return null; // group chat — not a 1:1 thread
  const peerRaw = channel === "email" ? rawPeer : rawPeer.split("@")[0];
  const peerAddress = normalizePeerAddress(channel, peerRaw);
  if (!peerAddress) return null;

  // Outbound echoes: Evolution reports our own sends back to us with
  // fromMe=true. Storing those here would duplicate what the send path
  // already wrote, so they are dropped rather than threaded.
  if (key.fromMe === true || data.fromMe === true) return null;

  // ── what it said ──────────────────────────────────────────────────────
  const bodyText = firstString([
    message.conversation,
    isRecord(message.extendedTextMessage) ? message.extendedTextMessage.text : undefined,
    isRecord(message.imageMessage) ? message.imageMessage.caption : undefined,
    isRecord(message.videoMessage) ? message.videoMessage.caption : undefined,
    data.text,
    data.body,
    root.text,
    root.body,
  ]);
  // A media message with no caption is still a real event someone must see,
  // so it is stored with a placeholder rather than dropped as "empty".
  const hasMedia = ["imageMessage", "videoMessage", "audioMessage", "documentMessage"].some(
    (k) => k in message,
  );
  const finalBody = bodyText ?? (hasMedia ? "[media message]" : null);
  if (finalBody === null) return null;

  // ── identity of the message itself ────────────────────────────────────
  const externalId = firstString([key.id, data.id, data.messageId, root.id]);
  if (!externalId) return null; // no idempotency key — see InboundMessage.externalId

  const tsRaw = firstNumberOrString([data.messageTimestamp, data.timestamp, root.timestamp]);

  return {
    channel,
    peerAddress,
    peerLabel: firstString([data.pushName, data.senderName, root.pushName]),
    toAddress: firstString([data.to, data.toAddress, root.to]),
    subject: channel === "email" ? firstString([data.subject, root.subject]) : undefined,
    body: finalBody,
    provider: firstString([root.provider, data.provider]) ?? "evolution",
    externalId,
    occurredAt: coerceTimestamp(tsRaw),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstString(candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return undefined;
}

function firstNumberOrString(candidates: unknown[]): number | string | undefined {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return undefined;
}

/**
 * WhatsApp timestamps arrive in SECONDS. Passing those to `new Date()`
 * unmultiplied dates every message to January 1970, which sorts the whole
 * inbox backwards — so a plausible-looking 10-digit number is treated as
 * seconds and anything larger as milliseconds.
 */
function coerceTimestamp(raw: number | string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(n) && n > 0) {
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof raw === "string") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}
