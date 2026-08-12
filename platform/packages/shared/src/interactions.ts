import { z } from "zod";

/**
 * The unified interaction timeline (packages/db/migrations/0040).
 *
 * `type` is stored as a plain text column and validated here rather than by a
 * DB CHECK — same choice as CustomFieldObjectType, and for the same reason:
 * Layer 1 adds real email/sms/whatsapp channels, and that should be a code
 * change rather than a migration.
 */

export const InteractionType = z.enum(["call", "email", "sms", "whatsapp", "meeting", "note"]);
export type InteractionType = z.infer<typeof InteractionType>;

export const InteractionDirection = z.enum(["incoming", "outgoing"]);
export type InteractionDirection = z.infer<typeof InteractionDirection>;

/**
 * Types the worker owns: a call arrives on the timeline because the pipeline
 * projected it, never because somebody typed it in. Everything else is
 * manually logged until Layer 1's channel integrations land.
 */
export const MACHINE_INTERACTION_TYPES: InteractionType[] = ["call"];

/** What a user may log by hand — `call` deliberately excluded, see above. */
export const ManualInteractionType = z.enum(["email", "sms", "whatsapp", "meeting", "note"]);
export type ManualInteractionType = z.infer<typeof ManualInteractionType>;

/**
 * A hand-logged interaction. At least one of contactId/accountId/dealId must
 * be present — an interaction attached to nothing would be invisible on every
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
  })
  .superRefine((value, ctx) => {
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
    if (!value.subject?.trim() && !value.body?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subject or body is required",
        path: ["body"],
      });
    }
  });
export type InteractionInput = z.infer<typeof InteractionInput>;
