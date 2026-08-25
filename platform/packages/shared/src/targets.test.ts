import { describe, expect, it } from "vitest";

import { attainmentStatus, periodElapsed, SalesTargetInput } from "./targets";

/**
 * Attainment is a number somebody's manager reads about them, so the two ways
 * of getting it wrong are both worth pinning: telling a rep they are behind
 * when they are on pace, and telling them they are fine when they are not.
 */

describe("periodElapsed", () => {
  const Q = ["2026-07-01", "2026-09-30"] as const;

  it("is 0 at the very start and 1 after the last day", () => {
    expect(periodElapsed(...Q, new Date("2026-07-01T00:00:00Z"))).toBe(0);
    expect(periodElapsed(...Q, new Date("2026-10-01T00:00:00Z"))).toBe(1);
  });

  it("counts the final day as part of the period", () => {
    // Midday on the last day is NOT over. A period that ended at the last
    // day's midnight would report 100% elapsed with a day left to sell in.
    const lastDay = periodElapsed(...Q, new Date("2026-09-30T12:00:00Z"));
    expect(lastDay).toBeGreaterThan(0.99);
    expect(lastDay).toBeLessThan(1);
  });

  it("is about half way at the midpoint", () => {
    const half = periodElapsed(...Q, new Date("2026-08-15T12:00:00Z"));
    expect(half).toBeGreaterThan(0.48);
    expect(half).toBeLessThan(0.52);
  });

  it("clamps rather than going negative or past 1", () => {
    // A target somebody wrote for next quarter reads 0, not -0.4; one from
    // last year reads 1, not 4.
    expect(periodElapsed(...Q, new Date("2026-01-01T00:00:00Z"))).toBe(0);
    expect(periodElapsed(...Q, new Date("2027-06-01T00:00:00Z"))).toBe(1);
  });

  it("handles a one-day period without dividing by zero", () => {
    expect(periodElapsed("2026-08-12", "2026-08-12", new Date("2026-08-12T00:00:00Z"))).toBe(0);
    expect(periodElapsed("2026-08-12", "2026-08-12", new Date("2026-08-13T00:00:00Z"))).toBe(1);
  });

  it("returns 1 for an unparseable or inverted period rather than NaN", () => {
    // NaN would propagate into `pace` and render as "NaN" on a dashboard.
    expect(periodElapsed("not-a-date", "2026-09-30", new Date())).toBe(1);
    expect(periodElapsed("2026-09-30", "2026-07-01", new Date())).toBe(1);
  });
});

describe("attainmentStatus", () => {
  it("is 'not started' before the period begins", () => {
    expect(attainmentStatus(0, 0)).toBe("not started");
  });

  it("is 'ahead' once the whole number is banked, whatever the calendar says", () => {
    expect(attainmentStatus(1, 0.2)).toBe("ahead");
    expect(attainmentStatus(1.4, 0.95)).toBe("ahead");
  });

  it("compares against PACE, not against the whole target", () => {
    // The case this function exists for: 40% of the number with 30% of the
    // quarter gone is AHEAD. A dashboard that shows a bare 40% and colours it
    // red teaches people to ignore the colour.
    expect(attainmentStatus(0.4, 0.3)).toBe("ahead");
    expect(attainmentStatus(0.4, 0.8)).toBe("behind");
  });

  it("gives a 10% band, so a Tuesday wobble is not a failure", () => {
    expect(attainmentStatus(0.47, 0.5)).toBe("on track");
    expect(attainmentStatus(0.45, 0.5)).toBe("on track");
    // Below the band it is genuinely behind.
    expect(attainmentStatus(0.4, 0.5)).toBe("behind");
  });

  it("calls zero progress mid-period behind, not on track", () => {
    expect(attainmentStatus(0, 0.5)).toBe("behind");
  });
});

describe("SalesTargetInput", () => {
  const base = { periodStart: "2026-07-01", periodEnd: "2026-09-30", targetValue: 500000 };

  it("accepts a team target with no owner", () => {
    const parsed = SalesTargetInput.parse(base);
    expect(parsed.metric).toBe("won_value");
    expect(parsed.ownerUserId).toBeUndefined();
  });

  it("rejects a period that ends before it starts", () => {
    const bad = SalesTargetInput.safeParse({
      ...base,
      periodStart: "2026-09-30",
      periodEnd: "2026-07-01",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a zero or negative target — an unreachable or meaningless one", () => {
    expect(SalesTargetInput.safeParse({ ...base, targetValue: 0 }).success).toBe(false);
    expect(SalesTargetInput.safeParse({ ...base, targetValue: -5 }).success).toBe(false);
  });

  it("rejects a fractional DEAL COUNT while allowing a fractional value", () => {
    // "2.5 deals" is a typo; the numeric column would store it happily and
    // then render "3 of 2.5".
    expect(
      SalesTargetInput.safeParse({ ...base, metric: "won_count", targetValue: 2.5 }).success,
    ).toBe(false);
    expect(
      SalesTargetInput.safeParse({ ...base, metric: "won_count", targetValue: 12 }).success,
    ).toBe(true);
    expect(SalesTargetInput.safeParse({ ...base, targetValue: 1234.56 }).success).toBe(true);
  });

  it("accepts a single-day period", () => {
    expect(
      SalesTargetInput.safeParse({ ...base, periodStart: "2026-08-12", periodEnd: "2026-08-12" })
        .success,
    ).toBe(true);
  });
});
