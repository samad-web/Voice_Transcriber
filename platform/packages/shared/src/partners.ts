import { z } from "zod";

/**
 * Channel partners and the portal they sign into (Build docs/39 §17-§19).
 *
 * Pure: no I/O, no env, no database. Every value here is transcribed from a
 * CHECK constraint in migration 0162, and `partners.test.ts` beside this file
 * asserts the two sets are EQUAL rather than merely overlapping - the drift
 * `notifications.kind` and `messaging_opt_outs.channel` have both already paid
 * for, in both directions at once, where the failure is a 23514 at runtime that
 * reads like a bug in the caller.
 *
 * ⚠ NOT EXPORTED FROM `index.ts` YET. This phase does not own that barrel, so
 * importers use the subpath - `@aura/shared/dist/partners` - exactly as
 * `apps/api/src/common/console-phone.ts` does for `phone`. Adding the
 * `export * from "./partners";` line is a one-line follow-up.
 */

// ── vocabulary, verbatim from 0162's CHECKs ────────────────────────────────

/**
 * What kind of relationship this is. Not cosmetic: it is what the console
 * groups the roster by, and what a tenant means when they say "our dealers"
 * rather than "our brokers". No behaviour hangs off it - a reseller and a
 * referrer reach exactly the same five screens - which is deliberate, because
 * a per-kind portal would be four portals to keep working.
 */
export const PartnerKind = z.enum(["broker", "dealer", "referrer", "reseller"]);
export type PartnerKind = z.infer<typeof PartnerKind>;

/**
 * `pending` is a partner the tenant has created but not let in yet; `active` is
 * the only status `PartnerScopeGuard` admits. `suspended` and `terminated` both
 * close the portal and differ only in intent - one is a pause, the other is the
 * end - which matters because there is no DELETE: removing a partner would take
 * the tenant's own record of where a year of leads came from with it.
 */
export const PartnerStatus = z.enum(["pending", "active", "suspended", "terminated"]);
export type PartnerStatus = z.infer<typeof PartnerStatus>;

/** The partner's OWN hierarchy, which has nothing to do with the tenant's roles. */
export const PartnerUserRole = z.enum(["owner", "member"]);
export type PartnerUserRole = z.infer<typeof PartnerUserRole>;

/**
 * ── THE COARSE OUTCOME, AND WHY IT IS THE POINT OF THE WHOLE PHASE ─────────
 *
 * Four values, and the temptation every single time will be to make it five,
 * or to map it onto `leads.stage` "just for the accepted ones". Do not.
 *
 * A tenant's lead stages say what is happening inside their business:
 * contacted, qualified, quoted, negotiating, lost. A broker who can watch that
 * ladder for every prospect they ever referred knows which of the tenant's
 * deals are stalling, which are about to close and what each is worth - for a
 * customer list they did not buy and a pipeline they do not own. The first
 * tenant who works that out is the last tenant who uses the portal, and they
 * will be right.
 *
 * So these four are statements the TENANT chooses to make, not facts leaking
 * out of the CRM. `converted` is the only one with money behind it and it is
 * still a flag, not a figure.
 */
export const PartnerSubmissionOutcome = z.enum(["submitted", "accepted", "rejected", "converted"]);
export type PartnerSubmissionOutcome = z.infer<typeof PartnerSubmissionOutcome>;

/** What the portal and the tenant's queue both print. */
export const PARTNER_SUBMISSION_OUTCOME_LABELS: Record<PartnerSubmissionOutcome, string> = {
  submitted: "Submitted",
  accepted: "Accepted",
  rejected: "Not taken forward",
  converted: "Converted",
};

/**
 * Which outcome may follow which.
 *
 * `submitted` is the only state anything may leave freely. `rejected` is
 * terminal - re-opening a referral the tenant already declined would let
 * somebody quietly reverse a commercial decision weeks later, and the honest
 * way to change your mind about a lead is a new submission. `accepted` may
 * still convert; `converted` is terminal because a commission has been earned
 * against it.
 *
 * Expressed here rather than as a CHECK because a transition rule needs the OLD
 * value, which a column constraint cannot see, and a trigger for it would put
 * the same decision in a second place.
 */
const OUTCOME_TRANSITIONS: Record<PartnerSubmissionOutcome, readonly PartnerSubmissionOutcome[]> = {
  submitted: ["accepted", "rejected"],
  accepted: ["converted", "rejected"],
  rejected: [],
  converted: [],
};

export function mayMoveOutcome(
  from: PartnerSubmissionOutcome,
  to: PartnerSubmissionOutcome,
): boolean {
  return OUTCOME_TRANSITIONS[from].includes(to);
}

/** Terminal outcomes - nothing follows them. Drives the console's disabled buttons. */
export function isTerminalOutcome(outcome: PartnerSubmissionOutcome): boolean {
  return OUTCOME_TRANSITIONS[outcome].length === 0;
}

// ── intake ────────────────────────────────────────────────────────────────

/**
 * The `lead_sources.name` every partner submission is attributed to.
 *
 * ONE source for all of a tenant's partners, not one per partner. A source is a
 * CHANNEL in the console's Lead sources list and a tenant with forty brokers
 * does not want forty rows there - the same call `ensureManagedSource` already
 * makes for Meta and LinkedIn. Which partner sent a given lead is
 * `partner_submissions`' job, and it rides on `leads.facts` besides.
 *
 * Matched case- and whitespace-insensitively by `lead_sources`' unique index,
 * so changing this string after a tenant has used it creates a SECOND source
 * and splits their attribution. It is effectively frozen.
 */
export const PARTNER_LEAD_SOURCE_NAME = "Channel partners";

/** The bell's title when a partner submits. Kept here so the API and any
 *  future digest word it the same way. */
export function partnerSubmissionTitle(partnerName: string): string {
  return `${partnerName} submitted a lead`;
}

// ── the portal ────────────────────────────────────────────────────────────

/**
 * Five screens, and the portal's value is that it is five (§19).
 *
 * This list is the nav. It is exported rather than written into the layout so
 * that a sixth entry is a change to a file with this comment at the top of it,
 * which is the only brake that has ever worked on a surface like this. Every
 * screen a tenant asks for here - "can they see the call recording", "can they
 * see the stage", "can they see the other brokers' numbers" - is a request to
 * hand a third party part of the tenant's own business, and the answer is a
 * Report Builder dataset the TENANT sends, not a page in the broker's portal.
 */
export interface PortalScreen {
  href: string;
  label: string;
  /** What it is for, in the words the empty state uses. */
  blurb: string;
}

export const PORTAL_SCREENS: readonly PortalScreen[] = [
  { href: "/portal", label: "Submit a lead", blurb: "Send a new referral." },
  { href: "/portal/submissions", label: "My submissions", blurb: "Everything you have sent, and what came of it." },
  { href: "/portal/commissions", label: "My commissions", blurb: "The rate you are on, and what has converted." },
  { href: "/portal/resources", label: "Resources", blurb: "Brochures, price lists and anything else shared with you." },
  { href: "/portal/profile", label: "Profile", blurb: "Your details and the people on your account." },
];

/**
 * Is this path inside the portal?
 *
 * The web tier's mirror of `PartnerScopeGuard.PORTAL_PATH`. Anchored, and
 * `(/|$)` rather than a bare `startsWith` so a future `/portalsomething` route
 * cannot inherit portal treatment by name.
 */
export function isPortalPath(pathname: string): boolean {
  return /^\/portal(\/|$)/.test(pathname);
}
