import { describe, expect, it } from "vitest";

import {
  COLLECTION_PRIORS,
  EWMA_LAMBDA,
  HEALTH_WEIGHTS,
  MIN_SAMPLE_DEFAULT,
  collectionProbabilities,
  driftTest,
  ewma,
  forecast,
  healthScore,
  mad,
  median,
  modifiedZScore,
  outlierTest,
  percentile,
  runwayMonths,
  weightedRunRate,
  zScore,
} from "./finance-stats";

describe("percentile", () => {
  it("interpolates the way a spreadsheet does, so an owner's own check agrees", () => {
    const values = [1, 2, 3, 4];
    expect(percentile(values, 0.5)).toBe(2.5);
    expect(percentile(values, 0.25)).toBe(1.75);
    expect(percentile(values, 0.9)).toBeCloseTo(3.7, 10);
  });

  it("handles the degenerate sizes rather than returning NaN", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
    expect(median([5, 1, 3])).toBe(3);
  });
});

describe("mad / modifiedZScore", () => {
  it("is not dragged by one extreme value, which is why the spec asks for it", () => {
    const normal = [10, 11, 9, 10, 11, 10, 9, 10];
    const withWhopper = [...normal, 1000];
    // The median barely moves and the MAD does not blow up, so the outlier is
    // still detectable - which is exactly what a standard deviation loses.
    expect(median(withWhopper)).toBe(10);
    // Deviations from the median are 0,1,1,0,1,0,1,0 - whose own median is the
    // interpolated 0.5, not 1. Worth pinning: MAD is a median OF deviations,
    // and reading it as "the typical deviation" rounds it up.
    expect(mad(normal)).toBe(0.5);
    const z = modifiedZScore(1000, withWhopper);
    expect(z).not.toBeNull();
    expect(Math.abs(z as number)).toBeGreaterThan(3.5);
  });

  it("returns null when more than half the sample is identical", () => {
    // Rent of exactly ₹45,000 every month has a MAD of 0. The formula would
    // divide by zero and call a ₹100 rise a 3.5-sigma event.
    expect(mad([45000, 45000, 45000, 45000])).toBe(0);
    expect(modifiedZScore(45100, [45000, 45000, 45000, 45000])).toBeNull();
  });
});

describe("outlierTest", () => {
  const steady = [100, 102, 98, 101, 99, 100, 103, 97];

  it("stays silent below the minimum sample rather than guessing", () => {
    const verdict = outlierTest(500, [100, 102, 98]);
    expect(verdict.flagged).toBe(false);
    expect(verdict.silentBecause).toBe("insufficient_sample");
    expect(verdict.sampleSize).toBe(3);
  });

  it("fires on a genuine outlier once there is enough history", () => {
    const verdict = outlierTest(400, steady);
    expect(verdict.flagged).toBe(true);
    expect(verdict.silentBecause).toBeNull();
    expect(verdict.modifiedZ).not.toBeNull();
  });

  it("does not fire inside the band, and says so", () => {
    const verdict = outlierTest(104, steady);
    expect(verdict.flagged).toBe(false);
    expect(verdict.silentBecause).toBe("within_band");
  });

  it("explains a zero-dispersion refusal instead of firing on it", () => {
    const flat = Array.from({ length: MIN_SAMPLE_DEFAULT }, () => 45_000);
    const verdict = outlierTest(45_100, flat);
    expect(verdict.flagged).toBe(false);
    expect(verdict.silentBecause).toBe("no_dispersion");
  });
});

describe("zScore", () => {
  it("is the ordinary sigma test the refund-spike rule is specified in", () => {
    const sample = [1, 1, 1, 1, 1, 1, 1, 1];
    expect(zScore(1, sample)).toBeNull(); // no spread at all
    const varied = [1, 2, 1, 2, 1, 2, 1, 2];
    const z = zScore(6, varied);
    expect(z).not.toBeNull();
    expect(z as number).toBeGreaterThan(2.5);
  });

  it("needs two points before it means anything", () => {
    expect(zScore(5, [5])).toBeNull();
    expect(zScore(5, [])).toBeNull();
  });
});

describe("ewma / driftTest", () => {
  it("smooths toward the latest level", () => {
    const smoothed = ewma([10, 10, 10, 20], EWMA_LAMBDA);
    expect(smoothed[0]).toBe(10);
    expect(smoothed.at(-1)).toBeCloseTo(12, 10);
  });

  it("catches a slow climb that no outlier test would ever flag", () => {
    // A fee creeping up 0.05pp a week is never an outlier against its own
    // trailing window, because the window climbs with it.
    const creeping = [2.0, 2.05, 2.1, 2.15, 2.2, 2.3, 2.4, 2.5, 2.7, 2.9, 3.1, 3.3];
    expect(outlierTest(3.3, creeping).flagged).toBe(false);
    expect(driftTest(creeping).flagged).toBe(true);
  });

  it("stays quiet on a series that is merely noisy", () => {
    const noisy = [2.0, 2.1, 1.9, 2.05, 1.95, 2.0, 2.1, 1.9, 2.0, 2.05];
    expect(driftTest(noisy).flagged).toBe(false);
    expect(driftTest(noisy).silentBecause).toBe("within_limits");
  });

  it("refuses below the minimum sample, and on a flat baseline", () => {
    expect(driftTest([1, 2, 3]).silentBecause).toBe("insufficient_sample");
    expect(driftTest(Array.from({ length: 10 }, () => 5)).silentBecause).toBe("no_dispersion");
  });
});

describe("weightedRunRate", () => {
  it("weights the recent weeks higher than the old ones", () => {
    const flat = weightedRunRate([100, 100, 100, 100]);
    expect(flat).toBe(100);
    // A floor that doubled last month is not averaged back down by a quiet quarter.
    const growing = weightedRunRate([50, 50, 50, 200]);
    expect(growing as number).toBeGreaterThan(100);
  });

  it("is null with no history", () => {
    expect(weightedRunRate([])).toBeNull();
  });
});

describe("collectionProbabilities", () => {
  it("falls back to conservative priors and says the forecast is low confidence", () => {
    const p = collectionProbabilities([]);
    expect(p.byBucket).toEqual(COLLECTION_PRIORS);
    expect(p.lowConfidence).toBe(true);
    expect(p.learned).toEqual([]);
  });

  it("moves toward the org's own experience as history accumulates", () => {
    // This org collects almost everything, even when late. With a lot of
    // history the 31-60 bucket should read far above the 0.5 prior.
    const p = collectionProbabilities([
      { bucket: "31_60", billedMinor: 100_000_000, collectedMinor: 95_000_000 },
    ]);
    expect(p.byBucket["31_60"]).toBeGreaterThan(0.85);
    expect(p.learned).toContain("31_60");
  });

  it("does not lurch the day the Nth invoice lands", () => {
    // Shrinkage, not a switch: a little history moves the estimate a little.
    const thin = collectionProbabilities([
      { bucket: "0_30", billedMinor: 100_000, collectedMinor: 100_000 },
    ]);
    expect(thin.byBucket["0_30"]).toBeGreaterThan(COLLECTION_PRIORS["0_30"]);
    expect(thin.byBucket["0_30"]).toBeLessThan(0.76);
    expect(thin.learned).not.toContain("0_30");
  });
});

describe("forecast", () => {
  const base = {
    from: "2026-02-01",
    horizonDays: 30,
    openingBalanceMinor: 10_000_000,
    probabilities: collectionProbabilities([]),
    newSalesPerDayMinor: 0,
    outflows: [],
    scheduled: [],
  };

  it("discounts scheduled money by the bucket's collection probability", () => {
    const [low, mid, high] = forecast({
      ...base,
      scheduled: [{ dueDate: "2026-02-10", amountMinor: 10_000_000, bucket: "current" }],
    });
    // 90% prior on `current`, and the base scenario applies no band factor.
    const inflow = mid.points.find((p) => p.date === "2026-02-10")?.inflowMinor;
    expect(inflow).toBe(9_000_000);
    expect(low.points.find((p) => p.date === "2026-02-10")?.inflowMinor).toBe(7_200_000);
    expect(high.points.find((p) => p.date === "2026-02-10")?.inflowMinor).toBe(10_800_000);
  });

  it("scales inflow but NOT outflow in the low scenario", () => {
    // Rent is paid whatever happens. A 'low' scenario that also assumed costs
    // came in low is the pleasant kind of pessimism that never warns anybody.
    const [low] = forecast({
      ...base,
      outflows: [{ on: "2026-02-05", amountMinor: 4_500_000 }],
      scheduled: [{ dueDate: "2026-02-05", amountMinor: 1_000_000, bucket: "current" }],
    });
    const day = low.points.find((p) => p.date === "2026-02-05");
    expect(day?.outflowMinor).toBe(4_500_000);
    expect(day?.inflowMinor).toBe(720_000);
  });

  it("finds the trough, which is what the runway alert fires on", () => {
    const [, mid] = forecast({
      ...base,
      openingBalanceMinor: 5_000_000,
      outflows: [{ on: "2026-02-15", amountMinor: 6_000_000 }],
      scheduled: [{ dueDate: "2026-02-20", amountMinor: 10_000_000, bucket: "current" }],
    });
    expect(mid.troughOn).toBe("2026-02-15");
    expect(mid.troughMinor).toBe(-1_000_000);
    // And it recovers afterwards, so the trough is not simply the last point.
    expect(mid.points.at(-1)?.balanceMinor).toBeGreaterThan(0);
  });

  it("applies day-of-month seasonality to new sales only", () => {
    const [, mid] = forecast({
      ...base,
      horizonDays: 3,
      newSalesPerDayMinor: 100_000,
      seasonality: { 2: 2 },
    });
    expect(mid.points.map((p) => p.inflowMinor)).toEqual([100_000, 200_000, 100_000]);
  });

  it("produces one point per day of the horizon", () => {
    const [, mid] = forecast({ ...base, horizonDays: 90 });
    expect(mid.points).toHaveLength(90);
    expect(mid.points[0].date).toBe("2026-02-01");
    expect(mid.points.at(-1)?.date).toBe("2026-05-01");
  });
});

describe("runwayMonths", () => {
  it("is null for a business that is making money, not a negative number", () => {
    expect(runwayMonths(10_000_000, -500_000)).toBeNull();
    expect(runwayMonths(10_000_000, 0)).toBeNull();
  });

  it("divides cash by burn", () => {
    expect(runwayMonths(10_000_000, 2_500_000)).toBe(4);
  });
});

describe("healthScore", () => {
  it("scores a healthy business near 100 and shows every component", () => {
    const result = healthScore({
      collectionRate: 0.96,
      netMargin: 0.25,
      runwayMonths: 8,
      leakageRatio: 0,
      dso: 25,
    });
    expect(result.score).toBe(100);
    expect(result.components).toHaveLength(5);
    expect(result.components.map((c) => c.weight).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("scores an unhealthy one low, and the components say which part", () => {
    const result = healthScore({
      collectionRate: 0.4,
      netMargin: -0.1,
      runwayMonths: 1,
      leakageRatio: 0.08,
      dso: 85,
    });
    expect(result.score).toBeLessThan(40);
    expect(result.components.find((c) => c.key === "netMargin")?.normalised).toBe(0);
  });

  it("gives full marks for runway when the business is cash-positive", () => {
    // Null runway means cash-positive. Treating it as unmeasured - or as zero -
    // would penalise the healthiest businesses.
    const result = healthScore({
      collectionRate: 0.95,
      netMargin: 0.2,
      runwayMonths: null,
      leakageRatio: 0,
      dso: 30,
    });
    expect(result.components.find((c) => c.key === "runway")?.normalised).toBe(1);
    expect(result.score).toBe(100);
  });

  it("re-normalises over what could be measured, so a new tenant is not scored for silence", () => {
    const result = healthScore({
      collectionRate: 0.95,
      netMargin: null,
      runwayMonths: null,
      leakageRatio: null,
      dso: null,
    });
    expect(result.score).toBe(100);
    expect(result.unmeasuredWeight).toBeCloseTo(
      HEALTH_WEIGHTS.netMargin + HEALTH_WEIGHTS.leakage + HEALTH_WEIGHTS.dso,
      10,
    );
  });

  it("is null when nothing at all is measurable", () => {
    const result = healthScore({
      collectionRate: null,
      netMargin: null,
      runwayMonths: null,
      leakageRatio: null,
      dso: null,
    });
    // Runway alone is measurable-by-absence, so this is the one component left.
    expect(result.score).toBe(100);
    expect(result.components.filter((c) => c.normalised === null)).toHaveLength(4);
  });
});
