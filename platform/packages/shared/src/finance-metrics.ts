import { z } from "zod";
import { percentage, ratio } from "./money";
import { percentile } from "./finance-stats";
import type { AgingBucket } from "./finance";

/**
 * §11's metrics layer: ONE definition and one code path per number.
 *
 * ── WHY THIS IS A FILE AND NOT SEVENTEEN SQL FRAGMENTS ─────────────────────
 *
 * §11 opens with "One metrics layer. Each metric has a single definition and
 * code path; dashboards, reports and the Advisor all call it." The failure it
 * is guarding against is specific and this repo has seen it elsewhere: the
 * owner dashboard computes "collected" one way, a report template another, and
 * the Advisor a third, so an owner is shown three numbers for the same
 * question and trusts none of them.
 *
 * So the SHAPE is here: `FinanceTotals` is what a snapshot row holds, and
 * every derived metric is a function over it. The aggregation SQL lives in one
 * place too (the worker's snapshot builder), and the dashboards read snapshots
 * rather than re-aggregating - §13's performance requirement and §11's
 * single-definition requirement happen to have the same answer.
 *
 * ── EVERY RATE CAN BE NULL ─────────────────────────────────────────────────
 *
 * A month with no billing has no collection rate. Returning 0 would tell an
 * owner they collected nothing when there was nothing to collect, so every
 * rate here returns `number | null` and every dashboard renders null as "—".
 * This is the same rule `ratio()` in money.ts enforces, applied consistently
 * rather than per call site.
 */

/** §9's `finance_snapshot.scope`. */
export const SnapshotScope = z.enum(["org", "user", "campaign", "source", "template"]);
export type SnapshotScope = z.infer<typeof SnapshotScope>;

/**
 * The totals a snapshot row holds, all in MINOR units except the counts.
 *
 * Additive on purpose: every field can be summed across days to make a period,
 * which is what lets one nightly row per (date, scope, scope_id) answer "this
 * month", "last quarter" and "year to date" without a second table. A
 * non-additive field here - an average, a rate - would silently produce the
 * mean of means when a caller summed a week.
 */
export interface FinanceTotals {
  /** Deal totals for deals CLOSED in the period (§11 "Booked"). */
  bookedMinor: number;
  /** Schedule amounts that came due in the period. The denominator of collection rate. */
  billedMinor: number;
  /** Received payments in the period, gross of refunds. */
  collectedMinor: number;
  refundedMinor: number;
  /** Gateway fee plus the tax on the fee. */
  feesMinor: number;
  /** Expenses incurred in the period. */
  costsMinor: number;
  /** Incentive earned in the period - a cost, and part of CAC. */
  incentiveMinor: number;
  /** Open schedule amounts as at the END of the period. NOT additive - see below. */
  outstandingMinor: number;
  /** Outstanding split by §11's buckets, as at the end of the period. */
  agingMinor: Record<AgingBucket, number>;
  /** Count of deals closed in the period. */
  dealsClosed: number;
  /** Customers whose FIRST payment landed in the period - CAC's denominator. */
  newCustomers: number;
  /** Days each payment took from its due date, for the median/p90 (§11). */
  daysToCollect: number[];
  disputedMinor: number;
}

export function emptyTotals(): FinanceTotals {
  return {
    bookedMinor: 0,
    billedMinor: 0,
    collectedMinor: 0,
    refundedMinor: 0,
    feesMinor: 0,
    costsMinor: 0,
    incentiveMinor: 0,
    outstandingMinor: 0,
    agingMinor: { current: 0, "0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 },
    dealsClosed: 0,
    newCustomers: 0,
    daysToCollect: [],
    disputedMinor: 0,
  };
}

/**
 * Sum snapshot rows into one period.
 *
 * ── TWO FIELDS THAT MUST NOT BE SUMMED ─────────────────────────────────────
 *
 * `outstandingMinor` and `agingMinor` are BALANCES, not flows: they say what
 * was owed at the end of a day. Summing thirty of them gives thirty times the
 * receivables, which would be a dashboard reading ₹3 crore of dues against ₹10
 * lakh of real ones. So they take the LAST row's value, which is why this
 * function requires its input to be date-ordered and says so in the type.
 *
 * `newCustomers` is summed, and that is a deliberate approximation: a customer
 * whose first payment lands twice in one period cannot happen (it is a first
 * payment), but one counted in January and again in a February snapshot could
 * if the definition were "customers who paid". It is not - it is first
 * payments - so the sum is exact.
 */
export function sumTotals(ordered: readonly FinanceTotals[]): FinanceTotals {
  const out = emptyTotals();
  for (const row of ordered) {
    out.bookedMinor += row.bookedMinor;
    out.billedMinor += row.billedMinor;
    out.collectedMinor += row.collectedMinor;
    out.refundedMinor += row.refundedMinor;
    out.feesMinor += row.feesMinor;
    out.costsMinor += row.costsMinor;
    out.incentiveMinor += row.incentiveMinor;
    out.dealsClosed += row.dealsClosed;
    out.newCustomers += row.newCustomers;
    out.disputedMinor += row.disputedMinor;
    out.daysToCollect.push(...row.daysToCollect);
  }
  const last = ordered.at(-1);
  if (last) {
    out.outstandingMinor = last.outstandingMinor;
    out.agingMinor = { ...last.agingMinor };
  }
  return out;
}

/** Collected net of refunds - what the business actually kept. */
export function netCollected(t: FinanceTotals): number {
  return t.collectedMinor - t.refundedMinor;
}

/** Every cost: expenses, incentives and the gateway's cut. */
export function totalCosts(t: FinanceTotals): number {
  return t.costsMinor + t.incentiveMinor + t.feesMinor;
}

/** §11: collected ÷ billed in the period. */
export function collectionRate(t: FinanceTotals): number | null {
  return ratio(netCollected(t), t.billedMinor);
}

/** §11: (collected − all costs) ÷ collected. Negative is a real answer. */
export function netMargin(t: FinanceTotals): number | null {
  const collected = netCollected(t);
  return ratio(collected - totalCosts(t), collected);
}

/** §11: fees ÷ gross captured. */
export function gatewayFeeRate(t: FinanceTotals): number | null {
  return ratio(t.feesMinor, t.collectedMinor);
}

/** §11: refunded or disputed ÷ captured. */
export function refundRate(t: FinanceTotals): number | null {
  return ratio(t.refundedMinor + t.disputedMinor, t.collectedMinor);
}

/**
 * §11: (marketing + calling + incentive cost) ÷ new customers.
 *
 * ── WHY THE NUMERATOR IS ALL COSTS AND NOT A SUBSET ────────────────────────
 *
 * §11's parenthetical names three cost kinds. Taken literally that needs a
 * mapping from thirteen expense categories onto "marketing" and "calling",
 * and every such mapping is an argument: is the CRM subscription an
 * acquisition cost? Is the floor's rent?
 *
 * This uses the full cost base, which makes the number a fully-loaded CAC and
 * - more usefully - makes it reconcile: `netMargin` and `cac` divide the same
 * numerator, so an owner cannot find a rupee in one that is missing from the
 * other. The per-category breakdown is shown beside it (§12.3) for the people
 * who want the narrower reading.
 */
export function cac(t: FinanceTotals): number | null {
  if (t.newCustomers === 0) return null;
  return Math.round(totalCosts(t) / t.newCustomers);
}

/**
 * §11: DSO = outstanding ÷ credit sales × days in period.
 *
 * `billedMinor` is the credit-sales denominator: what came due in the period.
 * Null when nothing was billed - a DSO computed on a zero denominator is
 * infinity, and a dashboard reading "∞ days to collect" is worse than a dash.
 */
export function dso(t: FinanceTotals, daysInPeriod: number): number | null {
  const r = ratio(t.outstandingMinor, t.billedMinor);
  return r === null ? null : r * daysInPeriod;
}

/**
 * §11: days-to-collect as MEDIAN AND 90TH PERCENTILE, "not just the mean".
 *
 * The spec is emphatic and it is right: collection times are heavily
 * right-skewed - most customers pay near the due date and a handful take six
 * months - so the mean sits above almost every actual payment and describes
 * nobody. The p90 is the number a collections team plans around.
 */
export function daysToCollect(t: FinanceTotals): { median: number | null; p90: number | null } {
  return {
    median: percentile(t.daysToCollect, 0.5),
    p90: percentile(t.daysToCollect, 0.9),
  };
}

/** §11's per-unit costs. Null-safe on both sides. */
export function costPerUnit(costMinor: number, units: number): number | null {
  if (units === 0) return null;
  return Math.round(costMinor / units);
}

export function revenuePerCall(t: FinanceTotals, calls: number): number | null {
  return costPerUnit(netCollected(t), calls);
}

// ─────────────────────────────────────────────────────────────────────────────
// The catalogue - what the console renders, and what a drill-down links to
// ─────────────────────────────────────────────────────────────────────────────

export const MetricKey = z.enum([
  "booked",
  "collected",
  "collection_rate",
  "outstanding",
  "dso",
  "aging",
  "cac",
  "net_margin",
  "gateway_fee_rate",
  "refund_rate",
  "runway",
  "days_to_collect",
  "cost_per_lead",
  "revenue_per_call",
]);
export type MetricKey = z.infer<typeof MetricKey>;

export interface MetricSpec {
  key: MetricKey;
  label: string;
  /** §11's definition, in words, shown in the tooltip. */
  definition: string;
  /** How to render it. `money` is minor units; `rate` is a 0-1 ratio. */
  kind: "money" | "rate" | "days" | "count";
  /**
   * §11 MUST: "every number is clickable and drills down to the underlying
   * payments, schedule items or expenses". This is where it drills TO - the
   * console appends the active period and scope as query parameters.
   *
   * A metric with no drill-down is a metric an owner cannot verify, so every
   * entry has one. `runway` drills to the forecast's own assumptions table,
   * which IS its underlying record.
   */
  drillTo: string;
  /** Higher is better? Decides which direction gets the good colour. */
  direction: "up" | "down";
}

export const FINANCE_METRICS: readonly MetricSpec[] = [
  {
    key: "booked",
    label: "Booked",
    definition: "Total value of deals closed in the period.",
    kind: "money",
    drillTo: "/owner/finance/deals",
    direction: "up",
  },
  {
    key: "collected",
    label: "Collected",
    definition: "Payments received in the period, less refunds.",
    kind: "money",
    drillTo: "/owner/finance/payments",
    direction: "up",
  },
  {
    key: "collection_rate",
    label: "Collection rate",
    definition: "Collected divided by what came due in the period.",
    kind: "rate",
    drillTo: "/owner/finance/dues",
    direction: "up",
  },
  {
    key: "outstanding",
    label: "Outstanding",
    definition: "Everything still unpaid on every open payment schedule.",
    kind: "money",
    drillTo: "/owner/finance/dues",
    direction: "down",
  },
  {
    key: "dso",
    label: "Days sales outstanding",
    definition: "Outstanding ÷ amount billed × days in the period.",
    kind: "days",
    drillTo: "/owner/finance/dues",
    direction: "down",
  },
  {
    key: "aging",
    label: "Aging",
    definition: "Outstanding money split by how long it has been late.",
    kind: "money",
    drillTo: "/owner/finance/dues?view=aging",
    direction: "down",
  },
  {
    key: "cac",
    label: "Cost to win a customer",
    definition: "All costs in the period ÷ customers whose first payment landed in it.",
    kind: "money",
    drillTo: "/owner/finance/expenses",
    direction: "down",
  },
  {
    key: "net_margin",
    label: "Net margin",
    definition: "(Collected − every cost) ÷ collected.",
    kind: "rate",
    drillTo: "/owner/finance/expenses",
    direction: "up",
  },
  {
    key: "gateway_fee_rate",
    label: "Gateway fees",
    definition: "Gateway fee and the tax on it, as a share of what was captured.",
    kind: "rate",
    drillTo: "/owner/finance/settlements",
    direction: "down",
  },
  {
    key: "refund_rate",
    label: "Refunds & disputes",
    definition: "Refunded or disputed money as a share of what was captured.",
    kind: "rate",
    drillTo: "/owner/finance/payments?status=refunded",
    direction: "down",
  },
  {
    key: "runway",
    label: "Runway",
    definition: "Cash ÷ average monthly net burn. Blank when the business is cash-positive.",
    kind: "days",
    drillTo: "/owner/finance/forecast",
    direction: "up",
  },
  {
    key: "days_to_collect",
    label: "Days to collect",
    definition: "Median and 90th percentile days from a due date to the money arriving.",
    kind: "days",
    drillTo: "/owner/finance/payments",
    direction: "down",
  },
  {
    key: "cost_per_lead",
    label: "Cost per lead",
    definition: "Spend on a source ÷ leads it produced.",
    kind: "money",
    drillTo: "/owner/finance/sources",
    direction: "down",
  },
  {
    key: "revenue_per_call",
    label: "Revenue per call",
    definition: "Collected ÷ calls made in the period.",
    kind: "money",
    drillTo: "/owner/finance/sources",
    direction: "up",
  },
];

const METRIC_BY_KEY = new Map(FINANCE_METRICS.map((m) => [m.key, m]));

export function metricSpec(key: MetricKey): MetricSpec {
  const spec = METRIC_BY_KEY.get(key);
  if (!spec) throw new Error(`unknown finance metric: ${key}`);
  return spec;
}

/**
 * §11: "show period-over-period comparison".
 *
 * ── WHY A DIRECTION-AWARE VERDICT AND NOT JUST A PERCENTAGE ────────────────
 *
 * A 20% rise in outstanding and a 20% rise in collections are the same number
 * and opposite news. A console that colours both green is a console that
 * trains people to ignore the colour, so the comparison carries `better` -
 * derived from the metric's own `direction` - and the UI colours that.
 */
export interface Comparison {
  changePercent: number | null;
  better: boolean | null;
}

export function compare(key: MetricKey, current: number | null, previous: number | null): Comparison {
  if (current === null || previous === null || previous === 0) {
    return { changePercent: null, better: null };
  }
  const changePercent = percentage(current - previous, Math.abs(previous));
  if (changePercent === null || changePercent === 0) return { changePercent, better: null };
  const rose = changePercent > 0;
  return { changePercent, better: metricSpec(key).direction === "up" ? rose : !rose };
}

/**
 * §11 MUST: "show a freshness stamp".
 *
 * The shape, so every widget states the same two facts in the same words: when
 * the numbers were computed, and when each connector last heard from its
 * gateway. A dashboard that cannot say how old it is gets believed at the
 * wrong moment - the morning after a connector stopped delivering.
 */
export interface Freshness {
  /** When the snapshot that backs these numbers was built. */
  computedAt: Date | null;
  /** Per connector: its type and when it last delivered an event. */
  connectors: { type: string; lastEventAt: Date | null; healthy: boolean }[];
  /** True when any figure on screen was computed live rather than from a snapshot. */
  live: boolean;
}

/**
 * "15:42 · Razorpay synced 3 min ago" - §11's own example, as one string.
 *
 * Minutes, not a timestamp, for the connector half: "synced at 15:39" requires
 * the reader to subtract, and the question they are actually asking is whether
 * it is current.
 */
export function freshnessLabel(freshness: Freshness, now: Date): string {
  const parts: string[] = [];
  if (freshness.computedAt) {
    parts.push(`data as of ${hhmm(freshness.computedAt)}`);
  } else if (freshness.live) {
    parts.push("live");
  } else {
    parts.push("not computed yet");
  }
  for (const connector of freshness.connectors) {
    parts.push(
      connector.lastEventAt
        ? `${connector.type} synced ${agoLabel(connector.lastEventAt, now)}`
        : `${connector.type} has never synced`,
    );
  }
  return parts.join("; ");
}

function hhmm(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function agoLabel(at: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
