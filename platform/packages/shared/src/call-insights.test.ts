import { describe, expect, it } from "vitest";

import {
  CALL_OUTCOMES,
  CALL_SENTIMENTS,
  CallInsightsQuery,
  type CallInsightsReport,
  type CallInsightsTotals,
  callbackKpis,
  callInsightsFilename,
  callInsightsHighlights,
  callInsightsKpis,
  callInsightsParams,
  callInsightsWindow,
  countChange,
  daysBetweenInclusive,
  formatCallLength,
  formatCount,
  formatCountChange,
  formatHourSlot,
  formatPointChange,
  formatReportRange,
  formatShare,
  formatTalkTime,
  isCalendarDate,
  pointChange,
  ratio,
  recordableCalls,
  volumeSeries,
} from "./call-insights";

function totals(over: Partial<CallInsightsTotals> = {}): CallInsightsTotals {
  return {
    total: 0,
    outgoing: 0,
    answered: 0,
    missed: 0,
    failed: 0,
    connected: 0,
    talkSeconds: 0,
    analyzed: 0,
    positive: 0,
    negative: 0,
    scored: 0,
    avgQuality: null,
    riskCalls: 0,
    leadLinked: 0,
    ...over,
  };
}

function report(over: Partial<CallInsightsReport> = {}): CallInsightsReport {
  return {
    org: { name: "Acme", timezone: "Asia/Kolkata" },
    range: { from: "2026-09-01", to: "2026-09-30", days: 30 },
    previousRange: { from: "2026-08-02", to: "2026-08-31" },
    generatedAt: "2026-09-30T10:00:00.000Z",
    current: totals(),
    previous: totals(),
    daily: [],
    hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, outgoing: 0, answered: 0, missed: 0 })),
    sentiment: CALL_SENTIMENTS.map((s) => ({ ...s, count: 0 })),
    outcomes: CALL_OUTCOMES.map((o) => ({ ...o, count: 0 })),
    intents: { rows: [], distinct: 0 },
    dispositions: { rows: [], unset: 0 },
    quality: {
      scored: 0,
      average: null,
      bands: { strong: 0, fair: 0, weak: 0 },
      criteria: {
        sample: 0,
        scriptAdherence: null,
        professionalism: null,
        conversionSignal: null,
        consentDisclosedPct: null,
      },
    },
    talk: { sample: 0, agentShare: null, interruptions: null },
    sop: { scored: 0, adherence: null },
    risk: { calls: 0, categories: [] },
    people: [],
    attention: [],
    callbacks: {
      missed: 0,
      noNumber: 0,
      returned: 0,
      calledBack: 0,
      withinHour: 0,
      medianMinutes: null,
      waitingCallers: 0,
      waiting: [],
    },
    ...over,
  };
}

describe("CallInsightsQuery", () => {
  it("defaults to the last 30 days when nothing is given", () => {
    const q = CallInsightsQuery.parse({});
    expect(callInsightsWindow(q)).toEqual({ kind: "relative", days: 30 });
  });

  it("takes a preset as days, coerced from the query string", () => {
    expect(callInsightsWindow(CallInsightsQuery.parse({ days: "7" }))).toEqual({ kind: "relative", days: 7 });
  });

  it("prefers an explicit pair over days", () => {
    const q = CallInsightsQuery.parse({ days: "7", from: "2026-01-01", to: "2026-01-31" });
    expect(callInsightsWindow(q)).toEqual({ kind: "fixed", from: "2026-01-01", to: "2026-01-31" });
  });

  it.each([
    [{ from: "2026-01-01" }, "half a pair"],
    [{ from: "2026-02-10", to: "2026-02-01" }, "a backwards range"],
    [{ from: "2025-01-01", to: "2026-01-02" }, "more than 366 days"],
    [{ from: "2026-02-30", to: "2026-03-01" }, "a date that does not exist"],
    [{ from: "2026-1-1", to: "2026-01-31" }, "an unpadded date"],
    [{ days: "0" }, "zero days"],
    [{ days: "367" }, "too many days"],
    [{ from: "2026-01-01'; DROP TABLE calls; --", to: "2026-01-02" }, "SQL in a date"],
  ])("refuses %j (%s)", (input: Record<string, string>, _why: string) => {
    expect(CallInsightsQuery.safeParse(input).success).toBe(false);
  });

  it("accepts exactly 366 days", () => {
    expect(CallInsightsQuery.safeParse({ from: "2025-01-01", to: "2026-01-01" }).success).toBe(true);
    expect(daysBetweenInclusive("2025-01-01", "2026-01-01")).toBe(366);
  });

  it("round-trips a window through query parameters", () => {
    expect(callInsightsParams({ kind: "relative", days: 90 }).toString()).toBe("days=90");
    expect(callInsightsParams({ kind: "fixed", from: "2026-01-01", to: "2026-01-02" }).toString()).toBe(
      "from=2026-01-01&to=2026-01-02",
    );
  });

  it("knows a leap day from a typo", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
  });
});

describe("derived figures", () => {
  it("never divides by zero", () => {
    expect(ratio(3, 0)).toBeNull();
    const k = callInsightsKpis(totals());
    expect(Object.values(k).every((v) => v === null)).toBe(true);
  });

  it("measures answer rate against INBOUND, not all calls", () => {
    const k = callInsightsKpis(totals({ total: 100, outgoing: 60, answered: 30, missed: 10, connected: 80 }));
    expect(k.answerRate).toBeCloseTo(0.75);
    expect(k.connectRate).toBeCloseTo(0.8);
  });

  it("reports a count's change relatively and a rate's in points", () => {
    expect(countChange(120, 100)).toEqual({ diff: 20, pct: 0.2 });
    expect(countChange(5, 0)).toEqual({ diff: 5, pct: null });
    expect(pointChange(0.56, 0.5)).toBeCloseTo(6);
    expect(pointChange(null, 0.5)).toBeNull();
  });
});

describe("formatting", () => {
  it("groups counts and never prints NaN", () => {
    expect(formatCount(1284)).toBe("1,284");
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("–");
  });

  it("keeps a real but tiny share from reading as zero", () => {
    expect(formatShare(0.004)).toBe("<1%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.4167)).toBe("42%");
    expect(formatShare(null)).toBe("–");
  });

  it("writes airtime and call length the way a manager reads them", () => {
    expect(formatTalkTime(45 * 60)).toBe("45m");
    expect(formatTalkTime(12 * 3600 + 4 * 60)).toBe("12h 04m");
    expect(formatTalkTime(1204 * 3600)).toBe("1,204h");
    expect(formatCallLength(45)).toBe("45s");
    expect(formatCallLength(185)).toBe("3m 05s");
  });

  it("signs changes and says so when nothing moved", () => {
    expect(formatCountChange(countChange(118, 100))).toBe("+18%");
    expect(formatCountChange(countChange(93, 100))).toBe("−7%");
    expect(formatCountChange(countChange(100, 100))).toBe("no change");
    expect(formatCountChange(countChange(4, 0))).toBe("new");
    expect(formatPointChange(4.2)).toBe("+4 pts");
    expect(formatPointChange(-1.2)).toBe("−1 pt");
    expect(formatPointChange(-0.3)).toBe("no change");
  });

  it("collapses a range's shared month and year", () => {
    expect(formatReportRange("2026-09-01", "2026-09-30")).toBe("1 – 30 Sep 2026");
    expect(formatReportRange("2026-08-23", "2026-09-21")).toBe("23 Aug – 21 Sep 2026");
    expect(formatReportRange("2025-12-15", "2026-01-12")).toBe("15 Dec 2025 – 12 Jan 2026");
  });

  it("names hour slots across noon and midnight", () => {
    expect(formatHourSlot(13)).toBe("1–2 PM");
    expect(formatHourSlot(11)).toBe("11 AM–12 PM");
    expect(formatHourSlot(23)).toBe("11 PM–12 AM");
    expect(formatHourSlot(0)).toBe("12–1 AM");
  });

  it("builds an ASCII-only filename from any org name", () => {
    expect(callInsightsFilename("RD Interlock Brick", "2026-08-23", "2026-09-21")).toBe(
      "call-insights-rd-interlock-brick-2026-08-23-to-2026-09-21.pdf",
    );
    expect(callInsightsFilename("முருகன் & Co.", "2026-01-01", "2026-01-02")).toBe(
      "call-insights-co-2026-01-01-to-2026-01-02.pdf",
    );
    expect(callInsightsFilename('"; rm -rf /', "2026-01-01", "2026-01-02")).toBe(
      "call-insights-rm-rf-2026-01-01-to-2026-01-02.pdf",
    );
  });
});

describe("volumeSeries", () => {
  const day = (i: number) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    outgoing: 1,
    answered: 2,
    missed: 3,
    talkSeconds: 60,
  });

  it("keeps a column per day up to a quarter", () => {
    const s = volumeSeries(Array.from({ length: 92 }, (_, i) => day(i)));
    expect(s.unit).toBe("day");
    expect(s.buckets).toHaveLength(92);
    expect(s.partialDays).toBe(0);
  });

  it("switches to weeks past a quarter and names the short last week", () => {
    const s = volumeSeries(Array.from({ length: 366 }, (_, i) => day(i)));
    expect(s.unit).toBe("week");
    expect(s.buckets).toHaveLength(53);
    expect(s.buckets[0]).toEqual({ start: "2026-01-01", end: "2026-01-07", outgoing: 7, answered: 14, missed: 21, talkSeconds: 420 });
    expect(s.partialDays).toBe(2);
    expect(s.buckets[52].missed).toBe(6);
  });
});

describe("callInsightsHighlights", () => {
  it("says only that nothing happened when nothing happened", () => {
    expect(callInsightsHighlights(report())).toEqual(["No calls were recorded in this period."]);
    expect(callInsightsHighlights(report({ previous: totals({ total: 40 }) }))).toEqual([
      "No calls were recorded in this period, against 40 in the previous 30 days.",
    ]);
  });

  it("leads with volume, then missed calls and where they cluster", () => {
    const hourly = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      outgoing: 0,
      answered: 0,
      missed: hour === 13 ? 6 : hour === 10 ? 2 : 0,
    }));
    const lines = callInsightsHighlights(
      report({
        current: totals({ total: 120, answered: 30, missed: 8, analyzed: 110 }),
        previous: totals({ total: 100 }),
        hourly,
      }),
    );
    expect(lines[0]).toBe("120 calls, up 20% on the previous 30 days (100).");
    expect(lines[1]).toBe("8 inbound calls went unanswered (21% of inbound). The most, 6, came in 1–2 PM.");
  });

  it("does not put a share in a sentence on a tiny sample", () => {
    const lines = callInsightsHighlights(
      report({ current: totals({ total: 3, analyzed: 3, positive: 2 }), previous: totals({ total: 3 }) }),
    );
    expect(lines.some((l) => l.includes("positive"))).toBe(false);
  });

  it("never lets the cap drop the coverage caveat", () => {
    const outcomes = CALL_OUTCOMES.map((o) => ({ ...o, count: o.key === "follow_up" ? 20 : 0 }));
    const lines = callInsightsHighlights(
      report({
        current: totals({ total: 200, answered: 50, missed: 20, analyzed: 60, positive: 30, negative: 5 }),
        previous: totals({ total: 100, connected: 90 }),
        outcomes,
        quality: { ...report().quality, scored: 50, average: 61, bands: { strong: 10, fair: 30, weak: 10 } },
        risk: { calls: 4, categories: [{ category: "pricing", label: "Pricing", calls: 3, high: 1 }] },
      }),
      4,
    );
    expect(lines).toHaveLength(4);
    // 60 analysed of 180 RECORDABLE - the 20 missed calls have no audio and
    // could never have had a read, so they are not in the base.
    expect(lines[3]).toMatch(/^Only 33% of recorded calls have an AI read/);
  });

  it("says what became of the missed calls, and who is still waiting", () => {
    const lines = callInsightsHighlights(
      report({
        current: totals({ total: 120, answered: 30, missed: 12, analyzed: 100 }),
        previous: totals({ total: 110 }),
        callbacks: {
          ...report().callbacks,
          missed: 12,
          noNumber: 2,
          returned: 7,
          calledBack: 5,
          withinHour: 4,
          medianMinutes: 38,
          waitingCallers: 3,
        },
      }),
    );
    expect(lines[2]).toBe(
      "7 of 10 missed calls with a number were recovered (70%), 5 by calling back; median wait 38m. 3 callers are still waiting for a call back.",
    );
  });

  it("says plainly when nobody has been rung back", () => {
    const lines = callInsightsHighlights(
      report({
        current: totals({ total: 20, answered: 5, missed: 4, analyzed: 16 }),
        previous: totals({ total: 20 }),
        callbacks: { ...report().callbacks, missed: 4, waitingCallers: 1 },
      }),
    );
    expect(lines[2]).toBe(
      "None of the 4 missed calls with a number has been returned yet. 1 caller is still waiting for a call back.",
    );
  });
});

describe("coverage and callbacks", () => {
  it("measures AI-read coverage against calls that could have been recorded", () => {
    const k = callInsightsKpis(totals({ total: 100, answered: 30, missed: 20, analyzed: 60 }));
    expect(k.analyzedShare).toBeCloseTo(0.75);
    expect(recordableCalls(totals({ total: 5, missed: 5 }))).toBe(0);
  });

  it("rates recovery against missed calls that carried a number", () => {
    const k = callbackKpis({ ...report().callbacks, missed: 12, noNumber: 2, returned: 7, calledBack: 5, withinHour: 4 });
    expect(k.returnable).toBe(10);
    expect(k.recoveredRate).toBeCloseTo(0.7);
    expect(k.calledBackRate).toBeCloseTo(0.5);
    expect(k.withinHourRate).toBeCloseTo(0.4);
    expect(callbackKpis(report().callbacks).recoveredRate).toBeNull();
  });
});
