import { z } from "zod";

/**
 * Deliberately inert, same shipping pattern the roles/permissions schema used
 * in M6: a seam for a feature that doesn't exist yet, not the feature itself.
 *
 * The user has said WhatsApp-official will be gated by plan tier once a
 * plans/billing system exists — it doesn't yet (`billing.controller.ts` is
 * still a usage-only stub, and `organizations.plan_id` is a dormant column
 * nothing reads). Rather than either (a) building a whole plan/billing system
 * to unblock one gate, or (b) shipping the WhatsApp send path with NO gate at
 * all, this is the one call site the future gate plugs into.
 * `orgPlanIncludesWhatsapp` returns true for every plan today — replacing its
 * body is the entire migration once plans are real.
 *
 * `plan_id` names WHICH plan an org is on; `organizations.enabled_modules`
 * (migration 0072, see org-modules.ts) is the separate, already-real
 * RESOLVED entitlement state a plan assignment will end up writing to. When
 * plans exist, assigning one is "write plan_id + write the plan's module
 * set to enabled_modules" — this file's job stays just resolving
 * `plan_id -> what's included`.
 */
export const OrgPlan = z.enum(["legacy"]);
export type OrgPlan = z.infer<typeof OrgPlan>;

export function orgPlanIncludesWhatsapp(_planId: string | null): boolean {
  return true;
}
