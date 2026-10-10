import { z } from "zod";
import { FINANCE_DEFAULTS } from "./finance";

/**
 * The Finance Advisor's rule catalogue, routing and alert lifecycle
 * (Build docs/finance-section-build-plan §12.4, §12.5, §12.6).
 *
 * ── THE CATALOGUE IS DATA, THE DETECTORS ARE SQL ────────────────────────────
 *
 * Each of §12.4's seventeen rules is a row in `ADVISOR_RULES` here and a
 * detector function in the worker. The split is deliberate: the catalogue is
 * what the console renders (name, severity, who it routes to, the params an
 * owner may edit) and what migration 0177 seeds into `advisor_rules`, while
 * the detector is the query that finds the subjects. A rule whose params live
 * in the detector cannot be tuned by an owner, and a rule whose severity lives
 * in the console disagrees with the one the worker stored.
 *
 * ── NOTHING HERE SENDS, AND NOTHING HERE ASKS A MODEL ───────────────────────
 *
 * §12's MUST: "rules and statistics decide; language only explains. No LLM
 * call may create, suppress or re-rank an alert." Every function in this file
 * is pure. `renderMessage` substitutes into a template string and is the only
 * text production in the module - there is no model call under `finance/` at
 * all.
 *
 * §12.5's "notify-only by default" is the other half: the Advisor raises an
 * in-app notification and a task for a member of STAFF. It has no code path
 * that messages a customer and none that moves money, which keeps this repo's
 * standing rule ("nothing automated sends") true for the finance module too.
 */

export const AdvisorSeverity = z.enum(["low", "medium", "high", "critical"]);
export type AdvisorSeverity = z.infer<typeof AdvisorSeverity>;

export const SEVERITY_ORDER: Record<AdvisorSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Who an alert goes to. §12.5: "the assignee is the person closest to the
 * money."
 *
 * These are the console PERSONAS (`memberships.owner_role`), not the five
 * `memberships.role` tiers - because routing is about which desk somebody sits
 * at. `finance_handler` is the one value with no persona of its own: it
 * resolves to whoever holds `finance:edit`, falling back to the owners. See
 * DECISIONS.md §3.3 for why a sixth persona was not added.
 */
export const AdvisorRoute = z.enum(["telecaller", "manager", "owner", "finance_handler"]);
export type AdvisorRoute = z.infer<typeof AdvisorRoute>;

/** How often a rule's detector runs. §12.1: hourly for dues, nightly for statistics. */
export const AdvisorSchedule = z.enum(["hourly", "nightly", "on_event"]);
export type AdvisorSchedule = z.infer<typeof AdvisorSchedule>;

export const AdvisorRuleCode = z.enum([
  "closed_unpaid",
  "slipped_promise",
  "aging_breach",
  "unmatched_money",
  "settlement_mismatch",
  "fee_drift",
  "failed_not_retried",
  "refund_spike",
  "duplicate_expense",
  "expense_outlier",
  "discount_abuse",
  "negative_roi_source",
  "call_cost_no_results",
  "incentive_not_clawed_back",
  "idle_spend",
  "cash_runway_low",
  "connector_unhealthy",
  // ── The compliance calendar and document vault
  // (Build docs/indian-business-finance-documents-cycles-import §2)
  //
  // §2's last bullet: "Reminders through the Advisor, using the same routing
  // and escalation as the leak alerts." These five are therefore rules in this
  // catalogue rather than a second reminder mechanism - they get the same
  // dedupe window, the same snooze, the same escalation ladder and the same
  // explain panel, and `advisor_alerts.rule_code` is free text so they needed
  // no migration to exist.
  //
  // They are the only rules here that are not about money already lost. A
  // missed GST return costs interest and a penalty, which is money about to be
  // lost - the same inbox is the right place for both.
  "compliance_due",
  "compliance_overdue",
  "document_expiring",
  "document_expired",
  "books_not_closed",
]);
export type AdvisorRuleCode = z.infer<typeof AdvisorRuleCode>;

export interface AdvisorRuleSpec {
  code: AdvisorRuleCode;
  /** What an owner reads in the rules list. Phrased as the problem, not the test. */
  label: string;
  /** The one line under it: what fires this, in the words of the business. */
  blurb: string;
  severity: AdvisorSeverity;
  schedule: AdvisorSchedule;
  routeTo: AdvisorRoute;
  /** §12.5's ladder for this rule, starting from `routeTo`. */
  escalationPath: AdvisorRoute[];
  /** §12.4's default params, editable per org. */
  params: Record<string, number>;
  /**
   * True when the rule is a STATISTICAL test and must therefore stay silent
   * below `minStatisticalSample` (§12.4). Read by the worker, and by the
   * console to explain why a rule it has enabled has produced nothing.
   */
  statistical: boolean;
  /** §12.4: "message_template". `{placeholder}`s are filled by `renderMessage`. */
  messageTemplate: string;
  /** §12.4: "recommended_action". One imperative sentence for the assignee. */
  recommendedAction: string;
  /** Whether an alert should estimate ₹ at risk. Some rules have no amount. */
  carriesAmount: boolean;
}

/**
 * §12.4's table, verbatim in its defaults and its routing.
 *
 * ── WHY `enabled` IS NOT HERE ──────────────────────────────────────────────
 *
 * Every rule ships ENABLED; the column that turns one off lives on
 * `advisor_rules`, per org. A `defaultEnabled: false` in this catalogue would
 * mean a rule nobody ever sees - the owner would have to know it existed to
 * find the switch - and §12's premise is that the Advisor tells you about
 * money you are losing without being asked first.
 *
 * The one brake on that is that every statistical rule refuses to speak until
 * it has eight periods, so a new tenant's first weeks are quiet by
 * construction rather than by configuration.
 */
export const ADVISOR_RULES: readonly AdvisorRuleSpec[] = [
  {
    code: "closed_unpaid",
    label: "Deal closed, no money in",
    blurb: "A deal was marked won and nothing has been received since.",
    severity: "high",
    schedule: "hourly",
    routeTo: "telecaller",
    escalationPath: ["telecaller", "manager"],
    params: { days: 3 },
    statistical: false,
    messageTemplate: "{customer} closed {days} days ago and nothing has been received.",
    recommendedAction: "Call the customer and agree a payment date.",
    carriesAmount: true,
  },
  {
    code: "slipped_promise",
    label: "Promised date passed",
    blurb: "Somebody promised to pay on a date and the date has gone by.",
    severity: "medium",
    schedule: "hourly",
    routeTo: "telecaller",
    escalationPath: ["telecaller", "manager", "owner"],
    params: { graceDays: 1 },
    statistical: false,
    messageTemplate: "Payment of {amount} from {customer} promised for {date} not received.",
    recommendedAction: "Call the customer and record a new promise date.",
    carriesAmount: true,
  },
  {
    code: "aging_breach",
    label: "Dues crossed into an older bucket",
    blurb: "Money owed has aged past 30, 60 or 90 days.",
    severity: "high",
    schedule: "nightly",
    routeTo: "finance_handler",
    escalationPath: ["finance_handler", "manager", "owner"],
    params: { bucketDays: 30 },
    statistical: false,
    messageTemplate: "{amount} from {customer} is now {days} days past due.",
    recommendedAction: "Decide whether to chase, restructure or write this off.",
    carriesAmount: true,
  },
  {
    code: "unmatched_money",
    label: "Money received, nobody knows for what",
    blurb: "A payment arrived and is not linked to any deal.",
    severity: "high",
    schedule: "hourly",
    routeTo: "finance_handler",
    escalationPath: ["finance_handler", "owner"],
    params: { ageHours: 24 },
    statistical: false,
    messageTemplate: "{amount} received {date} is still not linked to a deal.",
    recommendedAction: "Open the unmatched queue and link it, or split it across items.",
    carriesAmount: true,
  },
  {
    code: "settlement_mismatch",
    label: "Bank credited a different amount",
    blurb: "What the gateway said it settled is not what the bank credited.",
    severity: "critical",
    schedule: "nightly",
    routeTo: "finance_handler",
    escalationPath: ["finance_handler", "owner"],
    params: { toleranceMinor: FINANCE_DEFAULTS.settlementToleranceMinor },
    statistical: false,
    messageTemplate: "Settlement on {date}: gateway said {expected}, bank credited {actual}.",
    recommendedAction: "Reconcile against the gateway's settlement report and raise a ticket.",
    carriesAmount: true,
  },
  {
    code: "fee_drift",
    label: "Gateway is taking a bigger cut",
    blurb: "The gateway's fee percentage has drifted above its own trailing average.",
    severity: "medium",
    schedule: "nightly",
    routeTo: "owner",
    escalationPath: ["owner"],
    params: { percentagePoints: 0.3 },
    statistical: true,
    messageTemplate: "Gateway fees are {current}% of collections, up from {baseline}%.",
    recommendedAction: "Check the pricing on your gateway account against the contract.",
    carriesAmount: true,
  },
  {
    code: "failed_not_retried",
    label: "Failed payment, nobody followed up",
    blurb: "A payment attempt failed and nothing has been tried since.",
    severity: "medium",
    schedule: "hourly",
    routeTo: "telecaller",
    escalationPath: ["telecaller", "manager"],
    params: { days: 2 },
    statistical: false,
    messageTemplate: "{customer}'s payment of {amount} failed {days} days ago - no retry since.",
    recommendedAction: "Send a fresh payment link, or take the payment another way.",
    carriesAmount: true,
  },
  {
    code: "refund_spike",
    label: "Refunds are up",
    blurb: "The refund or chargeback rate is above this business's own baseline.",
    severity: "high",
    schedule: "nightly",
    routeTo: "manager",
    escalationPath: ["manager", "owner"],
    params: { z: 2.5 },
    statistical: true,
    messageTemplate: "Refund rate is {current}% against a baseline of {baseline}%.",
    recommendedAction: "Listen to a sample of the refunded customers' calls.",
    carriesAmount: true,
  },
  {
    code: "duplicate_expense",
    label: "Same bill entered twice",
    blurb: "The same vendor and amount within a few days of each other.",
    severity: "medium",
    schedule: "nightly",
    routeTo: "finance_handler",
    escalationPath: ["finance_handler"],
    params: { withinDays: 7 },
    statistical: false,
    messageTemplate: "{vendor} appears twice for {amount} within {days} days.",
    recommendedAction: "Check both entries and reverse one if it is the same bill.",
    carriesAmount: true,
  },
  {
    code: "expense_outlier",
    label: "A category spent unusually",
    blurb: "This category's spend is far from what is normal for it here.",
    severity: "medium",
    schedule: "nightly",
    routeTo: "manager",
    escalationPath: ["manager", "owner"],
    params: { modifiedZ: 3.5 },
    statistical: true,
    messageTemplate: "{category} spend of {amount} is well outside its usual range.",
    recommendedAction: "Confirm the invoice is right and the category is right.",
    carriesAmount: true,
  },
  {
    code: "discount_abuse",
    label: "Discounts above policy",
    blurb: "Someone is closing deals at a discount above the policy limit.",
    severity: "medium",
    schedule: "nightly",
    routeTo: "manager",
    escalationPath: ["manager", "owner"],
    params: { policyPercent: 10 },
    statistical: false,
    messageTemplate: "{person} has closed {count} deals above the {policy}% discount limit.",
    recommendedAction: "Review those deals, then decide whether the limit or the behaviour changes.",
    carriesAmount: true,
  },
  {
    code: "negative_roi_source",
    label: "A lead source costs more than it earns",
    blurb: "Over several weeks, a source's cost is above the revenue it produced.",
    severity: "high",
    schedule: "nightly",
    routeTo: "owner",
    escalationPath: ["owner"],
    params: { weeks: 4 },
    statistical: false,
    messageTemplate: "{source} cost {cost} and produced {revenue} over {weeks} weeks.",
    recommendedAction: "Cut, re-target or re-price this source.",
    carriesAmount: true,
  },
  {
    code: "call_cost_no_results",
    label: "Calling more, closing the same",
    blurb: "Call spend is up while conversions are flat or down.",
    severity: "medium",
    schedule: "nightly",
    routeTo: "manager",
    escalationPath: ["manager", "owner"],
    params: { periods: 2 },
    statistical: true,
    messageTemplate: "Call spend up {spendChange}% with conversions {conversionChange}%.",
    recommendedAction: "Check the call list quality and the scripts before buying more minutes.",
    carriesAmount: true,
  },
  {
    code: "incentive_not_clawed_back",
    label: "Paid incentive on refunded money",
    blurb: "A sale was refunded and the incentive on it was never reversed.",
    severity: "high",
    schedule: "nightly",
    routeTo: "finance_handler",
    escalationPath: ["finance_handler", "owner"],
    params: { windowDays: 90 },
    statistical: false,
    messageTemplate: "{person} was paid {amount} on a sale that was refunded on {date}.",
    recommendedAction: "Run the clawback for the current period.",
    carriesAmount: true,
  },
  {
    code: "idle_spend",
    label: "Paying for something nobody uses",
    blurb: "A recurring subscription or seat with no usage for a month.",
    severity: "low",
    schedule: "nightly",
    routeTo: "owner",
    escalationPath: ["owner"],
    params: { unusedDays: 30 },
    statistical: false,
    messageTemplate: "{vendor} has cost {amount} with no usage for {days} days.",
    recommendedAction: "Cancel it or reassign the seats.",
    carriesAmount: true,
  },
  {
    code: "cash_runway_low",
    label: "Cash is going to run short",
    blurb: "The forecast balance drops below your minimum within the horizon.",
    severity: "critical",
    schedule: "nightly",
    routeTo: "owner",
    escalationPath: ["owner"],
    params: { minimumCashMinor: 0, horizonDays: 30 },
    statistical: false,
    messageTemplate: "Forecast balance reaches {trough} on {date}, below your {minimum} floor.",
    recommendedAction: "Pull collections forward, or defer what can be deferred.",
    carriesAmount: true,
  },
  {
    code: "connector_unhealthy",
    label: "A payment connector has gone quiet",
    blurb: "No events for a day, or repeated failures.",
    severity: "high",
    schedule: "hourly",
    routeTo: "owner",
    escalationPath: ["owner"],
    params: { silentHours: 24, failures: 5 },
    statistical: false,
    messageTemplate: "{connector} last delivered an event {date} and has {failures} failures.",
    recommendedAction: "Re-authenticate it, then replay the failed events.",
    carriesAmount: false,
  },

  // ── Compliance and documents ──────────────────────────────────────────────
  {
    code: "compliance_due",
    label: "A filing is coming due",
    blurb: "A return or payment on the compliance calendar has reached one of its reminder days.",
    severity: "medium",
    // Nightly, not hourly. A reminder is a day-grained thing - `remindsToday`
    // matches an exact date - and an hourly sweep would raise the same
    // reminder twenty-four times or have to carry its own hour-level dedupe.
    schedule: "nightly",
    routeTo: "finance_handler",
    escalationPath: ["finance_handler", "owner"],
    // Not a threshold: each item carries its own `reminder_offsets`, which a
    // CA can edit. This is only the fallback for an item whose offsets were
    // cleared, so a filing with no offsets still gets one warning.
    params: { fallbackDays: 7 },
    statistical: false,
    messageTemplate: "{name} for {period} is due on {date} ({days} days away).",
    recommendedAction: "File it, then attach the challan or acknowledgement to the filing.",
    carriesAmount: false,
  },
  {
    code: "compliance_overdue",
    label: "A filing is overdue",
    blurb: "A return or payment is past its due date and has not been marked filed.",
    severity: "critical",
    schedule: "nightly",
    routeTo: "finance_handler",
    escalationPath: ["finance_handler", "manager", "owner"],
    // Re-raised weekly rather than nightly, so a return that is genuinely
    // waiting on a CA does not produce thirty identical alerts in a month.
    params: { repeatEveryDays: 7 },
    statistical: false,
    messageTemplate: "{name} for {period} was due on {date} and is {days} days overdue.",
    recommendedAction: "File it now, or mark it not applicable if it does not apply to this business.",
    carriesAmount: false,
  },
  {
    code: "document_expiring",
    label: "A document is about to expire",
    blurb: "A licence, policy or agreement in the vault has reached one of its reminder days.",
    severity: "medium",
    schedule: "nightly",
    // The owner, not the finance handler: renewing a trade licence or an
    // insurance policy is a decision somebody has to make, not a filing
    // somebody has to submit.
    routeTo: "owner",
    escalationPath: ["owner"],
    params: { fallbackDays: 30 },
    statistical: false,
    messageTemplate: "{name} expires on {date} ({days} days away).",
    recommendedAction: "Renew it and upload the new copy as a new version.",
    carriesAmount: false,
  },
  {
    code: "document_expired",
    label: "A document has expired",
    blurb: "Something in the vault is past its expiry date and no newer version has been uploaded.",
    severity: "high",
    schedule: "nightly",
    routeTo: "owner",
    escalationPath: ["owner"],
    params: { repeatEveryDays: 14 },
    statistical: false,
    messageTemplate: "{name} expired on {date}, {days} days ago.",
    recommendedAction: "Upload the renewed document, or clear the expiry date if it no longer applies.",
    carriesAmount: false,
  },
  {
    code: "books_not_closed",
    label: "Last month's books are still open",
    blurb: "A month ended and the close checklist has not been finished or the period locked.",
    severity: "medium",
    schedule: "nightly",
    routeTo: "finance_handler",
    escalationPath: ["finance_handler", "owner"],
    // Ten days, not one: §2 puts bank reconciliation and GST payment inside
    // the month-end rhythm, and the earliest of those deadlines is the 7th.
    // Nagging on the 1st would be nagging about work that is not yet due.
    params: { graceDays: 10, repeatEveryDays: 7 },
    statistical: false,
    messageTemplate: "{period} is not closed: {done} of {total} checklist steps done.",
    recommendedAction: "Finish the close checklist, then lock the period.",
    carriesAmount: false,
  },
];

const RULE_BY_CODE = new Map(ADVISOR_RULES.map((r) => [r.code, r]));

export function advisorRule(code: AdvisorRuleCode): AdvisorRuleSpec {
  const spec = RULE_BY_CODE.get(code);
  if (!spec) throw new Error(`unknown advisor rule: ${code}`);
  return spec;
}

/** The statistical rules, which stay silent below the minimum sample (§12.4). */
export const STATISTICAL_RULES: readonly AdvisorRuleCode[] = ADVISOR_RULES.filter(
  (r) => r.statistical,
).map((r) => r.code);

// ─────────────────────────────────────────────────────────────────────────────
// §12.5 lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export const AlertStatus = z.enum(["open", "acknowledged", "resolved", "dismissed"]);
export type AlertStatus = z.infer<typeof AlertStatus>;

/**
 * §12.5's lifecycle: `open → acknowledged → resolved | dismissed → reopened if
 * the condition returns`.
 *
 * "Reopened" is not a fifth status - it is `open` again, with an
 * `alert_events` row saying so. A separate status would make every query that
 * asks "what is outstanding" have to know about two values meaning the same
 * thing, which is the shape of bug that leaves real alerts out of the inbox.
 */
export const ALERT_MOVES: Record<AlertStatus, readonly AlertStatus[]> = {
  open: ["acknowledged", "resolved", "dismissed"],
  acknowledged: ["resolved", "dismissed"],
  // A detector that still finds the condition reopens a resolved alert. A
  // DISMISSED one is a decision a person made, and the detector must not
  // overrule it - see `shouldReopen`.
  resolved: ["open"],
  dismissed: ["open"],
};

export const AlertEventKind = z.enum([
  "opened",
  "ack",
  "escalated",
  "resolved",
  "reopened",
  "dismissed",
  "snoozed",
  "notified",
]);
export type AlertEventKind = z.infer<typeof AlertEventKind>;

export function alertMovable(from: AlertStatus, to: AlertStatus): boolean {
  return ALERT_MOVES[from].includes(to);
}

/**
 * §12.5: "de-duplication (one open alert per rule+subject)".
 *
 * The key is `{rule}:{subject}`, and `subject_ref` is the id of whatever the
 * rule is about - a schedule item, a payment, an expense, a connector, a
 * source, a person. Unique-indexed in 0177 over the OPEN statuses only, so a
 * resolved alert does not block the same problem recurring next month.
 */
export function alertDedupeKey(code: AdvisorRuleCode, subjectRef: string): string {
  return `${code}:${subjectRef}`;
}

/**
 * Whether a detector that still sees the condition should reopen an alert.
 *
 * ── A DISMISSAL IS A DECISION, NOT A SNOOZE ────────────────────────────────
 *
 * `dismissed` means a person looked and said "this is not a problem". A
 * detector reopening it the same night would make the dismiss button a lie and
 * teach everybody to ignore the inbox - which is the failure mode §12.5's
 * feedback loop exists to prevent. So a dismissal holds for
 * `dismissalHoldDays`, and what the repeat dismissals DO is feed the threshold
 * suggestion ("dismissed 8 times; raise the limit?") that the owner approves.
 *
 * A RESOLVED alert reopens freely: resolved means "I fixed it", and the
 * condition coming back means it was not fixed.
 */
export function shouldReopen(
  alert: { status: AlertStatus; lastEventAt: Date; dismissCount: number },
  now: Date,
  dismissalHoldDays = 30,
): boolean {
  if (alert.status === "open" || alert.status === "acknowledged") return false;
  if (alert.status === "resolved") return true;
  const heldMs = dismissalHoldDays * 86_400_000;
  return now.getTime() - alert.lastEventAt.getTime() > heldMs;
}

/**
 * §12.5's feedback loop: a threshold change SUGGESTED after repeated
 * dismissals, never applied.
 *
 * Returns null below the count. The returned suggestion is advisory text plus
 * the proposed param - the console shows it with an Approve button, and
 * nothing in the worker may apply one. "Thresholds are never changed
 * silently" is the spec's wording and the reason this returns a suggestion
 * object rather than performing an update.
 */
export interface ThresholdSuggestion {
  code: AdvisorRuleCode;
  param: string;
  from: number;
  to: number;
  dismissCount: number;
  reason: string;
}

export function suggestThreshold(
  code: AdvisorRuleCode,
  params: Record<string, number>,
  dismissCount: number,
  minimumDismissals = 8,
): ThresholdSuggestion | null {
  if (dismissCount < minimumDismissals) return null;
  const spec = advisorRule(code);
  // The first param is the rule's own threshold by construction - §12.4's
  // table gives each rule one knob that decides whether it fires.
  const param = Object.keys(spec.params)[0];
  if (!param) return null;
  const from = params[param] ?? spec.params[param];
  // A 50% loosening, in the direction that makes the rule quieter. Always the
  // same multiple, so a suggestion is predictable rather than a model's guess.
  const to = Math.round(from * 1.5 * 100) / 100;
  return {
    code,
    param,
    from,
    to,
    dismissCount,
    reason: `Dismissed ${dismissCount} times without action. Raise ${param} from ${from} to ${to}?`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.5 escalation and quiet hours
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far up the ladder an unacknowledged alert has climbed, in hours.
 *
 * Returns the route it should now sit with, or null when it is already at the
 * top of its own path. The thresholds are §15's 24 h → manager, 48 h → owner,
 * and they are measured from `first_seen_at` rather than the last escalation:
 * an alert nobody has touched for three days is three days old, not one day
 * past its second escalation.
 */
export function escalationTarget(
  spec: AdvisorRuleSpec,
  hoursOpen: number,
  escalationHours: readonly number[] = FINANCE_DEFAULTS.escalationHours,
): AdvisorRoute | null {
  let step = 0;
  for (const threshold of escalationHours) {
    if (hoursOpen >= threshold) step += 1;
  }
  if (step === 0) return null;
  const target = spec.escalationPath[Math.min(step, spec.escalationPath.length - 1)];
  // A rule whose path is one entry long (an owner-only rule) has nowhere to
  // climb to. Returning its own route would re-notify the owner every sweep.
  return target === spec.routeTo ? null : target;
}

/**
 * §12.5/§15's quiet hours: 21:00-08:00 in the org's own timezone.
 *
 * ── QUIET HOURS DELAY DELIVERY, NOT DETECTION ──────────────────────────────
 *
 * The detector still runs and the alert is still created - an owner opening
 * the console at 23:00 should see what is wrong. What quiet hours suppress is
 * the PUSH: the notification, the WhatsApp, the phone popup. Suppressing
 * detection instead would mean an alert found at 21:05 is not found at all.
 *
 * `hour` is the local hour in the org's reporting timezone, which the caller
 * reads from the transaction's own clock (`withOrgContext` sets `TimeZone`).
 */
export function inQuietHours(
  hour: number,
  quiet: { from: number; to: number } = FINANCE_DEFAULTS.quietHours,
): boolean {
  // The window wraps midnight, so this is an OR rather than a range check -
  // the mistake that makes 21:00-08:00 match nothing.
  if (quiet.from === quiet.to) return false;
  return quiet.from > quiet.to ? hour >= quiet.from || hour < quiet.to : hour >= quiet.from && hour < quiet.to;
}

/**
 * §12.5's due reminders: T-3, T0, T+3, T+7 relative to the due date.
 *
 * Returns the offsets that are DUE as of `today` and have not been sent yet.
 * Driven off what was already sent rather than off a schedule table, so a
 * worker that was down for two days catches up in one tick instead of skipping
 * the rungs it missed - the same reasoning `call-reminders.ts` records.
 */
export function dueRemindersOwing(
  dueDate: string,
  today: string,
  alreadySent: readonly number[],
  offsets: readonly number[] = FINANCE_DEFAULTS.reminderOffsetDays,
): number[] {
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000,
  );
  return offsets.filter((offset) => offset <= days && !alreadySent.includes(offset));
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.4/§12.6 the explain payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §12.6's explain panel, as the shape stored in `advisor_alerts.explain`.
 *
 * ── WHY THE FORMULA IS A STRING IN THE ROW ─────────────────────────────────
 *
 * §12 requires that an alert "show the rule that fired, the calculation, and
 * links to the underlying records". The calculation has to be stored, not
 * recomputed at read time, because the data moves: an alert raised when a
 * category's median was ₹40,000 must still explain itself next month when the
 * median is ₹60,000. An explain panel that recomputes is an explain panel that
 * eventually contradicts the alert it belongs to.
 */
export const AlertExplain = z.object({
  /** The human-readable test, with the numbers substituted in. */
  formula: z.string(),
  /** The named inputs, so the panel can table them. */
  inputs: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  /** Where to drill to. `{ type, id, label }` per record. */
  records: z
    .array(z.object({ type: z.string(), id: z.string(), label: z.string().optional() }))
    .default([]),
  /** Set when a statistical rule DID NOT fire, so silence is explainable too. */
  silentBecause: z.string().nullable().default(null),
  /** The sample the statistics used, for the rules that use one. */
  sampleSize: z.number().int().nullable().default(null),
});
export type AlertExplain = z.infer<typeof AlertExplain>;

/**
 * Fill a rule's `messageTemplate`.
 *
 * `{placeholder}`s with no value are left as-is rather than replaced with
 * "undefined": a template drifting from its detector should read as an obvious
 * bug in the inbox, not as a sentence that looks finished and is wrong.
 */
export function renderMessage(
  template: string,
  values: Record<string, string | number | null | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? whole : String(value);
  });
}

/**
 * §12.6's money-leak report: alerts ranked by estimated ₹/month at risk.
 *
 * Severity breaks the tie, not the other way round. A ₹4,00,000 aging breach
 * outranks a ₹2,000 critical settlement mismatch, because the report's whole
 * job is to answer "where is the money going" - and a rule's severity is a
 * statement about urgency, which is the second question.
 */
export function rankLeaks<T extends { amountAtRiskMinor: number | null; severity: AdvisorSeverity }>(
  alerts: readonly T[],
): T[] {
  return [...alerts].sort(
    (a, b) =>
      (b.amountAtRiskMinor ?? 0) - (a.amountAtRiskMinor ?? 0) ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}
