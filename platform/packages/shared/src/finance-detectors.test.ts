import { describe, expect, it } from "vitest";

import { ADVISOR_RULES, advisorRule } from "./finance-advisor";
import {
  IMPLEMENTED_DETECTORS,
  decideAgingBreach,
  decideCallCostNoResults,
  decideCashRunwayLow,
  decideClosedUnpaid,
  decideConnectorUnhealthy,
  decideDiscountAbuse,
  decideDuplicateExpense,
  decideExpenseOutlier,
  decideFailedNotRetried,
  decideFeeDrift,
  decideIdleSpend,
  decideIncentiveNotClawedBack,
  decideNegativeRoiSource,
  decideRefundSpike,
  decideSettlementMismatch,
  decideSlippedPromise,
  decideUnmatchedMoney,
} from "./finance-detectors";
import { toMinor } from "./money";

/**
 * §14 M8's acceptance criterion, in full: "each seeded rule has a fixture test
 * that fires it and a test that does not."
 *
 * Seventeen rules, so at minimum thirty-four tests. Each pair is written as
 * the boundary rather than as an obvious yes and an obvious no - a rule that
 * fires on a clearly-broken fixture and stays quiet on a clearly-fine one
 * tells you almost nothing about the threshold, which is the only part of a
 * rule anybody ever tunes.
 */

const TODAY = "2026-03-15";
const NOW = new Date("2026-03-15T12:00:00Z");
const NO_PARAMS: Record<string, number> = {};

describe("the detector set", () => {
  it("covers every rule in §12.4's catalogue, and nothing else", () => {
    // A rule added to the catalogue without a decider would be a row in
    // `advisor_rules` that can never fire - a switch in the console with
    // nothing behind it, which is the defect the enforced-permission inventory
    // exists to prevent in its own domain.
    expect([...IMPLEMENTED_DETECTORS].sort()).toEqual(ADVISOR_RULES.map((r) => r.code).sort());
  });
});

// ── closed_unpaid ───────────────────────────────────────────────────────────

describe("closed_unpaid", () => {
  const candidate = {
    dealId: "d1",
    dealName: "Flat A-1203",
    customerName: "Sharma Textiles",
    closedOn: "2026-03-10",
    scheduledMinor: toMinor("500000"),
    collectedMinor: 0,
    currency: "INR",
  };

  it("fires once the deal is N days old with nothing received", () => {
    const verdict = decideClosedUnpaid(candidate, TODAY, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.amountAtRiskMinor).toBe(toMinor("500000"));
    expect(verdict.message).toContain("Sharma Textiles");
    expect(verdict.explain.records).toEqual([{ type: "deal", id: "d1", label: "Flat A-1203" }]);
  });

  it("does not fire a day early", () => {
    expect(decideClosedUnpaid({ ...candidate, closedOn: "2026-03-13" }, TODAY, NO_PARAMS).fire).toBe(
      false,
    );
    // And the boundary itself does fire - N=3, so three days exactly.
    expect(decideClosedUnpaid({ ...candidate, closedOn: "2026-03-12" }, TODAY, NO_PARAMS).fire).toBe(
      true,
    );
  });

  it("is cleared by ANY receipt, not only a full one", () => {
    // A customer who paid a deposit is in a different conversation;
    // aging_breach and slipped_promise cover what they still owe.
    const paid = { ...candidate, collectedMinor: toMinor("1") };
    expect(decideClosedUnpaid(paid, TODAY, NO_PARAMS).fire).toBe(false);
    expect(decideClosedUnpaid(paid, TODAY, NO_PARAMS).silentBecause).toContain("received");
  });

  it("honours a tuned threshold", () => {
    expect(decideClosedUnpaid(candidate, TODAY, { days: 10 }).fire).toBe(false);
  });
});

// ── slipped_promise ─────────────────────────────────────────────────────────

describe("slipped_promise", () => {
  const candidate = {
    scheduleItemId: "s1",
    dealId: "d1",
    customerName: "Sharma Textiles",
    promisedOn: "2026-03-12",
    outstandingMinor: toMinor("25000"),
    currency: "INR",
  };

  it("fires once the promise is past its grace day", () => {
    const verdict = decideSlippedPromise(candidate, TODAY, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.message).toBe(
      "Payment of ₹25,000.00 from Sharma Textiles promised for 2026-03-12 not received.",
    );
  });

  it("does not fire inside the grace day", () => {
    // Promised yesterday, grace 1: a customer who said "Friday" and pays on
    // Friday evening has not slipped.
    expect(
      decideSlippedPromise({ ...candidate, promisedOn: "2026-03-14" }, TODAY, NO_PARAMS).fire,
    ).toBe(false);
  });

  it("does not fire once the instalment is paid", () => {
    expect(decideSlippedPromise({ ...candidate, outstandingMinor: 0 }, TODAY, NO_PARAMS).fire).toBe(
      false,
    );
  });
});

// ── aging_breach ────────────────────────────────────────────────────────────

describe("aging_breach", () => {
  const candidate = {
    scheduleItemId: "s1",
    dealId: "d1",
    customerName: "Sharma Textiles",
    dueDate: "2026-02-10",
    outstandingMinor: toMinor("40000"),
    currency: "INR",
    alertedBucketDays: 0,
  };

  it("fires when a boundary is crossed for the first time", () => {
    // 33 days late: past 30, not past 60.
    const verdict = decideAgingBreach(candidate, TODAY, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.explain.inputs.boundary).toBe(30);
  });

  it("does not fire again for the SAME boundary", () => {
    // The thing that makes each boundary its own event: without this the rule
    // is true every day from 31 to 60, the dedupe index keeps refreshing the
    // 30-day alert, and "crossed 60 days" is never raised at all.
    const verdict = decideAgingBreach({ ...candidate, alertedBucketDays: 30 }, TODAY, NO_PARAMS);
    expect(verdict.fire).toBe(false);
    expect(verdict.silentBecause).toContain("30-day boundary");
  });

  it("fires again at the next boundary", () => {
    const verdict = decideAgingBreach(
      { ...candidate, dueDate: "2026-01-05", alertedBucketDays: 30 },
      TODAY,
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(true);
    expect(verdict.explain.inputs.boundary).toBe(60);
  });

  it("does not fire before 30 days", () => {
    expect(
      decideAgingBreach({ ...candidate, dueDate: "2026-03-01" }, TODAY, NO_PARAMS).fire,
    ).toBe(false);
  });
});

// ── unmatched_money ─────────────────────────────────────────────────────────

describe("unmatched_money", () => {
  const candidate = {
    paymentId: "p1",
    amountMinor: toMinor("25000"),
    currency: "INR",
    receivedAt: new Date("2026-03-13T09:00:00Z"),
    matchStatus: "unmatched",
  };

  it("fires once the money has sat unlinked past the threshold", () => {
    const verdict = decideUnmatchedMoney(candidate, NOW, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.amountAtRiskMinor).toBe(toMinor("25000"));
  });

  it("does not fire on money that arrived an hour ago", () => {
    // Otherwise this is the loudest rule in the product and the first one
    // anybody mutes.
    const fresh = { ...candidate, receivedAt: new Date("2026-03-15T11:00:00Z") };
    expect(decideUnmatchedMoney(fresh, NOW, NO_PARAMS).fire).toBe(false);
  });

  it("does not fire once somebody has linked it", () => {
    expect(
      decideUnmatchedMoney({ ...candidate, matchStatus: "matched" }, NOW, NO_PARAMS).fire,
    ).toBe(false);
  });

  it("still fires on a merely SUGGESTED match", () => {
    // A suggestion nobody confirmed is money still unaccounted for - §8's
    // whole point is that a weak match is offered, not applied.
    expect(
      decideUnmatchedMoney({ ...candidate, matchStatus: "suggested" }, NOW, NO_PARAMS).fire,
    ).toBe(true);
  });
});

// ── settlement_mismatch ─────────────────────────────────────────────────────

describe("settlement_mismatch", () => {
  const candidate = {
    settlementId: "st1",
    settledOn: "2026-03-14",
    netMinor: toMinor("95000"),
    bankCreditMinor: toMinor("94000"),
    currency: "INR",
  };

  it("fires when the bank credited something else", () => {
    const verdict = decideSettlementMismatch(candidate, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.amountAtRiskMinor).toBe(toMinor("1000"));
    expect(advisorRule("settlement_mismatch").severity).toBe("critical");
  });

  it("does not fire inside the ₹1 tolerance", () => {
    const near = { ...candidate, bankCreditMinor: toMinor("94999.50") };
    expect(decideSettlementMismatch(near, NO_PARAMS).fire).toBe(false);
  });

  it("does not fire before the statement has been reconciled", () => {
    // NULL means 'not checked yet', not 'nothing arrived'. Reading it as zero
    // would raise a critical alert on every settlement the moment it landed.
    expect(
      decideSettlementMismatch({ ...candidate, bankCreditMinor: null }, NO_PARAMS).fire,
    ).toBe(false);
  });

  it("fires on a bank credit that is too HIGH as well as too low", () => {
    const over = { ...candidate, bankCreditMinor: toMinor("96000") };
    const verdict = decideSettlementMismatch(over, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.amountAtRiskMinor).toBe(toMinor("1000"));
  });
});

// ── fee_drift ───────────────────────────────────────────────────────────────

describe("fee_drift", () => {
  const steady = [2.0, 2.05, 1.98, 2.02, 2.0, 2.01, 1.99, 2.0];

  it("fires on a step above the trailing average", () => {
    const verdict = decideFeeDrift(
      { feePercentSeries: steady, currentFeePercent: 2.5, collectedMinor: toMinor("1000000"), currency: "INR" },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(true);
    // The EXCESS fee, not the whole gateway bill. The trailing average of
    // `steady` is 2.00625%, so the excess is 0.49375pp of ₹10,00,000.
    expect(verdict.amountAtRiskMinor).toBe(toMinor("4937.50"));
  });

  it("does not fire on normal variation", () => {
    expect(
      decideFeeDrift(
        { feePercentSeries: steady, currentFeePercent: 2.1, collectedMinor: toMinor("1000000"), currency: "INR" },
        NO_PARAMS,
      ).fire,
    ).toBe(false);
  });

  it("stays silent below the minimum sample rather than guessing", () => {
    const verdict = decideFeeDrift(
      { feePercentSeries: [2, 2.5, 3], currentFeePercent: 5, collectedMinor: 100, currency: "INR" },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(false);
    expect(verdict.silentBecause).toBe("insufficient_sample");
    expect(verdict.explain.sampleSize).toBe(3);
  });

  it("catches a shift the step test cannot see, via the control chart", () => {
    // ── THE CASE THE SECOND TEST EXISTS FOR ────────────────────────────────
    //
    // A step up from 2.0% to 2.3% half way through the window. The trailing
    // AVERAGE is now 2.15%, so the current rate is only 0.15pp above it -
    // under the 0.3pp step threshold, and the step test says nothing. The
    // average has absorbed the very change we are looking for, which is
    // exactly the failure §12.4 asks for an EWMA chart to cover.
    const shifted = [2.0, 2.02, 1.98, 2.0, 2.3, 2.32, 2.28, 2.3];
    const verdict = decideFeeDrift(
      {
        feePercentSeries: shifted,
        currentFeePercent: 2.3,
        collectedMinor: toMinor("1000000"),
        currency: "INR",
      },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(true);
    expect(verdict.explain.formula).toContain("EWMA");
    // And the step test really would have missed it, which is the half of this
    // test that could silently stop being true.
    const mean = shifted.reduce((a, b) => a + b, 0) / shifted.length;
    expect(2.3 - mean).toBeLessThan(0.3);
  });

  it("reports the step test when the step test is what fired", () => {
    // A sharp repricing: both tests would fire, and the step one is the
    // clearer explanation to put in front of somebody.
    const steadyThenJump = [2.0, 2.05, 1.98, 2.02, 2.0, 2.01, 1.99, 2.0];
    const verdict = decideFeeDrift(
      {
        feePercentSeries: steadyThenJump,
        currentFeePercent: 3.0,
        collectedMinor: toMinor("1000000"),
        currency: "INR",
      },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(true);
    expect(verdict.explain.formula).toContain("trailing");
  });
});

// ── failed_not_retried ──────────────────────────────────────────────────────

describe("failed_not_retried", () => {
  const candidate = {
    paymentId: "p1",
    customerName: "Sharma Textiles",
    dealId: "d1",
    amountMinor: toMinor("25000"),
    currency: "INR",
    failedOn: "2026-03-12",
    lastAttemptOn: null,
  };

  it("fires when nothing has been tried since the failure", () => {
    expect(decideFailedNotRetried(candidate, TODAY, NO_PARAMS).fire).toBe(true);
  });

  it("does not fire when a later attempt was made", () => {
    expect(
      decideFailedNotRetried({ ...candidate, lastAttemptOn: "2026-03-13" }, TODAY, NO_PARAMS).fire,
    ).toBe(false);
  });

  it("does not fire within the grace days", () => {
    expect(
      decideFailedNotRetried({ ...candidate, failedOn: "2026-03-14" }, TODAY, NO_PARAMS).fire,
    ).toBe(false);
  });

  it("ignores an EARLIER attempt, which is not a retry", () => {
    expect(
      decideFailedNotRetried({ ...candidate, lastAttemptOn: "2026-03-01" }, TODAY, NO_PARAMS).fire,
    ).toBe(true);
  });
});

// ── refund_spike ────────────────────────────────────────────────────────────

describe("refund_spike", () => {
  const baseline = [0.01, 0.012, 0.009, 0.011, 0.01, 0.013, 0.008, 0.01];

  it("fires when the rate is more than 2.5 sigma above baseline", () => {
    const verdict = decideRefundSpike(
      { rateSeries: baseline, currentRate: 0.08, refundedMinor: toMinor("80000"), currency: "INR" },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(true);
    expect(verdict.amountAtRiskMinor).toBe(toMinor("80000"));
  });

  it("does not fire on a rate inside the band", () => {
    expect(
      decideRefundSpike(
        { rateSeries: baseline, currentRate: 0.012, refundedMinor: 1000, currency: "INR" },
        NO_PARAMS,
      ).fire,
    ).toBe(false);
  });

  it("does NOT fire when refunds FALL sharply - that is good news", () => {
    // A two-sided test would alert on a good month, which is the fastest way
    // to teach somebody that the inbox is noise.
    const verdict = decideRefundSpike(
      { rateSeries: baseline, currentRate: 0, refundedMinor: 0, currency: "INR" },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(false);
  });

  it("stays silent below the minimum sample", () => {
    expect(
      decideRefundSpike(
        { rateSeries: [0.01, 0.2], currentRate: 0.5, refundedMinor: 100, currency: "INR" },
        NO_PARAMS,
      ).silentBecause,
    ).toBe("insufficient_sample");
  });
});

// ── duplicate_expense ───────────────────────────────────────────────────────

describe("duplicate_expense", () => {
  const candidate = {
    expenseId: "e1",
    otherExpenseId: "e2",
    vendor: "Airtel",
    amountMinor: toMinor("12000"),
    currency: "INR",
    incurredOn: "2026-03-10",
    otherIncurredOn: "2026-03-12",
    alreadyReversed: false,
  };

  it("fires on the same vendor and amount within the window", () => {
    const verdict = decideDuplicateExpense(candidate, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.explain.records).toHaveLength(2);
  });

  it("does not fire when the two are a month apart", () => {
    // A monthly bill IS the same vendor and amount every month. Without the
    // window this rule would flag every subscription a tenant has.
    expect(
      decideDuplicateExpense({ ...candidate, otherIncurredOn: "2026-02-10" }, NO_PARAMS).fire,
    ).toBe(false);
  });

  it("does not fire once one of the pair has been reversed", () => {
    expect(decideDuplicateExpense({ ...candidate, alreadyReversed: true }, NO_PARAMS).fire).toBe(
      false,
    );
  });
});

// ── expense_outlier ─────────────────────────────────────────────────────────

describe("expense_outlier", () => {
  const rent = [45_000, 45_000, 45_000, 45_000, 45_000, 45_000, 45_000, 45_000];
  const varied = [40_000, 42_000, 38_000, 41_000, 39_000, 43_000, 37_000, 40_000];

  it("fires on a category that spent far outside its usual range", () => {
    const verdict = decideExpenseOutlier(
      { category: "telephony", series: varied, currentMinor: 400_000, currency: "INR" },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(true);
    // The EXCESS over the median, not the whole month's spend.
    expect(verdict.amountAtRiskMinor).toBe(400_000 - 40_000);
  });

  it("does not fire inside the range", () => {
    expect(
      decideExpenseOutlier(
        { category: "telephony", series: varied, currentMinor: 41_000, currency: "INR" },
        NO_PARAMS,
      ).fire,
    ).toBe(false);
  });

  it("stays silent on a perfectly flat series instead of firing on ₹100", () => {
    // MAD is 0 for rent of exactly ₹45,000 every month, so the formula divides
    // by zero and ANY change looks like a 3.5-sigma event.
    const verdict = decideExpenseOutlier(
      { category: "rent", series: rent, currentMinor: 45_100, currency: "INR" },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(false);
    expect(verdict.silentBecause).toBe("no_dispersion");
  });

  it("does not fire when a category spent far LESS than usual", () => {
    const verdict = decideExpenseOutlier(
      { category: "advertising", series: varied, currentMinor: 0, currency: "INR" },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(false);
    expect(verdict.silentBecause).toContain("not a leak");
  });

  it("stays silent below the minimum sample", () => {
    expect(
      decideExpenseOutlier(
        { category: "travel", series: [100, 200], currentMinor: 99_999, currency: "INR" },
        NO_PARAMS,
      ).silentBecause,
    ).toBe("insufficient_sample");
  });
});

// ── discount_abuse ──────────────────────────────────────────────────────────

describe("discount_abuse", () => {
  it("fires on deals discounted above policy, and prices the GIVEAWAY", () => {
    const verdict = decideDiscountAbuse(
      {
        userId: "u1",
        userName: "Priya",
        overPolicyDeals: [
          { dealId: "d1", discountPercent: 20, valueMinor: toMinor("100000") },
          { dealId: "d2", discountPercent: 15, valueMinor: toMinor("100000") },
        ],
        currency: "INR",
      },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(true);
    // 10pp over on ₹1L + 5pp over on ₹1L = ₹10,000 + ₹5,000. NOT ₹2,00,000 of
    // deal value, which would dominate the leak report and be wrong by 13x.
    expect(verdict.amountAtRiskMinor).toBe(toMinor("15000"));
    expect(verdict.message).toContain("Priya");
  });

  it("does not fire when every discount is inside policy", () => {
    expect(
      decideDiscountAbuse(
        {
          userId: "u1",
          userName: "Priya",
          overPolicyDeals: [{ dealId: "d1", discountPercent: 8, valueMinor: toMinor("100000") }],
          currency: "INR",
        },
        NO_PARAMS,
      ).fire,
    ).toBe(false);
  });

  it("respects a tenant's own policy percentage", () => {
    const deals = [{ dealId: "d1", discountPercent: 15, valueMinor: toMinor("100000") }];
    const candidate = { userId: "u1", userName: "Priya", overPolicyDeals: deals, currency: "INR" };
    expect(decideDiscountAbuse(candidate, { policyPercent: 20 }).fire).toBe(false);
    expect(decideDiscountAbuse(candidate, { policyPercent: 5 }).fire).toBe(true);
  });
});

// ── negative_roi_source ─────────────────────────────────────────────────────

describe("negative_roi_source", () => {
  const candidate = {
    sourceId: "src1",
    sourceName: "Facebook - March",
    costMinor: toMinor("120000"),
    revenueMinor: toMinor("40000"),
    weeks: 6,
    currency: "INR",
  };

  it("fires when a source costs more than it earns over the window", () => {
    const verdict = decideNegativeRoiSource(candidate, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.amountAtRiskMinor).toBe(toMinor("80000"));
  });

  it("does not fire when revenue covers the cost", () => {
    expect(
      decideNegativeRoiSource({ ...candidate, revenueMinor: toMinor("200000") }, NO_PARAMS).fire,
    ).toBe(false);
  });

  it("does not judge a campaign on two weeks", () => {
    expect(decideNegativeRoiSource({ ...candidate, weeks: 2 }, NO_PARAMS).fire).toBe(false);
  });

  it("does not fire on a source with no cost recorded", () => {
    // Zero cost and zero revenue is a source nobody has spent on, not a leak.
    expect(
      decideNegativeRoiSource({ ...candidate, costMinor: 0, revenueMinor: 0 }, NO_PARAMS).fire,
    ).toBe(false);
  });
});

// ── call_cost_no_results ────────────────────────────────────────────────────

describe("call_cost_no_results", () => {
  const spend = [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 20_000, 20_000];
  const flat = [50, 50, 50, 50, 50, 50, 45, 44];

  it("fires when spend climbs and conversions do not", () => {
    const verdict = decideCallCostNoResults(
      { spendSeries: spend, conversionSeries: flat, currency: "INR" },
      NO_PARAMS,
    );
    expect(verdict.fire).toBe(true);
    expect(verdict.explain.inputs.spendChange).toBe(100);
  });

  it("does not fire when conversions climb with the spend", () => {
    const rising = [50, 50, 50, 50, 50, 50, 90, 95];
    expect(
      decideCallCostNoResults(
        { spendSeries: spend, conversionSeries: rising, currency: "INR" },
        NO_PARAMS,
      ).fire,
    ).toBe(false);
  });

  it("does not fire on a spend rise that is just a longer month", () => {
    // A 5% rise is a working day, not a decision. Without the 10% floor this
    // would fire most months.
    const nudge = [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_300, 10_200];
    expect(
      decideCallCostNoResults(
        { spendSeries: nudge, conversionSeries: flat, currency: "INR" },
        NO_PARAMS,
      ).fire,
    ).toBe(false);
  });

  it("stays silent below the minimum sample", () => {
    expect(
      decideCallCostNoResults(
        { spendSeries: [1, 100], conversionSeries: [10, 1], currency: "INR" },
        NO_PARAMS,
      ).silentBecause,
    ).toBe("insufficient_sample");
  });
});

// ── incentive_not_clawed_back ───────────────────────────────────────────────

describe("incentive_not_clawed_back", () => {
  const candidate = {
    refundId: "r1",
    userId: "u1",
    userName: "Priya",
    paidIncentiveMinor: toMinor("2500"),
    refundedOn: "2026-03-10",
    paymentReceivedOn: "2026-02-20",
    clawbackDays: 90,
    clawedBack: false,
    currency: "INR",
  };

  it("fires when a refunded sale's incentive was never reversed", () => {
    const verdict = decideIncentiveNotClawedBack(candidate, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.amountAtRiskMinor).toBe(toMinor("2500"));
  });

  it("does not fire once the clawback line exists", () => {
    expect(decideIncentiveNotClawedBack({ ...candidate, clawedBack: true }, NO_PARAMS).fire).toBe(
      false,
    );
  });

  it("does not fire outside the plan's own clawback window", () => {
    // Past the window the money is legitimately the rep's. Alerting would be
    // asking somebody to break their own compensation agreement.
    const old = { ...candidate, paymentReceivedOn: "2025-06-01" };
    expect(decideIncentiveNotClawedBack(old, NO_PARAMS).fire).toBe(false);
  });

  it("does not fire when no incentive was paid on that sale", () => {
    expect(
      decideIncentiveNotClawedBack({ ...candidate, paidIncentiveMinor: 0 }, NO_PARAMS).fire,
    ).toBe(false);
  });
});

// ── idle_spend ──────────────────────────────────────────────────────────────

describe("idle_spend", () => {
  const candidate = {
    expenseId: "e1",
    vendor: "Zoho",
    monthlyMinor: toMinor("4000"),
    currency: "INR",
    lastUsedOn: "2026-01-10",
    recurs: "monthly" as string | null,
  };

  it("fires on a recurring cost nobody has used for a month", () => {
    expect(decideIdleSpend(candidate, TODAY, NO_PARAMS).fire).toBe(true);
  });

  it("does not fire on something used last week", () => {
    expect(decideIdleSpend({ ...candidate, lastUsedOn: "2026-03-10" }, TODAY, NO_PARAMS).fire).toBe(
      false,
    );
  });

  it("does NOT fire when no usage signal is recorded at all", () => {
    // `last_used_on` is NULL for every recurring cost nobody has wired a usage
    // signal to - which is most of them. Firing on NULL would raise an alert
    // for every subscription the tenant has, on day one.
    const verdict = decideIdleSpend({ ...candidate, lastUsedOn: null }, TODAY, NO_PARAMS);
    expect(verdict.fire).toBe(false);
    expect(verdict.silentBecause).toContain("no usage signal");
  });

  it("does not fire on a one-off cost", () => {
    expect(decideIdleSpend({ ...candidate, recurs: null }, TODAY, NO_PARAMS).fire).toBe(false);
  });
});

// ── cash_runway_low ─────────────────────────────────────────────────────────

describe("cash_runway_low", () => {
  const candidate = {
    troughMinor: toMinor("-50000"),
    troughOn: "2026-04-02",
    minimumCashMinor: toMinor("100000"),
    horizonDays: 30,
    lowConfidence: false,
    currency: "INR",
  };

  it("fires when the forecast crosses the owner's floor", () => {
    const verdict = decideCashRunwayLow(candidate, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.amountAtRiskMinor).toBe(toMinor("150000"));
    expect(verdict.message).toContain("2026-04-02");
  });

  it("does not fire when the forecast stays above it", () => {
    expect(
      decideCashRunwayLow({ ...candidate, troughMinor: toMinor("500000") }, NO_PARAMS).fire,
    ).toBe(false);
  });

  it("stays quiet on a low-confidence forecast that merely dips below the floor", () => {
    // A low-confidence forecast is mostly conservative priors, so it dips
    // below a non-zero floor for almost any new tenant. A CRITICAL alert on
    // that is how somebody learns to ignore the most important rule here.
    const thin = { ...candidate, troughMinor: toMinor("50000"), lowConfidence: true };
    expect(decideCashRunwayLow(thin, NO_PARAMS).fire).toBe(false);
  });

  it("STILL fires on a low-confidence forecast that goes negative", () => {
    // "You may run out of money" is worth saying even on thin data. That
    // asymmetry is the whole of the confidence branch.
    const thin = { ...candidate, lowConfidence: true };
    expect(decideCashRunwayLow(thin, NO_PARAMS).fire).toBe(true);
  });
});

// ── connector_unhealthy ─────────────────────────────────────────────────────

describe("connector_unhealthy", () => {
  const candidate = {
    connectorAccountId: "c1",
    type: "razorpay",
    status: "connected",
    lastEventAt: new Date("2026-03-13T12:00:00Z"),
    consecutiveFailures: 0,
  };

  it("fires when a connected gateway has gone quiet for a day", () => {
    const verdict = decideConnectorUnhealthy(candidate, NOW, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    // §12.4 gives this rule no amount - money is not at risk, ingestion is.
    // Inventing a figure would distort a leak report that ranks by rupees.
    expect(verdict.amountAtRiskMinor).toBeNull();
  });

  it("does not fire on a gateway that delivered an hour ago", () => {
    const fresh = { ...candidate, lastEventAt: new Date("2026-03-15T11:00:00Z") };
    expect(decideConnectorUnhealthy(fresh, NOW, NO_PARAMS).fire).toBe(false);
  });

  it("fires on repeated failures even when events are arriving", () => {
    const failing = {
      ...candidate,
      lastEventAt: new Date("2026-03-15T11:00:00Z"),
      consecutiveFailures: 6,
    };
    const verdict = decideConnectorUnhealthy(failing, NOW, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.explain.formula).toContain("consecutive failures");
  });

  it("does not fire on a connector that was disconnected on purpose", () => {
    // Otherwise a tenant who switched gateways gets a permanent alert about
    // the old one.
    expect(
      decideConnectorUnhealthy({ ...candidate, status: "disconnected", lastEventAt: null }, NOW, NO_PARAMS)
        .fire,
    ).toBe(false);
  });

  it("fires on a connector that has NEVER delivered anything", () => {
    const verdict = decideConnectorUnhealthy({ ...candidate, lastEventAt: null }, NOW, NO_PARAMS);
    expect(verdict.fire).toBe(true);
    expect(verdict.explain.inputs.quietHours).toBeNull();
  });
});

// ── §12.6's explain panel, for every rule that fires ────────────────────────

describe("the explain payload", () => {
  it("carries a formula and the inputs on every firing verdict", () => {
    // §12 requires an alert to "show the rule that fired, the calculation, and
    // links to the underlying records". A verdict with an empty formula would
    // render an explain panel with nothing in it, which is the same as not
    // having one.
    const firing = [
      decideClosedUnpaid(
        {
          dealId: "d",
          dealName: "n",
          customerName: null,
          closedOn: "2026-03-01",
          scheduledMinor: 1,
          collectedMinor: 0,
          currency: "INR",
        },
        TODAY,
        NO_PARAMS,
      ),
      decideSlippedPromise(
        {
          scheduleItemId: "s",
          dealId: "d",
          customerName: null,
          promisedOn: "2026-03-01",
          outstandingMinor: 1,
          currency: "INR",
        },
        TODAY,
        NO_PARAMS,
      ),
      decideSettlementMismatch(
        { settlementId: "x", settledOn: TODAY, netMinor: 1000, bankCreditMinor: 0, currency: "INR" },
        NO_PARAMS,
      ),
    ];
    for (const verdict of firing) {
      expect(verdict.fire).toBe(true);
      expect(verdict.explain.formula.length).toBeGreaterThan(5);
      expect(Object.keys(verdict.explain.inputs).length).toBeGreaterThan(0);
      expect(verdict.explain.silentBecause).toBeNull();
      expect(verdict.message.length).toBeGreaterThan(5);
    }
  });

  it("explains its SILENCE too, which is what makes a quiet inbox trustworthy", () => {
    const quiet = decideExpenseOutlier(
      { category: "rent", series: [1, 2], currentMinor: 999, currency: "INR" },
      NO_PARAMS,
    );
    expect(quiet.fire).toBe(false);
    expect(quiet.explain.silentBecause).toBe("insufficient_sample");
    expect(quiet.explain.sampleSize).toBe(2);
  });
});
