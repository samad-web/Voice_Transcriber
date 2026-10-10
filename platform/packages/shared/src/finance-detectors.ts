import {
  type AdvisorRuleCode,
  type AdvisorRuleSpec,
  type AlertExplain,
  advisorRule,
  renderMessage,
} from "./finance-advisor";
import { MIN_SAMPLE_DEFAULT, driftTest, outlierTest, zScore } from "./finance-stats";
import { daysBetween } from "./finance";
import { formatMoney, percentage } from "./money";
// The compliance and vault deciders below delegate every date judgement to
// these, rather than re-deriving it. A second implementation here is how the
// inbox and the page end up disagreeing about what is overdue.
import { closeReadiness, complianceStatus, daysUntilDue, remindsToday } from "./compliance";
import { daysUntilExpiry, documentExpiryStatus, documentRemindsToday } from "./documents";

/**
 * §12.4's seventeen rules, as PURE decision functions.
 *
 * ── THE SPLIT, AND WHY IT IS THE WHOLE DESIGN ───────────────────────────────
 *
 * Each rule is two halves:
 *
 *   a FINDER   SQL in the worker that pulls candidate rows - overdue
 *              instalments, unmatched payments, this category's last twelve
 *              months of spend.
 *   a DECIDER  a function here that takes one candidate plus the rule's params
 *              and returns fire / do-not-fire, with the explain payload.
 *
 * Everything that DECIDES is in this file, pure, and therefore testable
 * without a database. That matters for three reasons:
 *
 * 1. §14 M8's acceptance criterion is "each seeded rule has a fixture test
 *    that fires it and a test that does not". Thirty-four tests against live
 *    Postgres would be slow, flaky and - worse - would mostly be testing the
 *    SQL's JOINs rather than the rule. Here they test the rule.
 * 2. §12's MUST: "rules and statistics decide; language only explains." A
 *    decider takes no client and can reach no network, so there is no place a
 *    model COULD be consulted. The property is structural rather than a
 *    convention somebody has to remember.
 * 3. §12's "every advisory must be reproducible from data" is literally true:
 *    the same candidate and the same params give the same verdict, the same
 *    message and the same explain payload, forever.
 *
 * ── AND WHY SILENCE IS A RETURN VALUE ───────────────────────────────────────
 *
 * A decider returns `{ fire: false, silentBecause }` rather than null. §12.6's
 * explain panel has to be able to say why a rule did NOT fire - the difference
 * between a quiet inbox somebody trusts and one they suspect is broken - and
 * §12.4 requires statistical rules to "stay silent rather than guess" below
 * the minimum sample, which is a specific kind of silence worth naming.
 */

export interface DetectorVerdict {
  fire: boolean;
  /** Minor units. Null for the rules §12.4 gives no amount. */
  amountAtRiskMinor: number | null;
  /** The rendered sentence, from the rule's own `messageTemplate`. */
  message: string;
  explain: AlertExplain;
  /** Null when it fired. */
  silentBecause: string | null;
}

function silent(
  spec: AdvisorRuleSpec,
  reason: string,
  inputs: AlertExplain["inputs"] = {},
  sampleSize: number | null = null,
): DetectorVerdict {
  return {
    fire: false,
    amountAtRiskMinor: null,
    message: "",
    explain: { formula: spec.label, inputs, records: [], silentBecause: reason, sampleSize },
    silentBecause: reason,
  };
}

function fire(
  spec: AdvisorRuleSpec,
  options: {
    amountAtRiskMinor: number | null;
    values: Record<string, string | number | null>;
    formula: string;
    inputs: AlertExplain["inputs"];
    records?: AlertExplain["records"];
    sampleSize?: number | null;
  },
): DetectorVerdict {
  return {
    fire: true,
    amountAtRiskMinor: options.amountAtRiskMinor,
    message: renderMessage(spec.messageTemplate, options.values),
    explain: {
      formula: options.formula,
      inputs: options.inputs,
      records: options.records ?? [],
      silentBecause: null,
      sampleSize: options.sampleSize ?? null,
    },
    silentBecause: null,
  };
}

const money = (minor: number, currency = "INR") => formatMoney(minor, { currency });

// ─────────────────────────────────────────────────────────────────────────────
// The non-statistical rules (§14 M8 builds these first)
// ─────────────────────────────────────────────────────────────────────────────

export interface ClosedUnpaidCandidate {
  dealId: string;
  dealName: string;
  customerName: string | null;
  closedOn: string;
  scheduledMinor: number;
  collectedMinor: number;
  currency: string;
}

/** `closed_unpaid`: a deal was marked won and nothing has arrived since. */
export function decideClosedUnpaid(
  candidate: ClosedUnpaidCandidate,
  today: string,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("closed_unpaid");
  const days = daysBetween(candidate.closedOn, today);
  const n = params.days ?? spec.params.days;

  if (candidate.collectedMinor > 0) {
    // ANY receipt clears this rule, not a full one. §12.4's test is "no
    // payment after N days" - a customer who has paid a deposit is in a
    // different conversation, and `slipped_promise`/`aging_breach` cover the
    // rest of what they owe.
    return silent(spec, "money has been received against this deal");
  }
  if (days < n) return silent(spec, `only ${days} of ${n} days`);

  return fire(spec, {
    amountAtRiskMinor: candidate.scheduledMinor,
    values: {
      customer: candidate.customerName ?? candidate.dealName,
      days,
      amount: money(candidate.scheduledMinor, candidate.currency),
    },
    formula: `closed ${candidate.closedOn}, ${days} days ago (threshold ${n}); collected 0`,
    inputs: {
      closedOn: candidate.closedOn,
      daysSinceClose: days,
      thresholdDays: n,
      scheduled: candidate.scheduledMinor,
      collected: 0,
    },
    records: [{ type: "deal", id: candidate.dealId, label: candidate.dealName }],
  });
}

export interface SlippedPromiseCandidate {
  scheduleItemId: string;
  dealId: string;
  customerName: string | null;
  promisedOn: string;
  outstandingMinor: number;
  currency: string;
}

/** `slipped_promise`: a promised pay date passed with no receipt. */
export function decideSlippedPromise(
  candidate: SlippedPromiseCandidate,
  today: string,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("slipped_promise");
  const grace = params.graceDays ?? spec.params.graceDays;
  const daysLate = daysBetween(candidate.promisedOn, today);

  if (candidate.outstandingMinor <= 0) return silent(spec, "the instalment has been paid");
  // The grace day is real, not decoration: a customer who said "Friday" and
  // pays on Friday evening has not slipped, and a rule that chased them on
  // Friday morning would be the reason nobody trusts the inbox.
  if (daysLate <= grace) return silent(spec, `within the ${grace}-day grace period`);

  return fire(spec, {
    amountAtRiskMinor: candidate.outstandingMinor,
    values: {
      amount: money(candidate.outstandingMinor, candidate.currency),
      customer: candidate.customerName ?? "This customer",
      date: candidate.promisedOn,
    },
    formula: `promised ${candidate.promisedOn}, ${daysLate} days ago (grace ${grace})`,
    inputs: {
      promisedOn: candidate.promisedOn,
      daysLate,
      graceDays: grace,
      outstanding: candidate.outstandingMinor,
    },
    records: [{ type: "schedule_item", id: candidate.scheduleItemId }],
  });
}

export interface AgingBreachCandidate {
  scheduleItemId: string;
  dealId: string;
  customerName: string | null;
  dueDate: string;
  outstandingMinor: number;
  currency: string;
  /** The highest boundary this item has already been alerted past, or 0. */
  alertedBucketDays: number;
}

/**
 * `aging_breach`: dues cross a bucket boundary (30 / 60 / 90).
 *
 * ── IT FIRES ONCE PER BOUNDARY, NOT ONCE PER DAY ───────────────────────────
 *
 * `alertedBucketDays` is what the caller already told somebody about. Without
 * it the rule is true every day from day 31 to day 60, and the de-duplication
 * index would keep refreshing one alert - which means "crossed into 60 days"
 * never gets raised at all, because the 30-day alert is still open on the same
 * subject. Each boundary is a separate event and this is what makes them so.
 */
export function decideAgingBreach(
  candidate: AgingBreachCandidate,
  today: string,
  _params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("aging_breach");
  const daysLate = daysBetween(candidate.dueDate, today);
  const boundaries = [90, 60, 30];
  const crossed = boundaries.find((b) => daysLate >= b) ?? 0;

  if (candidate.outstandingMinor <= 0) return silent(spec, "paid");
  if (crossed === 0) return silent(spec, `${daysLate} days late - no boundary crossed yet`);
  if (crossed <= candidate.alertedBucketDays) {
    return silent(spec, `already raised at the ${candidate.alertedBucketDays}-day boundary`);
  }

  return fire(spec, {
    amountAtRiskMinor: candidate.outstandingMinor,
    values: {
      amount: money(candidate.outstandingMinor, candidate.currency),
      customer: candidate.customerName ?? "This customer",
      days: daysLate,
    },
    formula: `due ${candidate.dueDate}, ${daysLate} days late - crossed the ${crossed}-day boundary`,
    inputs: {
      dueDate: candidate.dueDate,
      daysLate,
      boundary: crossed,
      previouslyAlertedAt: candidate.alertedBucketDays || null,
      outstanding: candidate.outstandingMinor,
    },
    records: [{ type: "schedule_item", id: candidate.scheduleItemId }],
  });
}

export interface UnmatchedMoneyCandidate {
  paymentId: string;
  amountMinor: number;
  currency: string;
  receivedAt: Date;
  matchStatus: string;
}

/** `unmatched_money`: received but not linked to a deal. */
export function decideUnmatchedMoney(
  candidate: UnmatchedMoneyCandidate,
  now: Date,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("unmatched_money");
  const ageHours = (now.getTime() - candidate.receivedAt.getTime()) / 3_600_000;
  const threshold = params.ageHours ?? spec.params.ageHours;

  if (candidate.matchStatus === "matched") return silent(spec, "it has been linked");
  if (ageHours < threshold) {
    // A payment that arrived an hour ago is not a problem - the daily
    // reconciliation or a person is about to deal with it. Alerting
    // immediately would make this the loudest rule in the product and the
    // first one anybody muted.
    return silent(spec, `only ${Math.round(ageHours)}h old of ${threshold}h`);
  }

  return fire(spec, {
    amountAtRiskMinor: candidate.amountMinor,
    values: {
      amount: money(candidate.amountMinor, candidate.currency),
      date: candidate.receivedAt.toISOString().slice(0, 10),
    },
    formula: `received ${Math.round(ageHours)}h ago (threshold ${threshold}h), match status "${candidate.matchStatus}"`,
    inputs: {
      ageHours: Math.round(ageHours),
      thresholdHours: threshold,
      amount: candidate.amountMinor,
      matchStatus: candidate.matchStatus,
    },
    records: [{ type: "payment", id: candidate.paymentId }],
  });
}

export interface SettlementMismatchCandidate {
  settlementId: string;
  settledOn: string;
  netMinor: number;
  bankCreditMinor: number | null;
  currency: string;
}

/** `settlement_mismatch`: the gateway's net is not what the bank credited. */
export function decideSettlementMismatch(
  candidate: SettlementMismatchCandidate,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("settlement_mismatch");
  const tolerance = params.toleranceMinor ?? spec.params.toleranceMinor;

  if (candidate.bankCreditMinor === null) {
    // NULL means "nobody has reconciled the statement yet", not "zero
    // arrived". Treating it as a mismatch of the full amount would raise a
    // critical alert on every settlement the moment it landed.
    return silent(spec, "the bank credit has not been entered yet");
  }
  const difference = candidate.netMinor - candidate.bankCreditMinor;
  if (Math.abs(difference) <= tolerance) {
    return silent(spec, `within the ${money(tolerance, candidate.currency)} tolerance`);
  }

  return fire(spec, {
    amountAtRiskMinor: Math.abs(difference),
    values: {
      date: candidate.settledOn,
      expected: money(candidate.netMinor, candidate.currency),
      actual: money(candidate.bankCreditMinor, candidate.currency),
    },
    formula: `net ${candidate.netMinor} - bank ${candidate.bankCreditMinor} = ${difference} (tolerance ${tolerance})`,
    inputs: {
      net: candidate.netMinor,
      bankCredit: candidate.bankCreditMinor,
      difference,
      tolerance,
    },
    records: [{ type: "settlement", id: candidate.settlementId, label: candidate.settledOn }],
  });
}

export interface FailedNotRetriedCandidate {
  paymentId: string;
  customerName: string | null;
  dealId: string | null;
  amountMinor: number;
  currency: string;
  failedOn: string;
  /** A later attempt on the same deal, or null. */
  lastAttemptOn: string | null;
}

/** `failed_not_retried`: a failed attempt with no retry or follow-up. */
export function decideFailedNotRetried(
  candidate: FailedNotRetriedCandidate,
  today: string,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("failed_not_retried");
  const n = params.days ?? spec.params.days;
  const days = daysBetween(candidate.failedOn, today);

  if (candidate.lastAttemptOn && candidate.lastAttemptOn > candidate.failedOn) {
    return silent(spec, "a later attempt was made");
  }
  if (days < n) return silent(spec, `only ${days} of ${n} days`);

  return fire(spec, {
    amountAtRiskMinor: candidate.amountMinor,
    values: {
      customer: candidate.customerName ?? "This customer",
      amount: money(candidate.amountMinor, candidate.currency),
      days,
    },
    formula: `failed ${candidate.failedOn}, ${days} days ago (threshold ${n}), no later attempt`,
    inputs: { failedOn: candidate.failedOn, daysSince: days, thresholdDays: n },
    records: [{ type: "payment", id: candidate.paymentId }],
  });
}

export interface DuplicateExpenseCandidate {
  expenseId: string;
  otherExpenseId: string;
  vendor: string;
  amountMinor: number;
  currency: string;
  incurredOn: string;
  otherIncurredOn: string;
  /** True when one of the pair is already a reversal of the other. */
  alreadyReversed: boolean;
}

/** `duplicate_expense`: same vendor and amount within X days. */
export function decideDuplicateExpense(
  candidate: DuplicateExpenseCandidate,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("duplicate_expense");
  const within = params.withinDays ?? spec.params.withinDays;
  const apart = Math.abs(daysBetween(candidate.otherIncurredOn, candidate.incurredOn));

  if (candidate.alreadyReversed) return silent(spec, "one of the pair has been reversed");
  if (apart > within) return silent(spec, `${apart} days apart, outside the ${within}-day window`);
  if (candidate.expenseId === candidate.otherExpenseId) return silent(spec, "same row");

  return fire(spec, {
    amountAtRiskMinor: candidate.amountMinor,
    values: {
      vendor: candidate.vendor,
      amount: money(candidate.amountMinor, candidate.currency),
      days: apart,
    },
    formula: `${candidate.vendor} for the same amount on ${candidate.incurredOn} and ${candidate.otherIncurredOn} (${apart} days apart, window ${within})`,
    inputs: { vendor: candidate.vendor, daysApart: apart, windowDays: within, amount: candidate.amountMinor },
    records: [
      { type: "expense", id: candidate.expenseId, label: candidate.incurredOn },
      { type: "expense", id: candidate.otherExpenseId, label: candidate.otherIncurredOn },
    ],
  });
}

export interface DiscountAbuseCandidate {
  userId: string;
  userName: string;
  /** Deals closed above the policy discount, in the window. */
  overPolicyDeals: { dealId: string; discountPercent: number; valueMinor: number }[];
  currency: string;
}

/** `discount_abuse`: discounts above policy, grouped by telecaller. */
export function decideDiscountAbuse(
  candidate: DiscountAbuseCandidate,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("discount_abuse");
  const policy = params.policyPercent ?? spec.params.policyPercent;
  const over = candidate.overPolicyDeals.filter((d) => d.discountPercent > policy);

  if (over.length === 0) return silent(spec, `nothing above the ${policy}% limit`);

  // The money at risk is the GIVEAWAY above policy, not the deal value. A rule
  // that reported ₹40L at risk because somebody discounted ₹40L of deals by
  // 12% instead of 10% would dominate the leak report and be wrong by a factor
  // of fifty.
  const givenAwayMinor = over.reduce(
    (sum, d) => sum + Math.round((d.valueMinor * (d.discountPercent - policy)) / 100),
    0,
  );

  return fire(spec, {
    amountAtRiskMinor: givenAwayMinor,
    values: { person: candidate.userName, count: over.length, policy },
    formula: `${over.length} deal(s) discounted above ${policy}%; excess giveaway ${givenAwayMinor}`,
    inputs: {
      policyPercent: policy,
      deals: over.length,
      worstDiscount: Math.max(...over.map((d) => d.discountPercent)),
      excess: givenAwayMinor,
    },
    records: over.map((d) => ({ type: "deal", id: d.dealId })),
  });
}

export interface NegativeRoiSourceCandidate {
  sourceId: string;
  sourceName: string;
  costMinor: number;
  revenueMinor: number;
  weeks: number;
  currency: string;
}

/** `negative_roi_source`: a source's cost exceeds its revenue over N weeks. */
export function decideNegativeRoiSource(
  candidate: NegativeRoiSourceCandidate,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("negative_roi_source");
  const weeks = params.weeks ?? spec.params.weeks;

  if (candidate.weeks < weeks) {
    // Fewer weeks of history than the rule asks for. Not a statistical
    // refusal - it is the rule's own window - but the same discipline: one bad
    // fortnight on a new campaign is not a verdict on it.
    return silent(spec, `only ${candidate.weeks} of ${weeks} weeks of history`);
  }
  if (candidate.costMinor === 0) return silent(spec, "no cost recorded for this source");
  if (candidate.revenueMinor >= candidate.costMinor) {
    return silent(spec, "revenue covers the cost");
  }

  const lossMinor = candidate.costMinor - candidate.revenueMinor;
  return fire(spec, {
    amountAtRiskMinor: lossMinor,
    values: {
      source: candidate.sourceName,
      cost: money(candidate.costMinor, candidate.currency),
      revenue: money(candidate.revenueMinor, candidate.currency),
      weeks: candidate.weeks,
    },
    formula: `cost ${candidate.costMinor} - revenue ${candidate.revenueMinor} = ${lossMinor} over ${candidate.weeks} weeks`,
    inputs: {
      cost: candidate.costMinor,
      revenue: candidate.revenueMinor,
      loss: lossMinor,
      weeks: candidate.weeks,
      requiredWeeks: weeks,
    },
    records: [{ type: "marketing_source", id: candidate.sourceId, label: candidate.sourceName }],
  });
}

export interface IncentiveClawbackCandidate {
  refundId: string;
  userId: string;
  userName: string;
  paidIncentiveMinor: number;
  refundedOn: string;
  paymentReceivedOn: string;
  clawbackDays: number;
  /** True once a clawback line exists for this refund. */
  clawedBack: boolean;
  currency: string;
}

/** `incentive_not_clawed_back`: a payout not reversed after a refund. */
export function decideIncentiveNotClawedBack(
  candidate: IncentiveClawbackCandidate,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("incentive_not_clawed_back");
  const window = params.windowDays ?? spec.params.windowDays;
  const daysBetweenPayAndRefund = daysBetween(candidate.paymentReceivedOn, candidate.refundedOn);

  if (candidate.clawedBack) return silent(spec, "already clawed back");
  if (candidate.paidIncentiveMinor <= 0) return silent(spec, "no incentive was paid on this sale");
  if (daysBetweenPayAndRefund > Math.min(window, candidate.clawbackDays)) {
    // Outside the plan's own clawback window, the money is legitimately the
    // rep's. Alerting on it would be asking somebody to break their own
    // compensation agreement.
    return silent(
      spec,
      `refunded ${daysBetweenPayAndRefund} days after payment, outside the ${candidate.clawbackDays}-day window`,
    );
  }

  return fire(spec, {
    amountAtRiskMinor: candidate.paidIncentiveMinor,
    values: {
      person: candidate.userName,
      amount: money(candidate.paidIncentiveMinor, candidate.currency),
      date: candidate.refundedOn,
    },
    formula: `refunded ${daysBetweenPayAndRefund} days after payment, inside the ${candidate.clawbackDays}-day clawback window; no clawback line`,
    inputs: {
      paidIncentive: candidate.paidIncentiveMinor,
      daysToRefund: daysBetweenPayAndRefund,
      clawbackDays: candidate.clawbackDays,
      windowDays: window,
    },
    records: [{ type: "refund", id: candidate.refundId }],
  });
}

export interface IdleSpendCandidate {
  expenseId: string;
  vendor: string;
  monthlyMinor: number;
  currency: string;
  lastUsedOn: string | null;
  recurs: string | null;
}

/** `idle_spend`: a recurring subscription or seat nobody uses. */
export function decideIdleSpend(
  candidate: IdleSpendCandidate,
  today: string,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("idle_spend");
  const unusedDays = params.unusedDays ?? spec.params.unusedDays;

  if (!candidate.recurs) return silent(spec, "not a recurring cost");
  if (candidate.lastUsedOn === null) {
    // NEVER USED is not the same as unused for 30 days, and it must not fire:
    // `last_used_on` is NULL for every recurring cost nobody has wired a usage
    // signal to, which is most of them. Firing on NULL would raise an alert
    // for every subscription the tenant has, on day one.
    return silent(spec, "no usage signal is recorded for this cost");
  }
  const idle = daysBetween(candidate.lastUsedOn, today);
  if (idle < unusedDays) return silent(spec, `used ${idle} days ago`);

  return fire(spec, {
    amountAtRiskMinor: candidate.monthlyMinor,
    values: {
      vendor: candidate.vendor,
      amount: money(candidate.monthlyMinor, candidate.currency),
      days: idle,
    },
    formula: `last used ${candidate.lastUsedOn}, ${idle} days ago (threshold ${unusedDays})`,
    inputs: { lastUsedOn: candidate.lastUsedOn, idleDays: idle, thresholdDays: unusedDays },
    records: [{ type: "expense", id: candidate.expenseId, label: candidate.vendor }],
  });
}

export interface CashRunwayCandidate {
  troughMinor: number;
  troughOn: string | null;
  minimumCashMinor: number;
  horizonDays: number;
  lowConfidence: boolean;
  currency: string;
}

/** `cash_runway_low`: the forecast balance crosses the owner's floor. */
export function decideCashRunwayLow(
  candidate: CashRunwayCandidate,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("cash_runway_low");
  const minimum = params.minimumCashMinor ?? candidate.minimumCashMinor;

  if (candidate.troughMinor >= minimum) {
    return silent(spec, "the forecast stays above the floor");
  }
  if (candidate.lowConfidence && candidate.troughMinor >= 0) {
    // ── THE ONE PLACE CONFIDENCE SUPPRESSES AN ALERT ─────────────────────
    //
    // A low-confidence forecast is mostly conservative priors (§12.2), so it
    // dips below a non-zero floor for almost any new tenant. Firing a CRITICAL
    // alert on that is how an owner learns to ignore the most important rule
    // in the product.
    //
    // A trough BELOW ZERO still fires whatever the confidence: "you may run
    // out of money" is worth saying even on thin data, and that is the
    // asymmetry this branch encodes rather than a blanket suppression.
    return silent(spec, "forecast is low-confidence and the trough is still positive");
  }

  return fire(spec, {
    amountAtRiskMinor: Math.max(0, minimum - candidate.troughMinor),
    values: {
      trough: money(candidate.troughMinor, candidate.currency),
      date: candidate.troughOn ?? "within the horizon",
      minimum: money(minimum, candidate.currency),
    },
    formula: `forecast trough ${candidate.troughMinor} on ${candidate.troughOn ?? "?"} vs floor ${minimum} over ${candidate.horizonDays} days`,
    inputs: {
      trough: candidate.troughMinor,
      troughOn: candidate.troughOn,
      minimumCash: minimum,
      horizonDays: candidate.horizonDays,
      lowConfidence: candidate.lowConfidence ? 1 : 0,
    },
    records: [],
  });
}

export interface ConnectorHealthCandidate {
  connectorAccountId: string;
  type: string;
  status: string;
  lastEventAt: Date | null;
  consecutiveFailures: number;
}

/** `connector_unhealthy`: no events, or repeated failures. */
export function decideConnectorUnhealthy(
  candidate: ConnectorHealthCandidate,
  now: Date,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("connector_unhealthy");
  const silentHours = params.silentHours ?? spec.params.silentHours;
  const failures = params.failures ?? spec.params.failures;

  if (candidate.status === "disconnected") {
    // Deliberately disconnected is not unhealthy. Alerting on it would mean a
    // tenant who switched gateways gets a permanent alert about the old one.
    return silent(spec, "this connector is disconnected on purpose");
  }

  const quietHours =
    candidate.lastEventAt === null
      ? Number.POSITIVE_INFINITY
      : (now.getTime() - candidate.lastEventAt.getTime()) / 3_600_000;
  const tooQuiet = quietHours >= silentHours;
  const tooManyFailures = candidate.consecutiveFailures >= failures;

  if (!tooQuiet && !tooManyFailures) {
    return silent(spec, `last event ${Math.round(quietHours)}h ago, ${candidate.consecutiveFailures} failures`);
  }

  return fire(spec, {
    // §12.4 gives this rule no amount, and `carriesAmount: false` says so -
    // money is not at risk, ingestion is. A rule that invented a figure here
    // would distort the leak report, which ranks by rupees.
    amountAtRiskMinor: null,
    values: {
      connector: candidate.type,
      date: candidate.lastEventAt ? candidate.lastEventAt.toISOString().slice(0, 10) : "never",
      failures: candidate.consecutiveFailures,
    },
    formula: tooQuiet
      ? `no verified event for ${Number.isFinite(quietHours) ? Math.round(quietHours) : "ever"}h (threshold ${silentHours}h)`
      : `${candidate.consecutiveFailures} consecutive failures (threshold ${failures})`,
    inputs: {
      quietHours: Number.isFinite(quietHours) ? Math.round(quietHours) : null,
      silentHoursThreshold: silentHours,
      consecutiveFailures: candidate.consecutiveFailures,
      failureThreshold: failures,
    },
    records: [
      { type: "connector_account", id: candidate.connectorAccountId, label: candidate.type },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The statistical rules (§14 M9) - every one of them can refuse to speak
// ─────────────────────────────────────────────────────────────────────────────

export interface FeeDriftCandidate {
  /** Fee as a PERCENTAGE of collections, per period, oldest first. */
  feePercentSeries: number[];
  currentFeePercent: number;
  collectedMinor: number;
  currency: string;
}

/**
 * `fee_drift`: the gateway's cut is above its own trailing average.
 *
 * Two tests, and it fires on either: §12.4's own "+0.3 pp above the trailing
 * average", and the EWMA control chart §12.4 asks for separately. The step
 * test catches a repricing; the chart catches the slow climb a trailing
 * average can never notice because the average climbs with it.
 */
export function decideFeeDrift(
  candidate: FeeDriftCandidate,
  params: Record<string, number>,
  minSample = MIN_SAMPLE_DEFAULT,
): DetectorVerdict {
  const spec = advisorRule("fee_drift");
  const points = params.percentagePoints ?? spec.params.percentagePoints;
  const series = candidate.feePercentSeries;

  if (series.length < minSample) {
    return silent(spec, "insufficient_sample", { periods: series.length, required: minSample }, series.length);
  }

  const baseline = series.reduce((a, b) => a + b, 0) / series.length;
  const stepBreach = candidate.currentFeePercent - baseline >= points;
  const drift = driftTest(series, { minSample });

  if (!stepBreach && !drift.flagged) {
    return silent(
      spec,
      drift.silentBecause ?? "within_band",
      { current: candidate.currentFeePercent, baseline: round2(baseline) },
      series.length,
    );
  }

  // The money: the EXCESS fee, not the whole fee. A rule reporting the entire
  // gateway bill as "at risk" would always top the leak report, and none of it
  // is recoverable - only the drift is.
  const excessPercent = Math.max(0, candidate.currentFeePercent - baseline);
  const excessMinor = Math.round((candidate.collectedMinor * excessPercent) / 100);

  return fire(spec, {
    amountAtRiskMinor: excessMinor,
    values: { current: round2(candidate.currentFeePercent), baseline: round2(baseline) },
    formula: stepBreach
      ? `${round2(candidate.currentFeePercent)}% vs trailing ${round2(baseline)}% (+${points} pp threshold)`
      : `EWMA ${round2(drift.current ?? 0)}% vs baseline ${round2(drift.baseline ?? 0)}%, limit ±${round2(drift.limit ?? 0)}`,
    inputs: {
      current: round2(candidate.currentFeePercent),
      baseline: round2(baseline),
      thresholdPoints: points,
      ewma: drift.current === null ? null : round2(drift.current),
      controlLimit: drift.limit === null ? null : round2(drift.limit),
      excess: excessMinor,
    },
    sampleSize: series.length,
  });
}

export interface RefundSpikeCandidate {
  /** Refund rate (0-1) per period, oldest first, EXCLUDING the current one. */
  rateSeries: number[];
  currentRate: number;
  refundedMinor: number;
  currency: string;
}

/** `refund_spike`: the refund/chargeback rate is above baseline (z > 2.5). */
export function decideRefundSpike(
  candidate: RefundSpikeCandidate,
  params: Record<string, number>,
  minSample = MIN_SAMPLE_DEFAULT,
): DetectorVerdict {
  const spec = advisorRule("refund_spike");
  const threshold = params.z ?? spec.params.z;

  if (candidate.rateSeries.length < minSample) {
    return silent(
      spec,
      "insufficient_sample",
      { periods: candidate.rateSeries.length, required: minSample },
      candidate.rateSeries.length,
    );
  }

  const z = zScore(candidate.currentRate, candidate.rateSeries);
  if (z === null) {
    return silent(spec, "no_dispersion", { current: candidate.currentRate }, candidate.rateSeries.length);
  }
  // One-sided, deliberately: a FALL in refunds is good news and does not need
  // an alert. A two-sided test would fire on a good month.
  if (z < threshold) {
    return silent(spec, "within_band", { z: round2(z), threshold }, candidate.rateSeries.length);
  }

  const baseline =
    candidate.rateSeries.reduce((a, b) => a + b, 0) / candidate.rateSeries.length;
  return fire(spec, {
    amountAtRiskMinor: candidate.refundedMinor,
    values: {
      current: percentage(candidate.currentRate, 1),
      baseline: percentage(baseline, 1),
    },
    formula: `z = ${round2(z)} against ${candidate.rateSeries.length} periods (threshold ${threshold})`,
    inputs: {
      z: round2(z),
      threshold,
      currentRate: round2(candidate.currentRate * 100),
      baselineRate: round2(baseline * 100),
    },
    sampleSize: candidate.rateSeries.length,
  });
}

export interface ExpenseOutlierCandidate {
  category: string;
  /** This category's spend per period, oldest first, EXCLUDING the current. */
  series: number[];
  currentMinor: number;
  currency: string;
}

/** `expense_outlier`: a category's spend is an outlier (modified z > 3.5). */
export function decideExpenseOutlier(
  candidate: ExpenseOutlierCandidate,
  params: Record<string, number>,
  minSample = MIN_SAMPLE_DEFAULT,
): DetectorVerdict {
  const spec = advisorRule("expense_outlier");
  const threshold = params.modifiedZ ?? spec.params.modifiedZ;
  const verdict = outlierTest(candidate.currentMinor, candidate.series, minSample);

  if (!verdict.flagged || verdict.modifiedZ === null) {
    return silent(
      spec,
      verdict.silentBecause ?? "within_band",
      { category: candidate.category, median: verdict.median, mad: verdict.mad },
      verdict.sampleSize,
    );
  }
  // One-sided again: a category that spent far LESS than usual is not a leak.
  // The outlier test is two-sided by construction, so the direction is checked
  // here rather than by changing the statistic.
  if (verdict.modifiedZ < threshold) {
    return silent(
      spec,
      "below the usual range, which is not a leak",
      { category: candidate.category, modifiedZ: round2(verdict.modifiedZ) },
      verdict.sampleSize,
    );
  }

  const excessMinor = Math.max(0, candidate.currentMinor - (verdict.median ?? 0));
  return fire(spec, {
    amountAtRiskMinor: excessMinor,
    values: {
      category: candidate.category,
      amount: money(candidate.currentMinor, candidate.currency),
    },
    formula: `modified z = ${round2(verdict.modifiedZ)} (median ${verdict.median}, MAD ${verdict.mad}, threshold ${threshold})`,
    inputs: {
      modifiedZ: round2(verdict.modifiedZ),
      threshold,
      median: verdict.median,
      mad: verdict.mad,
      current: candidate.currentMinor,
      excess: excessMinor,
    },
    sampleSize: verdict.sampleSize,
  });
}

export interface CallCostNoResultsCandidate {
  /** Call spend per period, oldest first - at least `periods + 1` of them. */
  spendSeries: number[];
  /** Conversions per period, same periods, same order. */
  conversionSeries: number[];
  currency: string;
}

/**
 * `call_cost_no_results`: call spend up while conversions are flat or down.
 *
 * ── TWO SERIES, COMPARED OVER THE RULE'S OWN WINDOW ────────────────────────
 *
 * §12.4's params say "2 periods", which is the number of periods to compare -
 * not a sample size. So this rule needs `periods + 1` points to see a change
 * at all, and the statistical minimum applies on top: eight periods before it
 * will speak, because "spend up 15% and conversions down 3%" over two weeks is
 * noise in any business with fewer than a few hundred calls a week.
 */
export function decideCallCostNoResults(
  candidate: CallCostNoResultsCandidate,
  params: Record<string, number>,
  minSample = MIN_SAMPLE_DEFAULT,
): DetectorVerdict {
  const spec = advisorRule("call_cost_no_results");
  const periods = params.periods ?? spec.params.periods;
  const { spendSeries, conversionSeries } = candidate;

  if (spendSeries.length < minSample || conversionSeries.length < minSample) {
    return silent(
      spec,
      "insufficient_sample",
      { periods: Math.min(spendSeries.length, conversionSeries.length), required: minSample },
      Math.min(spendSeries.length, conversionSeries.length),
    );
  }

  const recentSpend = spendSeries.slice(-periods).reduce((a, b) => a + b, 0);
  const priorSpend = spendSeries.slice(-periods * 2, -periods).reduce((a, b) => a + b, 0);
  const recentConv = conversionSeries.slice(-periods).reduce((a, b) => a + b, 0);
  const priorConv = conversionSeries.slice(-periods * 2, -periods).reduce((a, b) => a + b, 0);

  if (priorSpend === 0) return silent(spec, "no prior spend to compare against", {}, spendSeries.length);

  const spendChange = ((recentSpend - priorSpend) / priorSpend) * 100;
  const convChange = priorConv === 0 ? 0 : ((recentConv - priorConv) / priorConv) * 100;

  // Spend up MEANINGFULLY - 10%, not any rise at all - and conversions not up
  // with it. Without the floor this fires every time a month has one more
  // working day than the last.
  if (spendChange < 10 || convChange > 0) {
    return silent(
      spec,
      "spend and results moved together",
      { spendChange: round2(spendChange), conversionChange: round2(convChange) },
      spendSeries.length,
    );
  }

  return fire(spec, {
    amountAtRiskMinor: Math.max(0, recentSpend - priorSpend),
    values: { spendChange: round2(spendChange), conversionChange: round2(convChange) },
    formula: `spend ${round2(spendChange)}% vs conversions ${round2(convChange)}% over ${periods} period(s)`,
    inputs: {
      recentSpend,
      priorSpend,
      recentConversions: recentConv,
      priorConversions: priorConv,
      spendChange: round2(spendChange),
      conversionChange: round2(convChange),
      periods,
    },
    sampleSize: spendSeries.length,
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Every rule that has a decider here, so a test can assert the set matches the
 * catalogue - and so a rule added to §12.4 without a decider is a red test
 * rather than a row in `advisor_rules` that can never fire.
 */
// ─────────────────────────────────────────────────────────────────────────────
// The compliance calendar and the document vault
// (Build docs/indian-business-finance-documents-cycles-import §2)
//
// ── WHY THESE FIVE DECIDERS ARE SO SMALL ────────────────────────────────────
//
// Because the real decisions already live in `compliance.ts` and
// `documents.ts`, as `remindsToday`, `complianceStatus` and
// `documentRemindsToday` - tested there against their own fixtures. These
// functions exist to put a verdict in the SHAPE the Advisor consumes
// (`DetectorVerdict`, with a rendered message and an explain payload), not to
// re-decide anything.
//
// Writing the date arithmetic a second time here is the one thing that must
// not happen: the console colours a filing from `complianceStatus` and the
// inbox would then disagree with the page about whether something is overdue.
// ─────────────────────────────────────────────────────────────────────────────

export interface ComplianceFilingCandidate {
  filingId: string;
  itemCode: string;
  /** The item's name as the tenant has it - never the catalogue's. */
  name: string;
  /** "September 2026", "Q2 FY 2026-27". */
  periodLabel: string;
  dueOn: string;
  filedOn: string | null;
  waivedAt: string | null;
  /** The item's own offsets. Empty falls back to the rule's `fallbackDays`. */
  reminderOffsets: readonly number[];
  /**
   * The date the filing row was GENERATED, as `YYYY-MM-DD`.
   *
   * Read by `decideComplianceOverdue` to tell a missed deadline from a
   * back-filled one. Optional so a caller that does not have it still works;
   * absent, the rule behaves as it did before the distinction existed.
   */
  generatedOn?: string | null;
}

/** `compliance_due`: today is one of a filing's reminder days. */
export function decideComplianceDue(
  candidate: ComplianceFilingCandidate,
  today: string,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("compliance_due");
  const fallbackDays = params.fallbackDays ?? spec.params.fallbackDays;

  if (candidate.filedOn) return silent(spec, "It has already been filed.");
  if (candidate.waivedAt) return silent(spec, "It is marked not applicable.");
  if (candidate.dueOn < today) {
    // Not this rule's business - `compliance_overdue` owns it. Without this
    // the two rules would both fire on the same filing for weeks.
    return silent(spec, "It is already overdue, which the overdue rule reports instead.");
  }

  const offsets = candidate.reminderOffsets.length > 0 ? candidate.reminderOffsets : [fallbackDays];
  if (!remindsToday(candidate, offsets, today)) {
    return silent(spec, "Today is not one of its reminder days.", {
      dueOn: candidate.dueOn,
      offsets: offsets.join(", "),
    });
  }

  const days = daysUntilDue(candidate, today) ?? 0;
  return fire(spec, {
    amountAtRiskMinor: null,
    values: { name: candidate.name, period: candidate.periodLabel, date: candidate.dueOn, days },
    formula: "A reminder day for this filing",
    inputs: { dueOn: candidate.dueOn, today, offsets: offsets.join(", ") },
    records: [{ type: "compliance_filing", id: candidate.filingId, label: candidate.name }],
  });
}

/** `compliance_overdue`: past due, not filed, not waived. */
export function decideComplianceOverdue(
  candidate: ComplianceFilingCandidate,
  today: string,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("compliance_overdue");
  const repeatEveryDays = Math.max(1, params.repeatEveryDays ?? spec.params.repeatEveryDays);

  if (complianceStatus(candidate, today) !== "overdue") {
    return silent(spec, "It is not overdue.", { dueOn: candidate.dueOn, today });
  }

  // ── A BACK-FILLED FILING IS NOT A MISSED DEADLINE ───────────────────────
  //
  // Seeding the calendar mid-year generates the whole financial year, so a
  // tenant who sets it up in October gets filings for April through September
  // that are already past their due date. Thirty-one of them, measured on a
  // real seed - and every one would have raised a CRITICAL alert on day one
  // about a return the business very likely filed on time, through their CA,
  // months before this system knew the deadline existed.
  //
  // An inbox that opens with thirty-one false criticals is an inbox nobody
  // believes again, so the rule stays silent where the row was generated AFTER
  // it was already due. The filing is still visibly overdue on the calendar -
  // where an owner can mark it filed or waive it - because the record is real.
  // What is not real is the claim that they missed it.
  if (candidate.generatedOn && candidate.generatedOn > candidate.dueOn) {
    return silent(
      spec,
      "This period was already past its due date when the calendar was set up, so whether it was filed is not something this system can know. Mark it filed or not applicable on the calendar.",
      { dueOn: candidate.dueOn, generatedOn: candidate.generatedOn },
    );
  }

  const lateBy = -(daysUntilDue(candidate, today) ?? 0);
  // Re-raised on a cadence rather than every night: a return genuinely waiting
  // on a CA would otherwise produce thirty identical alerts in a month, and an
  // inbox like that gets ignored wholesale. Day 1 always fires, then weekly.
  if (lateBy > 1 && lateBy % repeatEveryDays !== 0) {
    return silent(spec, `Already reported; it is re-raised every ${repeatEveryDays} days.`, {
      lateBy,
      repeatEveryDays,
    });
  }

  return fire(spec, {
    amountAtRiskMinor: null,
    values: { name: candidate.name, period: candidate.periodLabel, date: candidate.dueOn, days: lateBy },
    formula: "Due date passed with nothing filed",
    inputs: { dueOn: candidate.dueOn, today, lateBy },
    records: [{ type: "compliance_filing", id: candidate.filingId, label: candidate.name }],
  });
}

export interface VaultDocumentCandidate {
  documentId: string;
  title: string;
  categoryCode: string;
  expiresOn: string | null;
  reminderOffsets: readonly number[];
  /** True when a newer version of the same document has been uploaded. */
  superseded: boolean;
}

/** `document_expiring`: today is one of a document's reminder days. */
export function decideDocumentExpiring(
  candidate: VaultDocumentCandidate,
  today: string,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("document_expiring");
  const fallbackDays = params.fallbackDays ?? spec.params.fallbackDays;

  if (candidate.superseded) return silent(spec, "A newer version has been uploaded.");
  if (!candidate.expiresOn) return silent(spec, "It has no expiry date.");

  const offsets = candidate.reminderOffsets.length > 0 ? candidate.reminderOffsets : [fallbackDays];
  if (!documentRemindsToday(candidate, offsets, today)) {
    return silent(spec, "Today is not one of its reminder days.", {
      expiresOn: candidate.expiresOn,
      offsets: offsets.join(", "),
    });
  }

  const days = daysUntilExpiry(candidate, today) ?? 0;
  return fire(spec, {
    amountAtRiskMinor: null,
    values: { name: candidate.title, date: candidate.expiresOn, days },
    formula: "A reminder day before this document expires",
    inputs: { expiresOn: candidate.expiresOn, today, offsets: offsets.join(", ") },
    records: [{ type: "business_document", id: candidate.documentId, label: candidate.title }],
  });
}

/** `document_expired`: past its expiry with no newer version. */
export function decideDocumentExpired(
  candidate: VaultDocumentCandidate,
  today: string,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("document_expired");
  const repeatEveryDays = Math.max(1, params.repeatEveryDays ?? spec.params.repeatEveryDays);

  if (candidate.superseded) return silent(spec, "A newer version has been uploaded.");
  if (documentExpiryStatus(candidate, today) !== "expired") {
    return silent(spec, "It has not expired.", { expiresOn: candidate.expiresOn ?? "none" });
  }

  const lateBy = -(daysUntilExpiry(candidate, today) ?? 0);
  if (lateBy > 1 && lateBy % repeatEveryDays !== 0) {
    return silent(spec, `Already reported; it is re-raised every ${repeatEveryDays} days.`, {
      lateBy,
      repeatEveryDays,
    });
  }

  return fire(spec, {
    amountAtRiskMinor: null,
    values: { name: candidate.title, date: candidate.expiresOn ?? "", days: lateBy },
    formula: "Expiry date passed with no newer version",
    inputs: { expiresOn: candidate.expiresOn ?? "none", today, lateBy },
    records: [{ type: "business_document", id: candidate.documentId, label: candidate.title }],
  });
}

export interface MonthCloseCandidate {
  /** First of the month, `YYYY-MM-01`. */
  month: string;
  periodLabel: string;
  /** Last day of that month. */
  monthEnd: string;
  doneStepKeys: readonly string[];
  lockedAt: string | null;
}

/** `books_not_closed`: a month ended, the grace ran out, and it is still open. */
export function decideBooksNotClosed(
  candidate: MonthCloseCandidate,
  today: string,
  params: Record<string, number>,
): DetectorVerdict {
  const spec = advisorRule("books_not_closed");
  const graceDays = params.graceDays ?? spec.params.graceDays;
  const repeatEveryDays = Math.max(1, params.repeatEveryDays ?? spec.params.repeatEveryDays);

  if (candidate.lockedAt) return silent(spec, "The period is locked.");

  const daysSinceEnd = daysBetween(candidate.monthEnd, today);
  if (daysSinceEnd < graceDays) {
    // §2 puts the GST and TDS deadlines inside the month-end rhythm and the
    // earliest of them is the 7th, so nagging on the 1st would be nagging
    // about work that is not yet due.
    return silent(spec, `Still inside the ${graceDays}-day grace period.`, { daysSinceEnd, graceDays });
  }

  const readiness = closeReadiness(candidate.doneStepKeys);
  if (readiness.complete) {
    return silent(spec, "Every checklist step is done; only the lock is left.", {
      done: readiness.done,
      total: readiness.total,
    });
  }

  const sinceDue = daysSinceEnd - graceDays;
  if (sinceDue > 1 && sinceDue % repeatEveryDays !== 0) {
    return silent(spec, `Already reported; it is re-raised every ${repeatEveryDays} days.`, { sinceDue });
  }

  return fire(spec, {
    amountAtRiskMinor: null,
    values: {
      period: candidate.periodLabel,
      done: readiness.done,
      total: readiness.total,
    },
    formula: "Month ended, grace period passed, checklist incomplete",
    inputs: {
      monthEnd: candidate.monthEnd,
      today,
      daysSinceEnd,
      outstanding: readiness.outstanding.join(", "),
      blocking: readiness.blocking.join(", ") || "none",
    },
    records: [{ type: "finance_period", id: candidate.month, label: candidate.periodLabel }],
  });
}

export const IMPLEMENTED_DETECTORS: readonly AdvisorRuleCode[] = [
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
  "compliance_due",
  "compliance_overdue",
  "document_expiring",
  "document_expired",
  "books_not_closed",
];
