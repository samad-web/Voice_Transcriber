import { z } from "zod";

/**
 * The unified interaction timeline (packages/db/migrations/0040).
 *
 * `type` is stored as a plain text column and validated here rather than by a
 * DB CHECK - same choice as CustomFieldObjectType, and for the same reason:
 * Layer 1 adds real email/sms/whatsapp channels, and that should be a code
 * change rather than a migration.
 */

export const InteractionType = z.enum(["call", "email", "sms", "whatsapp", "meeting", "note"]);
export type InteractionType = z.infer<typeof InteractionType>;

export const InteractionDirection = z.enum(["incoming", "outgoing"]);
export type InteractionDirection = z.infer<typeof InteractionDirection>;

/**
 * Types the worker writes: a RECORDED call arrives on the timeline because the
 * pipeline projected it (call_id set, the handset's telecaller as actor_label).
 */
export const MACHINE_INTERACTION_TYPES: InteractionType[] = ["call"];

/**
 * What a user may log by hand.
 *
 * `call` joined this list for the follow-up surface's "Log call" action: a rep
 * who rang from a phone the platform does not record still made the call, and a
 * follow-up that cannot be closed with "called, no answer" pushes people to log
 * a fake note instead. It is kept distinguishable from a recording in the ROW,
 * not only in the UI - `call_id` NULL, `actor_user_id` set, and
 * `metadata.logged_by_hand = true` (HAND_LOGGED_CALL_METADATA) - so nothing
 * downstream can mistake it for audio: the call-integrity sweep joins on
 * call_id, and the retention reaper and erasure treat it as a person's record.
 */
export const ManualInteractionType = z.enum(["call", "email", "sms", "whatsapp", "meeting", "note"]);
export type ManualInteractionType = z.infer<typeof ManualInteractionType>;

/** How a hand-logged call went. Required for `call`, meaningless for anything else. */
export const CallOutcome = z.enum(["connected", "no_answer", "busy", "voicemail", "wrong_number"]);
export type CallOutcome = z.infer<typeof CallOutcome>;

/** The metadata marker every hand-logged call row carries - the one predicate backend sweeps key on. */
export const HAND_LOGGED_CALL_METADATA = { logged_by_hand: true } as const;

/**
 * A hand-logged interaction. At least one of contactId/accountId/dealId must
 * be present - an interaction attached to nothing would be invisible on every
 * timeline, which is a silent data-loss bug rather than a useful record.
 */
export const InteractionInput = z
  .object({
    type: ManualInteractionType,
    direction: InteractionDirection.nullish(),
    contactId: z.string().uuid().nullish(),
    accountId: z.string().uuid().nullish(),
    dealId: z.string().uuid().nullish(),
    subject: z.string().max(300).nullish(),
    body: z.string().max(20000).nullish(),
    occurredAt: z.string().datetime({ offset: true }).nullish(),
    durationS: z.number().int().min(0).max(86_400).nullish(),
    outcome: CallOutcome.nullish(),
  })
  .superRefine((value, ctx) => {
    // A hand-logged call must say how it went - "called" with no outcome is
    // the note nobody can act on - and nothing else may carry an outcome.
    if (value.type === "call" && !value.outcome) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a logged call needs an outcome", path: ["outcome"] });
    }
    if (value.type !== "call" && value.outcome) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "only a call has an outcome", path: ["outcome"] });
    }
    if (!value.contactId && !value.accountId && !value.dealId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an interaction must attach to at least one of contact, account or deal",
        path: ["contactId"],
      });
    }
    // A note with neither a subject nor a body is an empty row on the
    // timeline; the UI would render a blank card and nobody could tell what
    // it was meant to say.
    // A call's outcome is itself the content, so a call needs no body.
    if (value.type !== "call" && !value.subject?.trim() && !value.body?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subject or body is required",
        path: ["body"],
      });
    }
  });
export type InteractionInput = z.infer<typeof InteractionInput>;
