/**
 * Conversations - the inbound messaging inbox (migration 0055).
 *
 * The vocabulary here is shared by three places that must agree or the thread
 * silently splits in two: the provider webhooks (apps/api), the inbox console
 * (apps/web) and the timeline projection. Anything spelled twice is spelled
 * once here instead - see the "hand-copied type unions drift" note in the
 * Track A gotchas.
 */
import { z } from "zod";

/**
 * Channels an inbox thread can exist on.
 *
 * Deliberately NOT the same list as interactions.type: an interaction can be a
 * call, a meeting or a note, none of which are two-way threads you can reply
 * into. This enum is only the conversational subset.
 */
export const ConversationChannel = z.enum(["whatsapp", "sms", "email"]);
export type ConversationChannel = z.infer<typeof ConversationChannel>;

/**
 * 'pending' is "waiting on them", not "waiting on us" - it is what an agent
 * sets after replying, so the inbox's default open filter stops showing a
 * thread whose ball is in the other court without pretending it is finished.
 */
export const ConversationStatus = z.enum(["open", "pending", "closed"]);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

/** Spelled as interactions.direction spells it (0040), on purpose. */
export const MessageDirection = z.enum(["incoming", "outgoing"]);
export type MessageDirection = z.infer<typeof MessageDirection>;

export const MessageStatus = z.enum([
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "received",
]);
export type MessageStatus = z.infer<typeof MessageStatus>;

/**
 * Normalise a peer address into the exact string `conversations.peer_address`
 * stores, so a reply threads onto the conversation it belongs to.
 *
 * ── WHY NOT normalizePhoneDigits() ──────────────────────────────────────
 *
 * That helper exists for the funnel form, where the country comes from a
 * <select> and the respondent types a NATIONAL number - so it strips leading
 * zeros as a trunk prefix. A webhook payload is the opposite case: the
 * provider hands over a full international number that is already unambiguous,
 * and stripping a leading zero there would corrupt numbers in the countries
 * whose subscriber digits legitimately begin with one.
 *
 * So this keeps every digit and only guarantees the "+" - the E.164 shape
 * `funnel_submissions.phone_e164` already uses, which is what makes matching an
 * inbound number to an existing enquirer a plain equality test.
 */
export function normalizePeerAddress(channel: ConversationChannel, raw: string): string {
  const trimmed = raw.trim();
  if (channel === "email") return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D+/gu, "");
  return digits.length > 0 ? `+${digits}` : "";
}

/**
 * A provider payload, already flattened into the shape the ingest path wants.
 *
 * Each webhook adapter is responsible for producing this and nothing else;
 * keeping the provider-specific JSON out of the ingest function is what lets a
 * second provider be added without touching the threading, matching or
 * idempotency logic.
 */
export const InboundMessage = z.object({
  channel: ConversationChannel,
  /** The other party. Normalised by the adapter before it gets here. */
  peerAddress: z.string().min(1),
  /** Display name if the provider supplied one - advisory, never matched on. */
  peerLabel: z.string().max(200).optional(),
  /** Our own address the message arrived at, when the provider reports it. */
  toAddress: z.string().max(320).optional(),
  subject: z.string().max(500).optional(),
  body: z.string(),
  provider: z.string().min(1).max(60),
  /**
   * The provider's own id for this message. Required, because it is the only
   * thing standing between a retried webhook and a duplicated thread bubble -
   * a provider that cannot supply one has to be given a synthesised stable key
   * by its adapter rather than being allowed through without.
   */
  externalId: z.string().min(1).max(200),
  /** Provider timestamp. Falls back to now() at insert when absent. */
  occurredAt: z.coerce.date().optional(),
});
export type InboundMessage = z.infer<typeof InboundMessage>;

/** Filters the inbox list accepts. */
export const ConversationListQuery = z.object({
  status: ConversationStatus.optional(),
  channel: ConversationChannel.optional(),
  assignedUserId: z.string().uuid().optional(),
  /** "Inbound traffic nobody has claimed onto a contact yet." */
  unmatchedOnly: z.coerce.boolean().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ConversationListQuery = z.infer<typeof ConversationListQuery>;

/** The mutations the console can perform on a thread. */
export const ConversationPatch = z
  .object({
    status: ConversationStatus.optional(),
    /** null clears the assignment back to the shared queue. */
    assignedUserId: z.string().uuid().nullable().optional(),
    /** Claim an unmatched thread onto a contact. null detaches it again. */
    contactId: z.string().uuid().nullable().optional(),
    /** Zeroes unread_count. Separate from status so reading is not closing. */
    markRead: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });
export type ConversationPatch = z.infer<typeof ConversationPatch>;
