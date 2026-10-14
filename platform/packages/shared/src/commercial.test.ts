import { describe, expect, it } from "vitest";
import {
  type OrgCommercialRow,
  concentration,
  deltaBp,
  lifecycleWithDrop,
  orgMrr,
  summariseMrr,
} from "./commercial";
import { MONTHLY_UPLIFT_BP, monthlyFromAnnual } from "./pricing";

/**
 * Every branch of the commercial arithmetic (doc 49 P13c).
 *
 * The thing being defended is narrow and worth naming: on this screen a wrong
 * number does not throw, does not look wrong, and gets acted on. So each case
 * below is one way the figure could be flattering - the uplift not applied, a
 * trial counted as revenue, an unpriced plan counted as zero, two currencies
 * added together, growth from nothing rendered as +100%.
 */

const GROWTH_IN = 1_269_900; // capture_growth, IN, annual-billed monthly, ex-tax

function row(over: Partial<OrgCommercialRow> = {}): OrgCommercialRow {
  return {
    orgId: "o1",
    subStatus: "active",
    billingPeriod: "annual",
    planKey: "capture_growth",
    annualMonthlyMinor: GROWTH_IN,
    currency: "INR",
    billingRegion: "IN",
    addonUnits: null,
    ...over,
  };
}

/** No add-on is priced, and none is recurring. The default for most cases. */
const noAddons = () => null;
const noneRecurring = () => false;

describe("orgMrr", () => {
  it("counts an annual-billed subscription at the stored price", () => {
    const m = orgMrr(row(), noAddons, noneRecurring);
    expect(m).toEqual({
      state: "recurring",
      minor: GROWTH_IN,
      currency: "INR",
      unpricedAddons: [],
    });
  });

  it("applies the monthly uplift to a monthly-billed subscription", () => {
    // The price list quotes the ANNUAL-billed monthly figure. Taking it for a
    // monthly-billed tenant too would understate MRR by the whole uplift for
    // every such tenant - 20% of them, silently.
    const m = orgMrr(row({ billingPeriod: "monthly" }), noAddons, noneRecurring);
    expect(m.minor).toBe(monthlyFromAnnual(GROWTH_IN));
    expect(m.minor).toBeGreaterThan(GROWTH_IN);
    expect(MONTHLY_UPLIFT_BP).toBe(2000);
  });

  it("gives a trial no revenue, and does not call it a loss", () => {
    const m = orgMrr(row({ subStatus: "trialing" }), noAddons, noneRecurring);
    expect(m.state).toBe("trialing");
    expect(m.minor).toBe(0);
  });

  it("keeps past_due as contracted-but-uncollected, not as revenue", () => {
    // Counting it in MRR overstates what we are collecting; dropping it to zero
    // hides a subscription that still exists and may yet pay. It is its own
    // state with its own amount.
    const m = orgMrr(row({ subStatus: "past_due" }), noAddons, noneRecurring);
    expect(m.state).toBe("at_risk");
    expect(m.minor).toBe(GROWTH_IN);
  });

  it("distinguishes a cancellation from a tenant that never had a subscription", () => {
    expect(orgMrr(row({ subStatus: "cancelled" }), noAddons, noneRecurring).state).toBe("cancelled");
    expect(orgMrr(row({ subStatus: null }), noAddons, noneRecurring).state).toBe("no_subscription");
  });

  it("refuses to treat an unpriced plan as a free one", () => {
    // Every `insights`-family plan is in this state today: no plan_prices row,
    // plans.price_minor NULL, nothing in pricing.ts. Zeroing it would
    // understate MRR by exactly the revenue nobody published a price for.
    const m = orgMrr(
      row({ planKey: "growth", annualMonthlyMinor: null, currency: null }),
      noAddons,
      noneRecurring,
    );
    expect(m.state).toBe("unpriced");
    expect(m.minor).toBe(0);
  });

  it("adds recurring add-ons at their own price, without the plan's uplift", () => {
    const m = orgMrr(
      row({ billingPeriod: "monthly", addonUnits: { extra_handsets: 3 } }),
      (key, region) => (key === "extra_handsets" && region === "IN" ? 50_000 : null),
      (key) => key === "extra_handsets",
    );
    // The uplift is a plan-level term on the published price list; applying it
    // to add-ons too would overcharge the dashboard relative to the invoice.
    expect(m.minor).toBe(monthlyFromAnnual(GROWTH_IN) + 3 * 50_000);
  });

  it("does NOT count a pack as recurring revenue", () => {
    // A pack is a credit spent inside one period. Counting it monthly would
    // book one top-up as a permanent increase, which is how a dashboard starts
    // reporting growth that never happened.
    const m = orgMrr(
      row({ addonUnits: { hours_pack_25: 2 } }),
      () => 99_900,
      () => false, // nothing is recurring
    );
    expect(m.minor).toBe(GROWTH_IN);
  });

  it("names an unpriced add-on instead of dropping the tenant's whole MRR", () => {
    const m = orgMrr(
      row({ addonUnits: { mystery_addon: 1 } }),
      () => null,
      () => true,
    );
    expect(m.state).toBe("recurring");
    expect(m.minor).toBe(GROWTH_IN);
    expect(m.unpricedAddons).toEqual(["mystery_addon"]);
  });

  it("ignores an add-on held at zero units", () => {
    const m = orgMrr(
      row({ addonUnits: { extra_handsets: 0 } }),
      () => 50_000,
      () => true,
    );
    expect(m.minor).toBe(GROWTH_IN);
  });
});

describe("summariseMrr", () => {
  it("never adds two currencies into one total", () => {
    // INR + AED is not money. One total would be a number nobody could spend.
    const s = summariseMrr([
      orgMrr(row(), noAddons, noneRecurring),
      orgMrr(
        row({ orgId: "o2", annualMonthlyMinor: 89_900, currency: "AED", billingRegion: "AE" }),
        noAddons,
        noneRecurring,
      ),
    ]);
    expect(s.byCurrency.map((c) => c.currency)).toEqual(["INR", "AED"]);
    expect(s.byCurrency.find((c) => c.currency === "INR")?.recurringMinor).toBe(GROWTH_IN);
    expect(s.byCurrency.find((c) => c.currency === "AED")?.recurringMinor).toBe(89_900);
  });

  it("counts each non-paying state separately", () => {
    // "₹0" is the same pixel for four different situations, and they call for
    // four different actions.
    const s = summariseMrr([
      orgMrr(row({ subStatus: "trialing" }), noAddons, noneRecurring),
      orgMrr(row({ subStatus: "cancelled" }), noAddons, noneRecurring),
      orgMrr(row({ subStatus: null }), noAddons, noneRecurring),
      orgMrr(row({ annualMonthlyMinor: null }), noAddons, noneRecurring),
    ]);
    expect(s).toMatchObject({
      trialing: 1,
      cancelled: 1,
      noSubscription: 1,
      unpriced: 1,
      byCurrency: [],
    });
  });

  it("keeps at-risk money out of the recurring total but still reports it", () => {
    const s = summariseMrr([
      orgMrr(row(), noAddons, noneRecurring),
      orgMrr(row({ orgId: "o2", subStatus: "past_due" }), noAddons, noneRecurring),
    ]);
    const inr = s.byCurrency[0]!;
    expect(inr.recurringMinor).toBe(GROWTH_IN);
    expect(inr.recurringClients).toBe(1);
    expect(inr.atRiskMinor).toBe(GROWTH_IN);
    expect(inr.atRiskClients).toBe(1);
  });

  it("collects unpriced add-on keys across the fleet, deduplicated", () => {
    const s = summariseMrr([
      orgMrr(row({ addonUnits: { b: 1 } }), () => null, () => true),
      orgMrr(row({ addonUnits: { a: 1, b: 2 } }), () => null, () => true),
    ]);
    expect(s.unpricedAddons).toEqual(["a", "b"]);
  });
});

describe("concentration", () => {
  it("reports the largest tenant's share, and the top three together", () => {
    const c = concentration([600, 200, 100, 100])!;
    expect(c.largestBp).toBe(6000);
    expect(c.topThreeBp).toBe(9000);
    expect(c.clients).toBe(4);
  });

  it("says 100% when one tenant is the whole book", () => {
    // At four clients this is a number that should frighten somebody, which is
    // doc 49's own reason for putting it on the screen.
    expect(concentration([500])).toMatchObject({ largestBp: 10_000, clients: 1 });
  });

  it("returns null for an empty book rather than 0%", () => {
    // 0% concentration reads as "well diversified". No revenue is not that.
    expect(concentration([])).toBeNull();
    expect(concentration([0, 0])).toBeNull();
  });
});

describe("lifecycleWithDrop", () => {
  const steps = [
    { key: "paid", label: "Paid", count: 100, evidence: "org_signups" },
    { key: "provisioned", label: "Provisioned", count: 90, evidence: "organizations" },
    { key: "call", label: "First call", count: 45, evidence: "calls" },
    { key: "transcript", label: "First transcript", count: 9, evidence: "calls COMPLETE" },
  ];

  it("shows each step against the one before it, which is where the cliff is", () => {
    const out = lifecycleWithDrop(steps);
    expect(out.map((s) => s.ofPreviousBp)).toEqual([null, 9000, 5000, 2000]);
    // Against the FIRST step, 45 and 9 are 45% and 9% - both bad, neither
    // locating the failure. Against the previous step, 20% names it exactly:
    // the cohort dies between first call and first transcript, which is P1.
    expect(out.map((s) => s.ofFirstBp)).toEqual([10_000, 9000, 4500, 900]);
  });

  it("gives null rather than a division by zero when a step is empty", () => {
    const out = lifecycleWithDrop([
      { key: "a", label: "A", count: 0, evidence: "x" },
      { key: "b", label: "B", count: 0, evidence: "y" },
    ]);
    expect(out[1]!.ofPreviousBp).toBeNull();
    expect(out[0]!.ofFirstBp).toBeNull();
  });
});

describe("deltaBp", () => {
  it("measures a month-over-month change in basis points", () => {
    expect(deltaBp(110, 100)).toBe(1000);
    expect(deltaBp(90, 100)).toBe(-1000);
  });

  it("refuses to render growth from nothing as a percentage", () => {
    // "+100%" for a first customer is flattering nonsense; the honest answer is
    // that there is no previous month to compare against.
    expect(deltaBp(500, 0)).toBeNull();
  });
});
