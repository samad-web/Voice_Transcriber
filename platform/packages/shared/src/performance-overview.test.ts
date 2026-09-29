import { describe, expect, it } from "vitest";

import {
  MIN_CAMPAIGN_LEADS,
  type CampaignPerformance,
  type PerformanceOverview,
  campaignWinRate,
  conversionRate,
  costPerLead,
  goalStanding,
  overviewHeadline,
  rankedCampaigns,
  returnOnSpend,
  winRate,
} from "./performance-overview";
import type { Attainment } from "./targets";

function campaign(over: Partial<CampaignPerformance> = {}): CampaignPerformance {
  return {
    id: "c1",
    name: "Spring push",
    channel: "meta",
    leads: 50,
    won: 10,
    wonValue: 500_000,
    spend: 100_000,
    ...over,
  };
}

function goal(over: Partial<Attainment> = {}): Attainment {
  return {
    targetId: "t1",
    ownerUserId: null,
    ownerName: null,
    metric: "won_value",
    periodStart: "2026-07-01",
    periodEnd: "2026-09-30",
    target: 1_000_000,
    actual: 500_000,
    ratio: 0.5,
    periodElapsed: 0.5,
    pace: 500_000,
    ...over,
  } as Attainment;
}

function overview(over: Partial<PerformanceOverview> = {}): PerformanceOverview {
  return {
    from: "2026-09-01",
    to: "2026-09-30",
    sales: {
      leadsCreated: 200,
      won: 40,
      lost: 60,
      pipelineValue: 3_000_000,
      wonValue: 2_000_000,
      velocity: {
        wonDeals: 40,
        avgDaysToWin: 21,
        medianDaysToWin: 18,
        openValue: 3_000_000,
        openCount: 90,
      },
    },
    marketing: { campaigns: [], channels: [], totalSpend: null, spendRecorded: false },
    team: [],
    goals: [],
    ...over,
  };
}

describe("conversionRate / winRate", () => {
  it("converts leads created into wins", () => {
    expect(conversionRate(overview().sales)).toBeCloseTo(0.2);
  });

  it("takes win rate over CLOSED deals, not over every lead", () => {
    // 40 won of 100 closed = 0.4, not 40/200.
    expect(winRate(overview().sales)).toBeCloseTo(0.4);
  });

  it("refuses a rate on a base too thin to carry one", () => {
    const thin = overview({
      sales: { ...overview().sales, leadsCreated: 4, won: 2, lost: 1 },
    });
    expect(conversionRate(thin.sales)).toBeNull();
  });
});

describe("costPerLead", () => {
  it("divides spend by the leads it bought", () => {
    expect(costPerLead(campaign())).toBe(2000);
  });

  it("is null when nobody recorded a spend", () => {
    expect(costPerLead(campaign({ spend: null }))).toBeNull();
  });

  it("refuses to price a lead off too few of them", () => {
    expect(costPerLead(campaign({ leads: MIN_CAMPAIGN_LEADS - 1 }))).toBeNull();
  });

  it("treats a zero spend as unrecorded rather than dividing by it", () => {
    expect(costPerLead(campaign({ spend: 0 }))).toBeNull();
  });
});

describe("returnOnSpend", () => {
  it("is won value over spend, as a multiple", () => {
    expect(returnOnSpend(campaign())).toBe(5);
  });

  it("reports a return even off a single deal", () => {
    // Unlike cost per lead: this is money that already landed.
    expect(returnOnSpend(campaign({ leads: 1, won: 1, wonValue: 300_000 }))).toBe(3);
  });

  it("is null without a recorded spend", () => {
    expect(returnOnSpend(campaign({ spend: null }))).toBeNull();
  });
});

describe("campaignWinRate", () => {
  it("is wins over the leads the campaign produced", () => {
    expect(campaignWinRate(campaign())).toBeCloseTo(0.2);
  });

  it("is null below the campaign sample floor", () => {
    expect(campaignWinRate(campaign({ leads: 5, won: 2 }))).toBeNull();
  });
});

describe("rankedCampaigns", () => {
  it("orders by return on spend, best first", () => {
    const ranked = rankedCampaigns([
      campaign({ id: "low", spend: 100_000, wonValue: 200_000 }),
      campaign({ id: "high", spend: 100_000, wonValue: 900_000 }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["high", "low"]);
  });

  it("sorts campaigns with NO recorded spend last, never first", () => {
    // The trap: null read as zero would make an uncosted campaign look like
    // the cheapest one on the page.
    const ranked = rankedCampaigns([
      campaign({ id: "unpriced", spend: null }),
      campaign({ id: "priced", spend: 100_000, wonValue: 150_000 }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["priced", "unpriced"]);
  });

  it("falls back to lead count when nothing carries a spend", () => {
    const ranked = rankedCampaigns([
      campaign({ id: "small", spend: null, leads: 10 }),
      campaign({ id: "big", spend: null, leads: 80 }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(["big", "small"]);
  });
});

describe("goalStanding", () => {
  it("judges against pace, not against the raw target", () => {
    // Half the target at the halfway point is exactly on track, even though
    // attainment reads 50%.
    expect(goalStanding(goal())).toBe("on-track");
  });

  it("calls a clear lead ahead", () => {
    expect(goalStanding(goal({ actual: 800_000 }))).toBe("ahead");
  });

  it("calls a shortfall behind early in the period", () => {
    expect(goalStanding(goal({ actual: 300_000, periodElapsed: 0.5 }))).toBe("behind");
  });

  it("escalates the SAME shortfall to at-risk late in the period", () => {
    const late = goal({ actual: 300_000, periodElapsed: 0.9, pace: 900_000 });
    expect(goalStanding(late)).toBe("at-risk");
  });

  it("does not judge a period that has barely started", () => {
    expect(goalStanding(goal({ actual: 0, periodElapsed: 0.01, pace: 10_000 }))).toBe("on-track");
  });

  it("does not divide by a zero pace", () => {
    expect(goalStanding(goal({ actual: 0, pace: 0, periodElapsed: 0.5 }))).toBe("on-track");
  });
});

describe("overviewHeadline", () => {
  it("says plainly when no target is set", () => {
    expect(overviewHeadline(overview())).toBe(
      "200 new leads and 40 closed in this range. No targets are set for it.",
    );
  });

  it("counts the goals that are off pace", () => {
    const o = overview({ goals: [goal(), goal({ targetId: "t2", actual: 100_000 })] });
    expect(overviewHeadline(o)).toBe("1 of 2 targets is behind pace.");
  });

  it("says so when everything is on pace", () => {
    expect(overviewHeadline(overview({ goals: [goal()] }))).toBe("All 1 target is at or ahead of pace.");
  });
});
