import {
  STATEMENT_ORDER,
  assembleCallInsights,
  attentionReasons,
  callInsightsBatch,
  contactLabel,
  fillDaily,
  fillHourly,
  foldOutcomes,
  windowCte,
} from "./call-insights.query";

/**
 * The TEXT half of call insights' SQL, and the row assembly.
 *
 * Whether Postgres accepts the text, whether `aura_app` holds the grants and
 * whether the window lands on the org's calendar is verify-call-insights.cjs's
 * job, against a real database. This file pins what can be pinned without one:
 * that the only interpolated values are the validated window, and that nothing
 * verbatim is ever selected.
 */
describe("call insights SQL", () => {
  it("anchors a relative window on the org's own today", () => {
    const sql = windowCte({ kind: "relative", days: 30 });
    expect(sql).toContain("org_reporting_today() - 29 AS from_d");
    expect(sql).toContain("COALESCE(reporting_timezone, 'Asia/Kolkata')");
  });

  it("interpolates a fixed window only as DATE literals", () => {
    const sql = windowCte({ kind: "fixed", from: "2026-06-01", to: "2026-06-30" });
    expect(sql).toContain("DATE '2026-06-01' AS from_d, DATE '2026-06-30' AS to_d");
  });

  it.each([
    [{ kind: "fixed" as const, from: "2026-06-01'; DROP TABLE calls; --", to: "2026-06-30" }],
    [{ kind: "fixed" as const, from: "2026-02-30", to: "2026-03-01" }],
    [{ kind: "fixed" as const, from: "2026-07-01", to: "2026-06-01" }],
    [{ kind: "relative" as const, days: 0 }],
    [{ kind: "relative" as const, days: 1.5 }],
    [{ kind: "relative" as const, days: 367 }],
  ])("refuses to build SQL for %j even if zod was bypassed", (window) => {
    expect(() => callInsightsBatch(window)).toThrow();
  });

  it("sends one statement per section, in the order assembly reads them", () => {
    const sql = callInsightsBatch({ kind: "relative", days: 7 });
    expect(sql.split(";\n")).toHaveLength(STATEMENT_ORDER.length);
  });

  it("never selects transcript text or a risk flag's snippet", () => {
    const sql = callInsightsBatch({ kind: "relative", days: 7 });
    expect(sql).not.toMatch(/snippet/);
    expect(sql).not.toMatch(/\bt\.text\b|\bt\.segments\b/);
  });

  it("counts missed the way the console paints it: inbound with no airtime", () => {
    const sql = callInsightsBatch({ kind: "relative", days: 7 });
    expect(sql).toContain("c.direction = 'incoming' AND c.duration_s <= 0");
  });

  it("looks for a callback by the match key AND the legacy hash, each on its own index", () => {
    const sql = callInsightsBatch({ kind: "relative", days: 7 });
    expect(sql).toContain("r.remote_number_key = c.remote_number_key");
    expect(sql).toContain("r.remote_number_hash = c.remote_number_hash");
    // A later MISSED call is the customer failing again, not a return.
    expect(sql).toContain("(r.direction = 'outgoing' OR r.duration_s > 0)");
  });

  it("never hands a number key or hash back to the page", () => {
    // The waiting list groups ON them; the final SELECT carries only the
    // privacy-lite fragments the call log already shows.
    const waiting = callInsightsBatch({ kind: "relative", days: 7 }).split(";\n")[STATEMENT_ORDER.indexOf("waiting")];
    const finalSelect = waiting.slice(waiting.lastIndexOf("SELECT g.call_id"));
    expect(finalSelect).not.toMatch(/remote_number_(key|hash)|person/);
  });
});

describe("assembly", () => {
  it("zero-fills every day and every hour", () => {
    const days = fillDaily([{ date: "2026-06-02", outgoing: 3, answered: 1, missed: 2, talk_seconds: 90 }], "2026-06-01", "2026-06-03");
    expect(days.map((d) => [d.date, d.outgoing])).toEqual([
      ["2026-06-01", 0],
      ["2026-06-02", 3],
      ["2026-06-03", 0],
    ]);
    const hours = fillHourly([{ hour: 13, outgoing: 0, answered: 0, missed: 4 }]);
    expect(hours).toHaveLength(24);
    expect(hours[13].missed).toBe(4);
  });

  it("folds unknown outcomes into other and keeps the vocabulary's order", () => {
    const outcomes = foldOutcomes([
      { outcome: "Price negotiation", count: 2 },
      { outcome: "follow-up", count: 3 },
      { outcome: "interested", count: 1 },
      { outcome: "other", count: 1 },
    ]);
    expect(outcomes.map((o) => o.key)).toEqual([
      "interested",
      "follow_up",
      "callback",
      "not_interested",
      "no_answer",
      "wrong_number",
      "other",
    ]);
    expect(outcomes.find((o) => o.key === "follow_up")?.count).toBe(3);
    expect(outcomes.find((o) => o.key === "other")?.count).toBe(3);
  });

  it("labels a contact the way the call log does", () => {
    expect(contactLabel({ remote_name: " Ravi " })).toBe("Ravi");
    expect(contactLabel({ remote_number_prefix: "98765", remote_number_last3: "210" })).toBe("98765…210");
    expect(contactLabel({ remote_number_last3: "210" })).toBe("…210");
    expect(contactLabel({})).toBe("Unknown caller");
  });

  it("says why a call needs attention", () => {
    expect(attentionReasons({ risk: true, high_risk: true, sentiment: "negative", quality_score: 22 })).toEqual([
      "High escalation risk",
      "Negative sentiment",
      "Low quality (22/100)",
    ]);
    expect(attentionReasons({ risk: false, sentiment: "neutral", quality_score: 64 })).toEqual([]);
  });

  it("refuses a batch whose shape does not match the statement list", () => {
    expect(() => assembleCallInsights([{ rows: [] }])).toThrow(/expected 14 results/);
  });

  it("assembles what became of the missed calls, and the people still waiting", () => {
    const batch = STATEMENT_ORDER.map((key) => {
      if (key === "meta") {
        return { rows: [{ name: "Acme", zone: "Asia/Kolkata", from_d: "2026-06-01", to_d: "2026-06-02", span: 2, prev_from: "2026-05-30", prev_to: "2026-05-31" }] };
      }
      if (key === "callbacks") {
        return {
          rows: [{ missed: 12, no_number: 2, returned: 7, called_back: 5, within_hour: 4, median_minutes: 38.5, waiting_callers: 3 }],
        };
      }
      if (key === "waiting") {
        return {
          rows: [
            { call_id: "c1", attempts: 3, last_missed_at: "2026-06-02T08:00:00Z", remote_number_prefix: "98765", remote_number_last3: "210", telecaller: "Priya", lead_id: null, lead_title: null },
          ],
        };
      }
      return { rows: [] };
    });
    const { callbacks } = assembleCallInsights(batch);
    expect(callbacks).toMatchObject({ missed: 12, noNumber: 2, returned: 7, calledBack: 5, withinHour: 4, medianMinutes: 38.5, waitingCallers: 3 });
    expect(callbacks.waiting).toEqual([
      { callId: "c1", contact: "98765…210", lastMissedAt: "2026-06-02T08:00:00.000Z", attempts: 3, telecaller: "Priya", leadId: null, leadTitle: null },
    ]);
  });

  it("reads an org with no missed calls as zeros and no median, not as missing", () => {
    const batch = STATEMENT_ORDER.map((key) =>
      key === "meta"
        ? { rows: [{ name: "Acme", zone: "Asia/Kolkata", from_d: "2026-06-01", to_d: "2026-06-01", span: 1, prev_from: "2026-05-31", prev_to: "2026-05-31" }] }
        : { rows: [] },
    );
    const { callbacks } = assembleCallInsights(batch);
    expect(callbacks).toEqual({
      missed: 0, noNumber: 0, returned: 0, calledBack: 0, withinHour: 0, medianMinutes: null, waitingCallers: 0, waiting: [],
    });
  });

  it("derives neutral as the remainder, so sentiment always adds up to analysed", () => {
    const batch = STATEMENT_ORDER.map((key) => {
      if (key === "meta") {
        return { rows: [{ name: "Acme", zone: "Asia/Kolkata", from_d: "2026-06-01", to_d: "2026-06-02", span: 2, prev_from: "2026-05-30", prev_to: "2026-05-31" }] };
      }
      if (key === "totals") {
        return { rows: [{ period: "current", total: 10, analyzed: 8, positive: 3, negative: 1 }] };
      }
      return { rows: [] };
    });
    const report = assembleCallInsights(batch, new Date("2026-06-03T00:00:00Z"));
    expect(report.sentiment.map((s) => s.count)).toEqual([3, 4, 1]);
    // A period with no row reads as zeros, not as missing.
    expect(report.previous.total).toBe(0);
    expect(report.daily).toHaveLength(2);
    expect(report.generatedAt).toBe("2026-06-03T00:00:00.000Z");
  });
});
