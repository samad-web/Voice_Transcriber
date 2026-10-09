import { describe, expect, it } from "vitest";

import { toMinor } from "./money";
import {
  FINANCE_METRICS,
  MetricKey,
  cac,
  collectionRate,
  compare,
  daysToCollect,
  dso,
  emptyTotals,
  freshnessLabel,
  gatewayFeeRate,
  metricSpec,
  netCollected,
  netMargin,
  refundRate,
  revenuePerCall,
  sumTotals,
  totalCosts,
} from "./finance-metrics";

function totals(overrides: Partial<ReturnType<typeof emptyTotals>> = {}) {
  return { ...emptyTotals(), ...overrides };
}

describe("the metric catalogue", () => {
  it("covers every key, once, with a drill-down", () => {
    expect(FINANCE_METRICS).toHaveLength(MetricKey.options.length);
    for (const metric of FINANCE_METRICS) {
      // §11 MUST: every number drills to its records. A metric without one is
      // a number an owner cannot verify.
      expect(metric.drillTo.startsWith("/owner/finance")).toBe(true);
      expect(metric.definition.length).toBeGreaterThan(10);
    }
  });

  it("throws on an unknown key", () => {
    expect(() => metricSpec("nope" as MetricKey)).toThrow();
  });
});

describe("sumTotals", () => {
  it("adds the flows", () => {
    const summed = sumTotals([
      totals({ collectedMinor: 100, costsMinor: 10, dealsClosed: 1 }),
      totals({ collectedMinor: 250, costsMinor: 5, dealsClosed: 2 }),
    ]);
    expect(summed.collectedMinor).toBe(350);
    expect(summed.costsMinor).toBe(15);
    expect(summed.dealsClosed).toBe(3);
  });

  it("takes the LAST balance rather than summing it", () => {
    // Summing thirty days of receivables would show thirty times the dues -
    // ₹3 crore against ₹10 lakh of real ones.
    const summed = sumTotals([
      totals({ outstandingMinor: 1_000_000, agingMinor: { ...emptyTotals().agingMinor, "0_30": 1_000_000 } }),
      totals({ outstandingMinor: 1_200_000, agingMinor: { ...emptyTotals().agingMinor, "0_30": 1_200_000 } }),
    ]);
    expect(summed.outstandingMinor).toBe(1_200_000);
    expect(summed.agingMinor["0_30"]).toBe(1_200_000);
  });

  it("pools the days-to-collect samples so a period's median is over the period", () => {
    const summed = sumTotals([
      totals({ daysToCollect: [1, 2] }),
      totals({ daysToCollect: [30] }),
    ]);
    expect(summed.daysToCollect).toEqual([1, 2, 30]);
  });

  it("is an empty period, not a crash, with no rows", () => {
    expect(sumTotals([]).collectedMinor).toBe(0);
    expect(sumTotals([]).outstandingMinor).toBe(0);
  });
});

describe("rates", () => {
  it("nets refunds out of collected", () => {
    const t = totals({ collectedMinor: toMinor("100000"), refundedMinor: toMinor("10000") });
    expect(netCollected(t)).toBe(toMinor("90000"));
  });

  it("counts fees and incentives as costs, so margin and CAC reconcile", () => {
    const t = totals({ costsMinor: 1_000, incentiveMinor: 500, feesMinor: 200 });
    expect(totalCosts(t)).toBe(1_700);
  });

  it("computes collection rate against what came due", () => {
    const t = totals({ billedMinor: toMinor("100000"), collectedMinor: toMinor("75000") });
    expect(collectionRate(t)).toBeCloseTo(0.75, 10);
  });

  it("is null for a month with nothing billed, not 0%", () => {
    // 0% would tell an owner they collected nothing when there was nothing to
    // collect.
    expect(collectionRate(totals())).toBeNull();
    expect(netMargin(totals())).toBeNull();
    expect(gatewayFeeRate(totals())).toBeNull();
    expect(refundRate(totals())).toBeNull();
    expect(dso(totals(), 30)).toBeNull();
    expect(cac(totals())).toBeNull();
    expect(revenuePerCall(totals(), 0)).toBeNull();
  });

  it("reports a negative margin rather than clamping it", () => {
    const t = totals({ collectedMinor: 100_000, costsMinor: 150_000 });
    expect(netMargin(t)).toBeCloseTo(-0.5, 10);
  });

  it("counts disputed money in the refund rate", () => {
    const t = totals({ collectedMinor: 100_000, refundedMinor: 5_000, disputedMinor: 5_000 });
    expect(refundRate(t)).toBeCloseTo(0.1, 10);
  });

  it("computes DSO over the period length", () => {
    const t = totals({ outstandingMinor: toMinor("50000"), billedMinor: toMinor("100000") });
    expect(dso(t, 30)).toBeCloseTo(15, 10);
  });

  it("divides CAC by first-payment customers", () => {
    const t = totals({ costsMinor: toMinor("100000"), newCustomers: 20 });
    expect(cac(t)).toBe(toMinor("5000"));
  });
});

describe("daysToCollect", () => {
  it("reports the median and p90, because the mean describes nobody", () => {
    // Right-skewed: most pay near the due date, a few take months. The mean of
    // this is 29, above all but one of the actual payments.
    const t = totals({ daysToCollect: [0, 1, 2, 3, 4, 5, 200] });
    const { median, p90 } = daysToCollect(t);
    expect(median).toBe(3);
    expect(p90).toBeGreaterThan(5);
    expect(p90).toBeLessThanOrEqual(200);
  });

  it("is null with no payments", () => {
    expect(daysToCollect(totals())).toEqual({ median: null, p90: null });
  });
});

describe("compare", () => {
  it("knows a rise in collections is good and a rise in dues is not", () => {
    // Same number, opposite news. A console that colours both green trains
    // people to ignore the colour.
    expect(compare("collected", 120, 100)).toEqual({ changePercent: 20, better: true });
    expect(compare("outstanding", 120, 100)).toEqual({ changePercent: 20, better: false });
    expect(compare("outstanding", 80, 100)).toEqual({ changePercent: -20, better: true });
  });

  it("has no verdict without two comparable periods", () => {
    expect(compare("collected", 100, null)).toEqual({ changePercent: null, better: null });
    expect(compare("collected", null, 100)).toEqual({ changePercent: null, better: null });
    expect(compare("collected", 100, 0)).toEqual({ changePercent: null, better: null });
  });

  it("has no verdict on no change", () => {
    expect(compare("collected", 100, 100)).toEqual({ changePercent: 0, better: null });
  });
});

describe("freshnessLabel", () => {
  const now = new Date("2026-03-01T15:42:00Z");

  it("states both facts §11 asks for", () => {
    const label = freshnessLabel(
      {
        computedAt: new Date("2026-03-01T15:42:00Z"),
        connectors: [{ type: "razorpay", lastEventAt: new Date("2026-03-01T15:39:00Z"), healthy: true }],
        live: false,
      },
      now,
    );
    expect(label).toContain("data as of ");
    expect(label).toContain("razorpay synced 3 min ago");
  });

  it("says plainly when a connector has never delivered anything", () => {
    const label = freshnessLabel(
      { computedAt: null, connectors: [{ type: "razorpay", lastEventAt: null, healthy: false }], live: true },
      now,
    );
    expect(label).toBe("live; razorpay has never synced");
  });

  it("admits when nothing has been computed yet", () => {
    expect(freshnessLabel({ computedAt: null, connectors: [], live: false }, now)).toBe(
      "not computed yet",
    );
  });

  it("scales the ago label past an hour and a day", () => {
    const label = freshnessLabel(
      {
        computedAt: now,
        connectors: [
          { type: "a", lastEventAt: new Date("2026-03-01T13:42:00Z"), healthy: true },
          { type: "b", lastEventAt: new Date("2026-02-26T15:42:00Z"), healthy: false },
        ],
        live: false,
      },
      now,
    );
    expect(label).toContain("a synced 2 h ago");
    expect(label).toContain("b synced 3 d ago");
  });
});
