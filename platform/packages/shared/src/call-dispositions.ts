import { z } from "zod";
import { LeadTemperature } from "./leads";

/**
 * Call dispositions (migration 0097): the tenant's own words for how a call
 * ended, and what each one says about the lead.
 *
 * ── THE KEY IS DERIVED ONCE AND THEN FROZEN ─────────────────────────────────
 *
 * Every call ever dispositioned is filed under the key, so renaming it would
 * orphan them all. The LABEL is freely editable and is what anybody reads.
 * Identical to the rule `call-sops.ts` states for step keys, and the reason is
 * the same in both places.
 */

/** A palette, not free text: a colour picker on a settings page is a way to
 *  produce chips nobody can read against the console's own background. */
export const DispositionColor = z.enum(["green", "blue", "amber", "red", "grey", "purple"]);
export type DispositionColor = z.infer<typeof DispositionColor>;

export const DispositionKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "lowercase letters, digits and underscores");

export const CallDispositionInput = z.object({
  label: z.string().trim().min(1).max(60),
  /**
   * What this outcome implies about the lead. `null` means "says nothing",
   * which is the correct answer for most dispositions - see below.
   */
  leadQuality: LeadTemperature.nullish(),
  color: DispositionColor.default("grey"),
  sortOrder: z.number().int().min(0).max(999).default(0),
});
export type CallDispositionInput = z.infer<typeof CallDispositionInput>;

export const CallDispositionUpdate = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  leadQuality: LeadTemperature.nullish(),
  color: DispositionColor.optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
});
export type CallDispositionUpdate = z.infer<typeof CallDispositionUpdate>;

/**
 * Turn a label into a key.
 *
 * Same shape as the SOP editor's `keyFor`, deliberately: two places in this
 * product mint a stable key from a human label, and them agreeing about what
 * "Call back later" becomes is worth more than either being cleverer.
 */
export function dispositionKeyFor(label: string, taken: Set<string> = new Set()): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "d$1")
      .slice(0, 40) || "outcome";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

/**
 * How many of a tenant's dispositions may assert a temperature before the
 * setting stops meaning anything.
 *
 * Not enforced - it is a warning the console shows, not a rule - because the
 * failure it guards against is judgement, not correctness. If "no answer" and
 * "busy" both mark leads cold, then a floor that dials a lot will re-rate its
 * whole board to cold by Wednesday, and the rating will have become a measure
 * of how hard it is to reach people rather than of how good they are.
 */
export const QUALITY_ASSERTING_WARN_AT = 3;

/** Does this set of dispositions look like it will over-rate the board? */
export function overQualified(dispositions: { leadQuality: string | null }[]): boolean {
  return dispositions.filter((d) => d.leadQuality !== null).length > QUALITY_ASSERTING_WARN_AT;
}
