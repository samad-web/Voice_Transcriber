import {
  CALL_OUTCOMES,
  CALL_SENTIMENTS,
  type CallInsightsReport,
  type CallInsightsTotals,
} from "@aura/shared";
import { findFontDir, renderCallInsightsPdf } from "./call-insights-pdf";

/**
 * The PDF renderer, end to end: it produces a real file for an empty month, a
 * full one and a year, embeds the fonts it needs (and only those), and leaves
 * the per-call section out when asked.
 *
 * Content streams are compressed, so the checks read what pdfkit writes in the
 * clear: the header, the outline (one bookmark per section), the page tree and
 * the embedded font names.
 */

function totals(over: Partial<CallInsightsTotals> = {}): CallInsightsTotals {
  return {
    total: 0, outgoing: 0, answered: 0, missed: 0, failed: 0, connected: 0, talkSeconds: 0,
    analyzed: 0, positive: 0, negative: 0, scored: 0, avgQuality: null, riskCalls: 0, leadLinked: 0,
    ...over,
  };
}

function days(from: string, n: number): CallInsightsReport["daily"] {
  return Array.from({ length: n }, (_, i) => {
    const date = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    return { date, outgoing: (i * 7) % 23, answered: (i * 5) % 11, missed: i % 4, talkSeconds: 3600 };
  });
}

function sampleReport(over: Partial<CallInsightsReport> = {}): CallInsightsReport {
  return {
    org: { name: "RD Interlock Brick", timezone: "Asia/Kolkata" },
    range: { from: "2026-08-23", to: "2026-09-21", days: 30 },
    previousRange: { from: "2026-07-24", to: "2026-08-22" },
    generatedAt: "2026-09-21T07:10:00.000Z",
    current: totals({
      total: 412, outgoing: 240, answered: 135, missed: 37, failed: 9, connected: 351, talkSeconds: 61_200,
      analyzed: 340, positive: 150, negative: 40, scored: 320, avgQuality: 63.4, riskCalls: 9, leadLinked: 120,
    }),
    previous: totals({
      total: 349, outgoing: 200, answered: 120, missed: 29, connected: 300, talkSeconds: 50_000,
      analyzed: 300, positive: 120, negative: 45, scored: 280, avgQuality: 60.1, riskCalls: 6, leadLinked: 90,
    }),
    daily: days("2026-08-23", 30),
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      outgoing: hour >= 9 && hour <= 19 ? 20 : 0,
      answered: hour >= 9 && hour <= 19 ? 10 : 0,
      missed: hour === 13 ? 9 : hour >= 9 && hour <= 19 ? 2 : 0,
    })),
    sentiment: CALL_SENTIMENTS.map((s) => ({ ...s, count: s.key === "positive" ? 150 : s.key === "negative" ? 40 : 150 })),
    outcomes: CALL_OUTCOMES.map((o, i) => ({ ...o, count: [90, 88, 30, 60, 40, 10, 22][i] })),
    intents: {
      rows: [
        { label: "Price enquiry for interlock bricks", count: 44 },
        { label: "Delivery date follow-up", count: 21 },
      ],
      distinct: 180,
    },
    dispositions: { rows: [{ key: "interested", label: "Hot prospect", count: 40 }], unset: 372 },
    quality: {
      scored: 320,
      average: 63.4,
      bands: { strong: 110, fair: 170, weak: 40 },
      criteria: { sample: 300, scriptAdherence: 6.2, professionalism: 7.8, conversionSignal: 5.1, consentDisclosedPct: 72 },
    },
    talk: { sample: 200, agentShare: 0.58, interruptions: 2.4 },
    sop: { scored: 150, adherence: 71 },
    risk: { calls: 9, categories: [{ category: "pricing_complaint", label: "Pricing complaint", calls: 5, high: 2 }] },
    people: [
      { telecallerId: "a", name: "Priya", calls: 200, outgoing: 120, answered: 70, missed: 10, connected: 180, talkSeconds: 30_000, analyzed: 170, positive: 80, scored: 160, avgQuality: 66, riskCalls: 3, leadLinked: 60 },
      { telecallerId: "b", name: "முருகன் Arun", calls: 150, outgoing: 90, answered: 40, missed: 20, connected: 120, talkSeconds: 25_000, analyzed: 130, positive: 50, scored: 120, avgQuality: 58, riskCalls: 6, leadLinked: 50 },
      { telecallerId: null, name: "Not attributed", calls: 62, outgoing: 30, answered: 25, missed: 7, connected: 51, talkSeconds: 6_200, analyzed: 40, positive: 20, scored: 40, avgQuality: null, riskCalls: 0, leadLinked: 10 },
    ],
    attention: [
      {
        id: "c1", startedAt: "2026-09-18T08:05:00.000Z", direction: "incoming", durationS: 240, telecaller: "Priya",
        contact: "राजेश कुमार", sentiment: "negative", outcome: "not_interested", quality: 28, risk: true, highRisk: true,
        riskCategories: ["pricing_complaint"], summary: "Customer disputed the quoted price per brick and asked for a manager to call back.",
        leadId: null, leadTitle: null, reasons: ["High escalation risk", "Negative sentiment", "Low quality (28/100)"],
      },
    ],
    callbacks: {
      missed: 37, noNumber: 3, returned: 24, calledBack: 19, withinHour: 15, medianMinutes: 42.5, waitingCallers: 2,
      waiting: [
        { callId: "m1", contact: "98765…210", lastMissedAt: "2026-09-20T12:40:00.000Z", attempts: 3, telecaller: "Priya", leadId: "l1", leadTitle: "Bulk order - Hosur site" },
        { callId: "m2", contact: "Suresh", lastMissedAt: "2026-09-19T05:10:00.000Z", attempts: 1, telecaller: null, leadId: null, leadTitle: null },
      ],
    },
    ...over,
  };
}

const NO_CALLBACKS: CallInsightsReport["callbacks"] = {
  missed: 0, noNumber: 0, returned: 0, calledBack: 0, withinHour: 0, medianMinutes: null, waitingCallers: 0, waiting: [],
};

const text = (pdf: Buffer) => pdf.toString("latin1");
const pages = (pdf: Buffer) => (text(pdf).match(/\/Type \/Page\b(?!s)/g) ?? []).length;

describe("renderCallInsightsPdf", () => {
  it("finds its fonts from the source tree, as it will from dist/", () => {
    expect(findFontDir()).toMatch(/assets[\\/]fonts$/);
  });

  it("writes a complete PDF for a normal month", async () => {
    const pdf = await renderCallInsightsPdf(sampleReport());
    expect(text(pdf).startsWith("%PDF-")).toBe(true);
    expect(text(pdf).trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pages(pdf)).toBeGreaterThanOrEqual(2);
    // Vector and small: fonts are subset, nothing is rasterised.
    expect(pdf.length).toBeLessThan(250_000);
  });

  it("embeds a fallback face only when a name needs it", async () => {
    const latinOnly = await renderCallInsightsPdf(
      sampleReport({ people: [], attention: [], org: { name: "Acme", timezone: "Asia/Kolkata" } }),
    );
    expect(text(latinOnly)).toContain("NotoSans-Regular");
    expect(text(latinOnly)).not.toContain("NotoSansTamil");

    const mixed = await renderCallInsightsPdf(sampleReport());
    expect(text(mixed)).toContain("NotoSansTamil");
    expect(text(mixed)).toContain("NotoSansDevanagari");
  });

  it("leaves the per-call section out when asked", async () => {
    const withCalls = await renderCallInsightsPdf(sampleReport());
    const without = await renderCallInsightsPdf(sampleReport(), { includeCalls: false });
    // Outline titles are written as UTF-16 hex strings; decode by searching both forms.
    const hasBookmark = (pdf: Buffer, title: string) =>
      text(pdf).includes(title) ||
      text(pdf).toLowerCase().includes(Buffer.from(`﻿${title}`, "utf16le").swap16().toString("hex"));
    expect(hasBookmark(withCalls, "Calls worth a look")).toBe(true);
    expect(hasBookmark(without, "Calls worth a look")).toBe(false);
    expect(hasBookmark(without, "Team")).toBe(true);
  });

  it("renders an empty period without throwing or dividing by zero", async () => {
    const empty = sampleReport({
      current: totals(),
      previous: totals(),
      daily: days("2026-08-23", 30).map((d) => ({ ...d, outgoing: 0, answered: 0, missed: 0, talkSeconds: 0 })),
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, outgoing: 0, answered: 0, missed: 0 })),
      sentiment: CALL_SENTIMENTS.map((s) => ({ ...s, count: 0 })),
      outcomes: CALL_OUTCOMES.map((o) => ({ ...o, count: 0 })),
      intents: { rows: [], distinct: 0 },
      dispositions: { rows: [], unset: 0 },
      quality: {
        scored: 0, average: null, bands: { strong: 0, fair: 0, weak: 0 },
        criteria: { sample: 0, scriptAdherence: null, professionalism: null, conversionSignal: null, consentDisclosedPct: null },
      },
      talk: { sample: 0, agentShare: null, interruptions: null },
      sop: { scored: 0, adherence: null },
      risk: { calls: 0, categories: [] },
      people: [],
      attention: [],
      callbacks: NO_CALLBACKS,
    });
    const pdf = await renderCallInsightsPdf(empty);
    expect(text(pdf).startsWith("%PDF-")).toBe(true);
    expect(text(pdf)).not.toMatch(/NaN|Infinity/);
  });

  it("carries a call-back section when calls were missed, and none when nothing was", async () => {
    const hasBookmark = (pdf: Buffer, title: string) =>
      text(pdf).includes(title) ||
      text(pdf).toLowerCase().includes(Buffer.from(`﻿${title}`, "utf16le").swap16().toString("hex"));
    expect(hasBookmark(await renderCallInsightsPdf(sampleReport()), "Missed calls & call-backs")).toBe(true);
    expect(
      hasBookmark(await renderCallInsightsPdf(sampleReport({ callbacks: NO_CALLBACKS })), "Missed calls & call-backs"),
    ).toBe(false);
  });

  it("drops the waiting list - which names people - from a copy without individual calls", async () => {
    // The only Tamil text in this report is a waiting caller's name, so the
    // Tamil face is embedded exactly when that list is drawn.
    const report = sampleReport({
      org: { name: "Acme", timezone: "Asia/Kolkata" },
      people: [],
      attention: [],
      callbacks: {
        ...sampleReport().callbacks,
        waiting: [{ callId: "m1", contact: "முருகன்", lastMissedAt: "2026-09-20T12:40:00.000Z", attempts: 2, telecaller: null, leadId: null, leadTitle: null }],
      },
    });
    expect(text(await renderCallInsightsPdf(report))).toContain("NotoSansTamil");
    expect(text(await renderCallInsightsPdf(report, { includeCalls: false }))).not.toContain("NotoSansTamil");
  });

  it("paginates a year and a long team table", async () => {
    const people = Array.from({ length: 50 }, (_, i) => ({
      ...sampleReport().people[0],
      telecallerId: `p${i}`,
      name: `Telecaller ${i + 1}`,
    }));
    const pdf = await renderCallInsightsPdf(
      sampleReport({
        range: { from: "2025-09-21", to: "2026-09-21", days: 366 },
        daily: days("2025-09-21", 366),
        people,
      }),
    );
    expect(pages(pdf)).toBeGreaterThanOrEqual(3);
  });
});
