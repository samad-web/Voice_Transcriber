import { z } from "zod";

/**
 * The contract for Wasi's Hub API (`C:\Users\mas20\Desktop\work\Wasi`) - the
 * user's own WhatsApp Business Solution Provider platform. Aura is a Hub
 * CLIENT: it never talks to Meta's Graph API directly, and never does its own
 * Embedded Signup. Everything here is transcribed from Wasi's real source
 * (`server/src/routes/apiV1Messages.js`, `metaWebhook.js`), not guessed.
 */

/** Wasi's own error codes from `messagingService.js` - everything MessagingError throws. */
export const WasiErrorCode = z.enum([
  "waba_not_connected",
  "consent_required",
  "plan_limit_reached",
  "session_window_closed",
  "media_resolution_failed",
  "send_failed",
]);
export type WasiErrorCode = z.infer<typeof WasiErrorCode>;

export const WasiErrorResponse = z.object({
  error: z.string(),
  code: WasiErrorCode.optional(),
  metaError: z.unknown().optional(),
});
export type WasiErrorResponse = z.infer<typeof WasiErrorResponse>;

/** `POST /api/v1/messages` request body. */
export const WasiSendRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("template"),
    client_id: z.string().uuid(),
    to: z.string().min(5).max(20),
    template: z.string().min(1),
    params: z.record(z.string(), z.string()).default({}),
    headerMediaUrl: z.string().url().optional(),
  }),
  z.object({
    type: z.literal("text"),
    client_id: z.string().uuid(),
    to: z.string().min(5).max(20),
    body: z.string().min(1).max(4096),
  }),
]);
export type WasiSendRequest = z.infer<typeof WasiSendRequest>;

/** The envelope every hub-forward delivery arrives in: `{event, data}`. */
export const WasiWebhookEvent = z.enum([
  "message.received",
  "message.status",
  "message_template_status_update",
  "account_update",
]);
export type WasiWebhookEvent = z.infer<typeof WasiWebhookEvent>;

/**
 * `message.received` - built from a real message row, field-for-field
 * against metaWebhook.js. `media_id`/`media_mime_type`/`media_filename` ride
 * along incidentally (a DB-row spread on Wasi's side, not a designed
 * contract) - kept optional and unused rather than trusted.
 */
export const WasiInboundMessage = z.object({
  chat_id: z.string(),
  message_id: z.string(),
  message_type: z.string(),
  contact: z.object({ wa_id: z.string(), name: z.string().optional() }),
  message: z.object({
    body: z.string(),
    sent_at: z.string(),
    media_id: z.string().nullish(),
    media_mime_type: z.string().nullish(),
    media_filename: z.string().nullish(),
  }),
  waba_id: z.string(),
  enqueued_at: z.string(),
});
export type WasiInboundMessage = z.infer<typeof WasiInboundMessage>;

/** `message.status` - a delivery-lifecycle transition for one prior send. */
export const WasiMessageStatus = z.object({
  message_id: z.string(),
  status: z.enum(["sent", "delivered", "read", "failed"]),
  error: z.object({ code: z.number().nullable(), message: z.string().nullable() }).nullable(),
  waba_id: z.string(),
  enqueued_at: z.string(),
});
export type WasiMessageStatus = z.infer<typeof WasiMessageStatus>;

/**
 * `message_template_status_update` / `account_update` - Wasi forwards Meta's
 * raw `value` object verbatim plus the `waba_id`/`enqueued_at` envelope. Its
 * own code only trusts a couple of fields on each and documents the rest as
 * unconfirmed against a live payload - so this stays a passthrough bag rather
 * than a strict schema; parse defensively, store the whole thing.
 */
export const WasiRawEvent = z.record(z.string(), z.unknown());
export type WasiRawEvent = z.infer<typeof WasiRawEvent>;
