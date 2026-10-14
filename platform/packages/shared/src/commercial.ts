import { type BillingPeriod, monthlyFromAnnual } from "./pricing";

/**
 * THE COMMERCIAL ARITHMETIC (doc 49 P13c).
 *
 * ── WHY THIS IS A PURE MODULE AND NOT SQL ───────────────────────────────────
 *
 * Every number the operator's commercial dashboard shows is an opinion about
 * what a tenant owes us, and each one has an edge case that decides whether the
 * figure is honest: a trial that has not converted, a subscription past due, a
 * plan with no price in the price list, an add-on held at a price we never
 * published, two tenants billed in different currencies. Those decisions belong
 * where they can be tested with a table of inputs, not inside a 60-line
 * aggregate where the only way to exercise the trial branch is to create a
 * trialling tenant.
 *
 * ── THREE CORRECTIONS TO THE PLAN, WHICH THE CALLER MUST KNOW ───────────────
 *
 * Doc 49 P13c says "nothing below needs new data collection; it needs
 * aggregation and a layout". That is true of most of it and false of three
 * things, and each one was established by reading the schema rather than by
 * assuming:
 *
 * **1. There is no `subscriptions` table.** It is `org_subscriptions`, one row
 *    per org, holding the CURRENT plan and nothing historical.
 *
 * **2. `invoices` is not ours.** The plan sources "Outstanding (overdue ₹)"
 *    from `invoices` (0176). That table belongs to the tenant's own finance
 *    module: it has `account_id`, `contact_id`, `deal_id`, `quotation_id`, and
 *    it is a tenant invoicing THEIR customers. Summing it would report our
 *    clients' receivables as our own cash - a number that is not merely wrong
 *    but wrong in our favour, on a screen somebody makes decisions from. What
 *    we are owed is `billing_orders` with `status = 'pending'`, which has no
 *    `due_date` column, so "overdue" is not expressible at all. The tile
 *    therefore reports UNSETTLED orders and the age of the oldest.
 *
 * **3. MRR history cannot be reconstructed.** `org_subscriptions` keeps no
 *    history, and nothing records what a tenant's price was in a past month. So
 *    "MRR by month, stacked by plan" is not computable. What IS computable from
 *    `billing_orders` is BILLINGS by month - cash actually invoiced, by plan -
 *    and that is what ships, under that name. Calling it MRR would be a drawn
 *    assertion about months nobody measured. An `org_subscription_events`
 *    ledger would fix it properly; see DEPLOYMENT.md §14.
 *
 * And one limit that is not a correction but is just as load-bearing: the four
 * `insights`-family plans have **no price anywhere** - no `plan_prices` row,
 * `plans.price_minor` NULL, nothing in `pricing.ts`. A tenant on one of those
 * has an MRR nobody can compute, so it resolves to `unpriced` and is COUNTED
 * AND NAMED rather than treated as zero. Silently zeroing it would understate
 * MRR by exactly the revenue nobody has got round to publishing a price for.
 */

/** `org_subscriptions.status`, as its CHECK constrains it. */
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled";

/** What the fleet query returns per org, before any arithmetic. */
export interface OrgCommercialRow {
  orgId: string;
  subStatus: SubscriptionStatus | null;
  billingPeriod: BillingPeriod | null;
  planKey: string | null;
  /**
   * `plan_prices.annual_monthly_minor` for this org's billing region. NULL
   * means there is no published price for this plan in this region - which is
   * every `insights` plan today, in every region.
   */
  annualMonthlyMinor: number | null;
  currency: string | null;
  billingRegion: string;
  /** `org_plan_addons`, keyed by add-on, units > 0 only. */
  addonUnits: Record<string, number> | null;
}

/**
 * Why a tenant contributes what it contributes.
 *
 * Six states and not two, because "₹0" is the same pixel for a trial, a
 * cancellation, a tenant with no subscription row and a plan nobody priced -
 * and those four call for four different actions.
 */
export type MrrState =
  /** Paying, counted. */
  | "recurring"
  /** Subscribed but `past_due`: contracted revenue we are not collecting. */
  | "at_risk"
  /** Inside a trial. Contributes nothing, by definition, and is not a loss. */
  | "trialing"
  /** Was a customer. */
  | "cancelled"
  /** No `org_subscriptions` row - every tenant predating the plan system. */
  | "no_subscription"
  /** Subscribed to a plan with no published price. An unknown, not a zero. */
  | "unpriced";

export interface OrgMrr {
  state: MrrState;
  /** Minor units per month, ex-tax. Zero unless `recurring` or `at_risk`. */
  minor: number;
  currency: string | null;
  /**
   * Add-ons this tenant holds whose price is not in `plan_addon_prices`. The
   * plan fee is still counted - dropping a tenant's whole MRR over one
   * unpriced add-on would be a bigger lie than understating it - but the
   * shortfall is named so the screen can say so.
   */
  unpricedAddons: string[];
}

/**
 * One tenant's monthly recurring revenue.
 *
 * `addonPriceMinor` resolves a recurring add-on's price for a region, returning
 * null when the price list does not carry one. Passed in rather than imported
 * so the caller can hand over the rows it already fetched, and so this stays
 * executable without a database.
 *
 * ── THE PERIOD IS NOT COSMETIC ──────────────────────────────────────────────
 *
 * The price list quotes the monthly price WHEN BILLED ANNUALLY, and monthly
 * billing carries a 20% uplift (`MONTHLY_UPLIFT_BP`). So a monthly-billed
 * Growth tenant contributes more per month than an annual one, and taking the
 * stored figure for both would understate MRR for every monthly tenant. The
 * uplift is applied through `monthlyFromAnnual`, the same function the checkout
 * charges with, so the dashboard and the invoice cannot drift.
 */
export function orgMrr(
  row: OrgCommercialRow,
  addonPriceMinor: (addonKey: string, region: string) => number | null,
  recurringAddon: (addonKey: string) => boolean,
): OrgMrr {
  const none = (state: MrrState): OrgMrr => ({
    state,
    minor: 0,
    currency: row.currency ?? null,
    unpricedAddons: [],
  });

  if (!row.subStatus) return none("no_subscription");
  if (row.subStatus === "cancelled") return none("cancelled");
  if (row.subStatus === "trialing") return none("trialing");
  if (row.annualMonthlyMinor === null) return none("unpriced");

  const base =
    row.billingPeriod === "monthly"
      ? monthlyFromAnnual(row.annualMonthlyMinor)
      : row.annualMonthlyMinor;

  // Recurring add-ons only. A PACK is a credit spent inside one period - a
  // one-off purchase - and counting it as recurring revenue would book a
  // single top-up as a permanent monthly increase.
  let addons = 0;
  const unpricedAddons: string[] = [];
  for (const [key, units] of Object.entries(row.addonUnits ?? {})) {
    if (!units || units <= 0) continue;
    if (!recurringAddon(key)) continue;
    const price = addonPriceMinor(key, row.billingRegion);
    if (price === null) {
      unpricedAddons.push(key);
      continue;
    }
    // Add-ons are quoted at their own price and do NOT take the monthly
    // uplift: the uplift is a plan-level term on the published price list.
    addons += price * units;
  }

  return {
    state: row.subStatus === "past_due" ? "at_risk" : "recurring",
    minor: base + addons,
    currency: row.currency ?? null,
    unpricedAddons,
  };
}

export interface CurrencyTotal {
  currency: string;
  recurringMinor: number;
  atRiskMinor: number;
  recurringClients: number;
  atRiskClients: number;
}

export interface MrrSummary {
  /**
   * Per currency, NEVER summed across them.
   *
   * INR and AED are different units and adding them produces a number that is
   * not money. The AE region is priced but not sellable today, so in practice
   * there is one currency - which is exactly why this must be structural: the
   * day a second one appears, a single total would quietly become nonsense
   * instead of failing.
   */
  byCurrency: CurrencyTotal[];
  trialing: number;
  cancelled: number;
  noSubscription: number;
  /** Tenants on a plan with no published price. Named on screen. */
  unpriced: number;
  /** Distinct add-on keys held at a price the price list does not carry. */
  unpricedAddons: string[];
}

export function summariseMrr(mrrs: readonly OrgMrr[]): MrrSummary {
  const byCurrency = new Map<string, CurrencyTotal>();
  const unpricedAddons = new Set<string>();
  let trialing = 0;
  let cancelled = 0;
  let noSubscription = 0;
  let unpriced = 0;

  for (const m of mrrs) {
    for (const a of m.unpricedAddons) unpricedAddons.add(a);
    if (m.state === "trialing") trialing++;
    else if (m.state === "cancelled") cancelled++;
    else if (m.state === "no_subscription") noSubscription++;
    else if (m.state === "unpriced") unpriced++;
    else {
      // A recurring tenant with no currency cannot happen - a price row
      // carries one - but defaulting to INR here would invent a denomination,
      // so it buckets under the empty string and shows up as wrong rather than
      // hiding inside a real total.
      const code = m.currency ?? "";
      const row =
        byCurrency.get(code) ??
        ({
          currency: code,
          recurringMinor: 0,
          atRiskMinor: 0,
          recurringClients: 0,
          atRiskClients: 0,
        } satisfies CurrencyTotal);
      if (m.state === "at_risk") {
        row.atRiskMinor += m.minor;
        row.atRiskClients++;
      } else {
        row.recurringMinor += m.minor;
        row.recurringClients++;
      }
      byCurrency.set(code, row);
    }
  }

  return {
    byCurrency: [...byCurrency.values()].sort((a, b) => b.recurringMinor - a.recurringMinor),
    trialing,
    cancelled,
    noSubscription,
    unpriced,
    unpricedAddons: [...unpricedAddons].sort(),
  };
}

export interface Concentration {
  /** Share of the largest single tenant, in basis points. */
  largestBp: number;
  /** Share of the three largest together, in basis points. */
  topThreeBp: number;
  /** How many tenants are in the denominator. */
  clients: number;
}

/**
 * How much of the revenue rests on one customer.
 *
 * Basis points rather than a rounded percentage because at four clients the
 * interesting differences are whole percentage points wide and rounding twice
 * (here, then again for display) can move the headline figure. Returns null for
 * an empty book: a concentration of 0% would read as "well diversified", which
 * is the opposite of what no revenue means.
 */
export function concentration(amountsMinor: readonly number[]): Concentration | null {
  const positive = amountsMinor.filter((a) => a > 0);
  if (positive.length === 0) return null;
  const total = positive.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const sorted = [...positive].sort((a, b) => b - a);
  const top3 = sorted.slice(0, 3).reduce((a, b) => a + b, 0);
  return {
    largestBp: Math.round((sorted[0]! / total) * 10_000),
    topThreeBp: Math.round((top3 / total) * 10_000),
    clients: positive.length,
  };
}

/**
 * One step of the CLIENT LIFECYCLE funnel.
 *
 * Named `LifecycleStep`, not `FunnelStep`: `performance-overview.ts` already
 * exports a `FunnelStep`, which is a telecaller's call-to-outcome funnel - a
 * different population measured for a different person. Two types with one name
 * in one barrel is an ambiguous re-export that fails the shared build, and even
 * if it did not, a reader would have to check which funnel they had.
 */
export interface LifecycleStep {
  key: string;
  label: string;
  count: number;
  /** What was counted, so a number on screen can be argued with. */
  evidence: string;
}

/**
 * The funnel's steps, in order, with each one's share of the step before it.
 *
 * ── WHY THE DROP IS COMPUTED HERE ───────────────────────────────────────────
 *
 * Doc 49's point about this chart is that a cohort which provisions and never
 * reaches "first transcript" is a refund queue. That only reads off the screen
 * if each step shows its share of the PREVIOUS step rather than of the first:
 * six steps all quoted against the top hide which one the cohort actually dies
 * at. The share of the first step is kept too, because both questions are real.
 */
export function lifecycleWithDrop(
  steps: readonly LifecycleStep[],
): Array<LifecycleStep & { ofPreviousBp: number | null; ofFirstBp: number | null }> {
  const first = steps[0]?.count ?? 0;
  return steps.map((step, i) => {
    const previous = i === 0 ? null : steps[i - 1]!.count;
    return {
      ...step,
      ofPreviousBp:
        previous === null || previous === 0 ? null : Math.round((step.count / previous) * 10_000),
      ofFirstBp: first === 0 ? null : Math.round((step.count / first) * 10_000),
    };
  });
}

/**
 * A month-over-month change, in basis points, or null when there is no basis.
 *
 * Null rather than 0 or 100% when the previous month was zero: growth from
 * nothing is not a percentage, and rendering "+100%" for a first customer is
 * the kind of flattering nonsense a commercial dashboard must not produce.
 */
export function deltaBp(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 10_000);
}
