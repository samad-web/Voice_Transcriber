import { z } from "zod";

/**
 * Staff - a person's employment by ONE workspace (migration 0102).
 *
 * ── THE THREE IDENTITIES, AND WHY THEY ARE NOT ONE ──────────────────────────
 *
 * Anybody reading the performance scorecard has to hold three things apart,
 * and every metric in this product is keyed on one of them:
 *
 *   users            a HUMAN, across every tenant they belong to. Tasks,
 *                    messages and stage moves point here.
 *   memberships      that human's EMPLOYMENT by one org: their persona, their
 *                    permission role, their staff code, whether they are
 *                    suspended. This file is about this row.
 *   telecallers      a PHONE-SIDE identity, bound to a handset. Calls, leads
 *                    and deals point here (`telecaller_id`), and it exists
 *                    whether or not the person has a login at all.
 *
 * `telecallers.user_id` is the only bridge, it is nullable, and on live tenants
 * it is mostly null. That is not a data-quality problem to be cleaned up - it
 * is the real shape of a phone floor, where handsets were named long before
 * anybody was given a console account. Every surface that reports on "staff"
 * has to say which of the three it means and what it does about the gap; see
 * `StaffScorecardRow` below, which refuses to print a zero it cannot justify.
 */

/**
 * active | suspended.
 *
 * Suspension stops a person signing in. It does NOT reassign their work, and
 * that separation is the whole point: today the only way to stop somebody
 * reaching the console is to delete their login, which leaves every lead, call
 * and follow-up they were working pointing at an account that no longer exists.
 */
export const StaffStatus = z.enum(["active", "suspended"]);
export type StaffStatus = z.infer<typeof StaffStatus>;

export const STAFF_STATUS_LABELS: Record<StaffStatus, string> = {
  active: "Active",
  suspended: "Suspended",
};

/** The employment fields an owner may edit on somebody's staff record. */
export const StaffProfileInput = z.object({
  /**
   * The business's own identifier. Trimmed, and empty means "clear it" rather
   * than "set it to an empty string" - a unique index over empty strings would
   * let exactly one person hold a blank code and refuse the second.
   */
  staffCode: z.string().trim().max(40).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  jobTitle: z.string().trim().max(120).nullable().optional(),
});
export type StaffProfileInput = z.infer<typeof StaffProfileInput>;

/**
 * One row of the performance scorecard.
 *
 * ── WHY SO MANY FIELDS ARE NULLABLE ─────────────────────────────────────────
 *
 * `null` here means UNKNOWN and is rendered as a dash. `0` means measured, and
 * measured zero. Collapsing the two is the single most damaging thing this
 * surface could do: a manager reading a scorecard in a review does not stop to
 * ask whether the person was linked to a handset identity - they read "0 calls"
 * as "made no calls", and somebody gets that conversation for a join that was
 * never configured.
 *
 * So: a staff member with no `telecallers` row has `callsMade: null`, not 0.
 * Everything keyed on their `users` row - follow-ups, messages, stage moves -
 * is still a real number, because that half never needed the bridge.
 */
export interface StaffScorecardRow {
  userId: string | null;
  telecallerId: string | null;
  name: string;
  email: string | null;
  staffCode: string | null;
  jobTitle: string | null;
  status: StaffStatus | null;
  ownerRole: string | null;
  /** True when a login and a telecaller identity are bound to each other. */
  linked: boolean;

  // ── Keyed on the telecaller identity. Null when there is none. ──
  callsMade: number | null;
  callsConnected: number | null;
  talkSeconds: number | null;
  leadsAssigned: number | null;
  leadsSourced: number | null;
  leadsWon: number | null;
  medianResponseMinutes: number | null;

  // ── Keyed on the user. Null when there is no login. ──
  followupsCompleted: number | null;
  followupsOverdue: number | null;
  /** completed / (completed + overdue), as a whole percentage. Null when the
   *  denominator is zero - a compliance figure over no promises is not 100%. */
  compliancePct: number | null;
  messagesSent: number | null;
  stageMoves: number | null;
}

/**
 * How the scorecard is sorted. Server-side, because the page paginates nothing
 * and a client sort over a partial list would order the wrong rows - and
 * because "worst first" is the ordering a manager actually opens this for.
 */
export const StaffScorecardSort = z.enum([
  "name",
  "calls",
  "leads",
  "won",
  "compliance",
  "response",
]);
export type StaffScorecardSort = z.infer<typeof StaffScorecardSort>;
