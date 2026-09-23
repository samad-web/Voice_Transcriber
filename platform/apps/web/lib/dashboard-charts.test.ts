import { describe, expect, it } from "vitest";
import {
  barPercent,
  countAxis,
  deltaText,
  edgeLabels,
  heatGrid,
  heatInsight,
  missedClass,
  missedEdges,
  percentDelta,
  pointsDelta,
  rateText,
  slaFit,
  slaPhrase,
  sourceRows,
  stageHealth,
  trailingMean,
  trendInsight,
  windowLabel,
} from "./dashboard-charts";

describe("axes", () => {
  it("gives a clean top and labels the midpoint only when it is whole", () => {
    expect(countAxis(84)).toEqual({ top: 100, mid: 50 });
    expect(countAxis(0)).toEqual({ top: 1, mid: null });
    expect(countAxis(1)).toEqual({ top: 1, mid: null });
    expect(countAxis(3)).toEqual({ top: 3, mid: null });
    // The case that motivated the finer steps: 22 used to get a 50 axis.
    expect(countAxis(22)).toEqual({ top: 30, mid: 15 });
    expect(countAxis(7)).toEqual({ top: 8, mid: 4 });
  });

  it("never draws a non-zero value invisibly, and never draws a zero", () => {
    expect(barPercent(0, 100)).toBe(0);
    expect(barPercent(1, 1000)).toBe(2);
    expect(barPercent(50, 100)).toBe(50);
    expect(barPercent(200, 100)).toBe(100);
  });

  it("averages only over a full span", () => {
    expect(trailingMean([7, 7, 7, 7, 7, 7, 7, 14], 7)).toEqual([null, null, null, null, null, null, 7, 8]);
    expect(trailingMean([1, 2], 7)).toEqual([null, null]);
  });
});

describe("comparisons (docs/29 §3.2)", () => {
  it("says 'none in the previous window' rather than an infinite percentage", () => {
    expect(percentDelta(5, 0)).toEqual({ kind: "from-zero", amount: 0 });
    expect(deltaText(percentDelta(5, 0)!, 30)).toBe("none in the previous 30 days");
    expect(percentDelta(0, 0)).toBeNull();
  });

  it("uses a glyph and words, never a colour", () => {
    expect(deltaText(percentDelta(118, 100)!, 30)).toBe("▲ 18% vs previous 30 days");
    expect(deltaText(percentDelta(80, 100)!, 7)).toBe("▼ 20% vs previous 7 days");
    expect(deltaText(percentDelta(100, 100)!, 1)).toBe("no change vs previous 1 day");
  });

  it("measures a rate's change in points", () => {
    expect(pointsDelta(0.15, 0.13)).toEqual({ kind: "up", amount: 2 });
    expect(deltaText(pointsDelta(0.1, 0.13)!, 30, " pts")).toBe("▼ 3 pts vs previous 30 days");
    expect(pointsDelta(null, 0.1)).toBeNull();
  });

  it("admits a small base instead of printing a confident percentage", () => {
    expect(rateText(3, 4)).toBe("3 of 4");
    expect(rateText(16, 25)).toBe("64%");
    expect(rateText(0, 0)).toBe("-");
  });

  it("prints the echoed window without a year", () => {
    expect(windowLabel("2026-08-24", "2026-09-22")).toBe("24 Aug – 22 Sep");
    expect(windowLabel("2026-09-22", "2026-09-22")).toBe("22 Sep");
    expect(windowLabel(undefined, "2026-09-22")).toBeNull();
  });
});

describe("trend insight", () => {
  it("names the busiest and most-missed days, ties going to the most recent", () => {
    const days = [
      { day: "2026-09-14", calls: 84, missed: 12, leads: 3 },
      { day: "2026-09-15", calls: 20, missed: 12, leads: 1 },
      { day: "2026-09-16", calls: 84, missed: 0, leads: 0 },
    ];
    expect(trendInsight(days)).toBe("Busiest: Wed 16 Sep, 84 calls · Most missed: Tue 15 Sep, 12");
  });

  it("stays silent on a window with no calls", () => {
    expect(trendInsight([{ day: "2026-09-16", calls: 0, missed: 0, leads: 2 }])).toBeNull();
  });
});

describe("missed-call heatmap", () => {
  const cells = [
    { dow: 2, hour: 13, inbound: 14, missed: 6 },
    { dow: 2, hour: 14, inbound: 8, missed: 3 },
    { dow: 5, hour: 20, inbound: 2, missed: 1 },
    { dow: 1, hour: 10, inbound: 5, missed: 0 },
  ];

  it("lays out Monday-first rows and widens the hours to include 09-18", () => {
    const grid = heatGrid(cells);
    expect(grid.rows.map((r) => r.label)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(grid.hours[0]).toBe(9);
    expect(grid.hours.at(-1)).toBe(20);
    expect(grid.totalMissed).toBe(10);
    expect(grid.totalInbound).toBe(29);
    expect(grid.maxMissed).toBe(6);
    expect(grid.rows[1]!.missed).toBe(9);
  });

  it("uses at most four classes, all of them, whatever the volume", () => {
    expect(missedEdges(12)).toEqual([3, 6, 9, 12]);
    expect(missedEdges(5)).toEqual([2, 3, 4, 5]);
    expect(missedEdges(3)).toEqual([1, 2, 3]);
    expect(missedEdges(1)).toEqual([1]);
    expect(missedEdges(0)).toEqual([]);
    expect(edgeLabels([3, 6, 9, 12])).toEqual(["1–3", "4–6", "7–9", "10–12"]);
    expect(edgeLabels([1, 2, 3])).toEqual(["1", "2", "3"]);
  });

  it("puts every count in its class, zero in none", () => {
    const edges = [3, 6, 9, 12];
    expect([0, 1, 3, 4, 9, 12].map((m) => missedClass(m, edges))).toEqual([0, 1, 1, 2, 3, 4]);
  });

  it("names the worst hour, and a band only when it holds a third of the misses", () => {
    expect(heatInsight(heatGrid(cells))).toBe(
      "Most missed: Tue 13:00–14:00 (6 of 14). 90% of missed calls fall between 13:00 and 15:00.",
    );
    // Five misses is below the pattern threshold: just the worst cell.
    expect(heatInsight(heatGrid([{ dow: 3, hour: 11, inbound: 9, missed: 5 }]))).toBe(
      "Most missed: Wed 11:00–12:00 (5 of 9).",
    );
    expect(heatInsight(heatGrid([{ dow: 3, hour: 11, inbound: 9, missed: 0 }]))).toBeNull();
  });
});

describe("pipeline health", () => {
  it("keeps open stages in order, sums the buckets and leaves terminals out", () => {
    const funnel = [
      { key: "new", label: "New", count: 5, value: 100 },
      { key: "won", label: "Won", terminal: "won" as const, count: 9, value: 900 },
      { key: "proposal", label: "Proposal", count: 3, value: 50 },
    ];
    const aging = [
      { stage: "new", d0_3: 1, d4_7: 1, d8_15: 0, d16_30: 1, d30_plus: 2 },
      { stage: "proposal", d0_3: 3, d4_7: 0, d8_15: 0, d16_30: 0, d30_plus: 0 },
    ];
    const { rows, max } = stageHealth(funnel, aging, ["d0_3", "d4_7", "d8_15", "d16_30", "d30_plus"]);
    expect(rows.map((r) => [r.key, r.open, r.stuck])).toEqual([
      ["new", 5, 2],
      ["proposal", 3, 0],
    ]);
    expect(max).toBe(5);
  });
});

describe("response speed against the SLA", () => {
  const b = (key: string, min: number | null, max: number | null, never = false) => ({
    key,
    label: key,
    min_minutes: min,
    max_minutes: max,
    never,
    count: 1,
  });

  it("splits buckets wholly inside, straddling and beyond the SLA", () => {
    expect(slaFit(b("under_5m", null, 5), 60)).toBe("within");
    expect(slaFit(b("under_1h", 30, 60), 60)).toBe("within");
    expect(slaFit(b("under_4h", 60, 240), 60)).toBe("beyond");
    // A 45-minute SLA falls INSIDE 30-60.
    expect(slaFit(b("under_1h", 30, 60), 45)).toBe("partial");
    expect(slaFit(b("over_24h", 1440, null), 2000)).toBe("partial");
    expect(slaFit(b("never", null, null, true), 60)).toBe("never");
  });

  it("says an SLA the way a manager does", () => {
    expect(slaPhrase(60)).toBe("60-minute");
    expect(slaPhrase(240)).toBe("4-hour");
    expect(slaPhrase(1440)).toBe("1-day");
    expect(slaPhrase(45)).toBe("45-minute");
  });
});

describe("source effectiveness", () => {
  it("ranks by volume, rates each channel and flags a thin base", () => {
    const { rows, overall, maxLeads } = sourceRows([
      { channel: "web_form", leads: 3, won: 2, won_value: 10 },
      { channel: "call", leads: 40, won: 4, won_value: 90 },
    ]);
    expect(rows.map((r) => [r.channel, r.rate, r.small])).toEqual([
      ["call", 0.1, false],
      ["web_form", 2 / 3, true],
    ]);
    expect(overall).toBeCloseTo(6 / 43);
    expect(maxLeads).toBe(40);
  });
});
