import { describe, expect, it } from "vitest";
import {
  accountingPresets,
  ACCOUNTING_PRESETS,
  CALENDAR_LABEL,
  CALENDAR_PRESETS,
  CALENDAR_UNITS,
  comparisonWindows,
  dateWindowHref,
  dateWindowQuery,
  parseDateWindow,
  periodPresets,
  rangePresets,
  resolveDateWindow,
  spanDays,
  windowPhrase,
  windowTitle,
} from "./date-range";

describe("parseDateWindow", () => {
  it("opens on the page's default preset", () => {
    expect(parseDateWindow({})).toEqual({ window: { kind: "relative", days: 30 }, invalid: false });
    expect(parseDateWindow({}, { defaultDays: 90 }).window).toEqual({ kind: "relative", days: 90 });
  });

  it("reads a count, and an old parameter name for it", () => {
    expect(parseDateWindow({ days: "7" }).window).toEqual({ kind: "relative", days: 7 });
    expect(parseDateWindow({ range: "90" }, { legacyDaysKey: "range" }).window).toEqual({ kind: "relative", days: 90 });
    expect(parseDateWindow({ days: "7", range: "90" }, { legacyDaysKey: "range" }).window).toEqual({
      kind: "relative",
      days: 7,
    });
  });

  it("reads an explicit range, forgiving a reversed pair and a lone date", () => {
    expect(parseDateWindow({ from: "2026-09-01", to: "2026-09-21" }).window).toEqual({
      kind: "fixed",
      from: "2026-09-01",
      to: "2026-09-21",
    });
    expect(parseDateWindow({ from: "2026-09-21", to: "2026-09-01" }).window).toEqual({
      kind: "fixed",
      from: "2026-09-01",
      to: "2026-09-21",
    });
    expect(parseDateWindow({ from: "2026-09-05" }).window).toEqual({ kind: "fixed", from: "2026-09-05", to: "2026-09-05" });
    // An explicit range wins over a count.
    expect(parseDateWindow({ days: "7", from: "2026-09-01", to: "2026-09-02" }).window.kind).toBe("fixed");
  });

  it("falls back to the default, and says so, for what cannot be read", () => {
    for (const sp of [
      { days: "0" },
      { days: "1.5" },
      { days: "367" },
      { days: "abc" },
      { from: "2026-02-31", to: "2026-03-01" },
      { from: "yesterday", to: "2026-09-01" },
      { from: "2025-01-01", to: "2026-09-01" },
    ]) {
      expect([sp, parseDateWindow(sp)]).toEqual([sp, { window: { kind: "relative", days: 30 }, invalid: true }]);
    }
  });
});

describe("links", () => {
  it("leaves the default out, so the plain path stays the default view", () => {
    expect(dateWindowHref("/owner/reports", { kind: "relative", days: 30 })).toBe("/owner/reports");
    expect(dateWindowHref("/owner/reports", { kind: "relative", days: 7 })).toBe("/owner/reports?days=7");
    expect(dateWindowHref("/owner/reports/sla", { kind: "relative", days: 90 }, { defaultDays: 90 })).toBe(
      "/owner/reports/sla",
    );
    expect(dateWindowHref("/owner/reports", { kind: "fixed", from: "2026-09-01", to: "2026-09-02" })).toBe(
      "/owner/reports?from=2026-09-01&to=2026-09-02",
    );
  });

  it("keeps the page's other parameters", () => {
    expect(dateWindowHref("/owner/productivity", { kind: "relative", days: 7 }, { keep: { sort: "gap" } })).toBe(
      "/owner/productivity?days=7&sort=gap",
    );
    expect(dateWindowHref("/owner/productivity", { kind: "relative", days: 30 }, { keep: { sort: null } })).toBe(
      "/owner/productivity",
    );
  });

  it("lights the pill for the window showing, and none for a custom range", () => {
    const pills = rangePresets("/owner/reports", { kind: "relative", days: 7 });
    expect(pills.map((p) => [p.label, p.href, p.active])).toEqual([
      ["Today", "/owner/reports?days=1", false],
      ["Last 7 days", "/owner/reports?days=7", true],
      ["Last 30 days", "/owner/reports", false],
      ["Last 90 days", "/owner/reports?days=90", false],
    ]);
    const custom = rangePresets("/owner/reports", { kind: "fixed", from: "2026-09-01", to: "2026-09-02" });
    expect(custom.some((p) => p.active)).toBe(false);
  });

  it("travels to the API as a count or as dates", () => {
    expect(dateWindowQuery({ kind: "relative", days: 7 })).toBe("days=7");
    expect(dateWindowQuery({ kind: "fixed", from: "2026-09-01", to: "2026-09-02" })).toBe("from=2026-09-01&to=2026-09-02");
  });
});

describe("periodPresets (the call log's named periods)", () => {
  const PERIODS = [
    { key: "today", label: "Today" },
    { key: "this_month", label: "This month" },
  ];

  it("leads with Any date, lit when no date filter is set", () => {
    const pills = periodPresets("/owner/calls", PERIODS, null);
    expect(pills.map((p) => [p.label, p.href, p.active])).toEqual([
      ["Any date", "/owner/calls", true],
      ["Today", "/owner/calls?period=today", false],
      ["This month", "/owner/calls?period=this_month", false],
    ]);
  });

  it("lights the named period, and none for a custom range", () => {
    expect(periodPresets("/owner/calls", PERIODS, "this_month").filter((p) => p.active).map((p) => p.key)).toEqual([
      "this_month",
    ]);
    expect(periodPresets("/owner/calls", PERIODS, "custom").some((p) => p.active)).toBe(false);
  });

  it("keeps the other filters on every pill", () => {
    const pills = periodPresets("/owner/calls", PERIODS, null, { direction: "incoming", q: undefined, sort: "oldest" });
    expect(pills.map((p) => p.href)).toEqual([
      "/owner/calls?direction=incoming&sort=oldest",
      "/owner/calls?period=today&direction=incoming&sort=oldest",
      "/owner/calls?period=this_month&direction=incoming&sort=oldest",
    ]);
  });
});

describe("resolving and naming", () => {
  it("counts back from the org's today, inclusive", () => {
    expect(resolveDateWindow({ kind: "relative", days: 30 }, "2026-09-22")).toEqual({ from: "2026-08-24", to: "2026-09-22" });
    expect(resolveDateWindow({ kind: "relative", days: 1 }, "2026-09-22")).toEqual({ from: "2026-09-22", to: "2026-09-22" });
    expect(resolveDateWindow({ kind: "relative", days: 7 }, "2027-01-03")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
    expect(resolveDateWindow({ kind: "fixed", from: "2026-01-01", to: "2026-01-31" }, "2026-09-22")).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(spanDays("2026-08-24", "2026-09-22")).toBe(30);
  });

  it("words the window for a subtitle", () => {
    expect(windowPhrase({ kind: "relative", days: 30 })).toBe("last 30 days");
    expect(windowPhrase({ kind: "relative", days: 1 })).toBe("today");
    expect(windowTitle({ kind: "relative", days: 7 })).toBe("Last 7 days");
    expect(windowTitle({ kind: "fixed", from: "2026-09-01", to: "2026-09-30" })).toBe("1 – 30 Sep 2026");
  });
});

describe("calendar periods", () => {
  it("reads a named period off the URL", () => {
    expect(parseDateWindow({ period: "week" })).toEqual({
      window: { kind: "calendar", unit: "week" },
      invalid: false,
    });
    expect(parseDateWindow({ period: "month" }).window).toEqual({ kind: "calendar", unit: "month" });
  });

  it("falls back and says so on a period it cannot read", () => {
    expect(parseDateWindow({ period: "fortnight" })).toEqual({
      window: { kind: "relative", days: 30 },
      invalid: true,
    });
  });

  it("prefers the named period over a count, which is a contradictory URL", () => {
    expect(parseDateWindow({ period: "month", days: "7" }).window).toEqual({
      kind: "calendar",
      unit: "month",
    });
  });

  it("starts the week on Monday", () => {
    // 2026-09-30 is a Wednesday.
    expect(resolveDateWindow({ kind: "calendar", unit: "week" }, "2026-09-30")).toEqual({
      from: "2026-09-28",
      to: "2026-09-30",
    });
  });

  it("treats Sunday as the END of its week, not the start of the next", () => {
    // 2026-10-04 is a Sunday; its week began Monday the 28th of September.
    expect(resolveDateWindow({ kind: "calendar", unit: "week" }, "2026-10-04")).toEqual({
      from: "2026-09-28",
      to: "2026-10-04",
    });
  });

  it("is a single day when today IS Monday", () => {
    expect(resolveDateWindow({ kind: "calendar", unit: "week" }, "2026-09-28")).toEqual({
      from: "2026-09-28",
      to: "2026-09-28",
    });
  });

  it("starts the month on the first and ends it TODAY, never on its last day", () => {
    expect(resolveDateWindow({ kind: "calendar", unit: "month" }, "2026-09-03")).toEqual({
      from: "2026-09-01",
      to: "2026-09-03",
    });
  });

  it("stays symbolic in the URL, so a copied link still means this month", () => {
    // The whole reason calendar is its own window kind: baked dates would have
    // meant September forever.
    expect(dateWindowQuery({ kind: "calendar", unit: "month" })).toBe("period=month");
    expect(dateWindowHref("/owner/performance", { kind: "calendar", unit: "week" })).toBe(
      "/owner/performance?period=week",
    );
  });

  it("says 'so far', because the period runs to today", () => {
    expect(windowPhrase({ kind: "calendar", unit: "week" })).toBe("this week so far");
    expect(windowTitle({ kind: "calendar", unit: "month" })).toBe("This month so far");
  });

  it("offers no calendar pills unless the page asks for them", () => {
    const plain = rangePresets("/owner/calls", { kind: "relative", days: 30 });
    expect(plain.map((p) => p.key)).toEqual(["1", "7", "30", "90"]);
  });

  it("puts the calendar pills after Today and before the rolling windows", () => {
    const pills = rangePresets("/owner/performance", { kind: "calendar", unit: "week" }, {
      calendar: true,
    });
    expect(pills.map((p) => p.key)).toEqual(["1", "week", "month", "7", "30", "90"]);
    expect(pills.find((p) => p.active)?.key).toBe("week");
  });

  it("keeps a page's other parameters across a calendar pill", () => {
    const pills = rangePresets("/owner/productivity", { kind: "relative", days: 30 }, {
      calendar: true,
      keep: { sort: "calls" },
    });
    expect(pills.find((p) => p.key === "month")?.href).toBe(
      "/owner/productivity?period=month&sort=calls",
    );
  });
});

/**
 * The three accounting periods, added for
 * Build docs/indian-business-finance-documents-cycles-import §2's period
 * selector: "day, week, month, quarter, half-year, financial year, custom
 * range, with comparison to the previous period and the same period last
 * year."
 */
describe("the accounting periods", () => {
  // 17 September 2026 - inside Q2 (Jul-Sep) and H1 (Apr-Sep) of FY 2026-27.
  const TODAY = "2026-09-17";

  it("parses each of them out of the URL", () => {
    for (const unit of ACCOUNTING_PRESETS) {
      expect(parseDateWindow({ period: unit })).toEqual({
        window: { kind: "calendar", unit },
        invalid: false,
      });
    }
  });

  it("resolves a quarter against an April financial year, period-to-date", () => {
    expect(resolveDateWindow({ kind: "calendar", unit: "quarter" }, TODAY, 4)).toEqual({
      from: "2026-07-01",
      to: TODAY,
    });
  });

  it("resolves a half-year and a financial year", () => {
    expect(resolveDateWindow({ kind: "calendar", unit: "half" }, TODAY, 4).from).toBe("2026-04-01");
    expect(resolveDateWindow({ kind: "calendar", unit: "year" }, TODAY, 4).from).toBe("2026-04-01");
  });

  it("follows a January financial year instead of hard-coding April", () => {
    // The whole reason `fyStartMonth` is threaded through: a calendar-year
    // tenant's Q3 opens in July, not the Indian Q2.
    expect(resolveDateWindow({ kind: "calendar", unit: "quarter" }, TODAY, 1).from).toBe("2026-07-01");
    expect(resolveDateWindow({ kind: "calendar", unit: "year" }, TODAY, 1).from).toBe("2026-01-01");
  });

  it("defaults to April when no start month is passed, so existing callers are unchanged", () => {
    expect(resolveDateWindow({ kind: "calendar", unit: "year" }, TODAY).from).toBe("2026-04-01");
  });

  it("agrees with the compliance calendar about where a January quarter belongs", () => {
    // January is Q4 of the financial year that opened the previous April, so
    // the window starts on 1 January and NOT on the 1st of the new FY.
    expect(resolveDateWindow({ kind: "calendar", unit: "quarter" }, "2027-01-20", 4).from).toBe(
      "2027-01-01",
    );
    expect(resolveDateWindow({ kind: "calendar", unit: "year" }, "2027-01-20", 4).from).toBe(
      "2026-04-01",
    );
  });

  it("names the financial year rather than calling it This year", () => {
    // For eleven months of an Indian FY the two mean different things.
    expect(CALENDAR_LABEL.year).toBe("Financial year");
    expect(CALENDAR_LABEL.quarter).toBe("This quarter");
    expect(CALENDAR_LABEL.half).toBe("This half-year");
  });

  it("still round-trips through the query string symbolically", () => {
    // Not resolved to dates in the URL, so a link copied today still means
    // "this quarter" when it is opened in December.
    expect(dateWindowQuery({ kind: "calendar", unit: "quarter" })).toBe("period=quarter");
  });
});

describe("accountingPresets", () => {
  it("offers exactly the four periods, in order", () => {
    const pills = accountingPresets("/owner/finance", { kind: "calendar", unit: "quarter" });
    expect(pills.map((p) => p.key)).toEqual(["month", "quarter", "half", "year"]);
    expect(pills.find((p) => p.active)?.key).toBe("quarter");
  });

  it("gives the default unit the bare path, keeping it the canonical address", () => {
    const pills = accountingPresets("/owner/finance", { kind: "relative", days: 30 });
    expect(pills.find((p) => p.key === "month")?.href).toBe("/owner/finance");
    expect(pills.find((p) => p.key === "quarter")?.href).toBe("/owner/finance?period=quarter");
  });

  it("lights the default unit when the window is the page default", () => {
    const pills = accountingPresets("/owner/finance", { kind: "relative", days: 30 });
    expect(pills.find((p) => p.active)?.key).toBe("month");
  });

  it("keeps a page's other parameters", () => {
    const pills = accountingPresets("/owner/finance/compliance", { kind: "calendar", unit: "year" }, {
      keep: { status: "overdue" },
    });
    expect(pills.find((p) => p.key === "half")?.href).toBe(
      "/owner/finance/compliance?period=half&status=overdue",
    );
  });
});

describe("comparisonWindows", () => {
  const TODAY = "2026-09-17";

  it("gives the previous quarter and the same quarter last year", () => {
    const compare = comparisonWindows({ kind: "calendar", unit: "quarter" }, TODAY, 4);
    expect(compare?.previous).toEqual({ from: "2026-04-01", to: "2026-06-30", label: "Q1 FY 2026-27" });
    expect(compare?.lastYear).toEqual({ from: "2025-07-01", to: "2025-09-30", label: "Q2 FY 2025-26" });
  });

  it("steps a quarter by months, not by days", () => {
    // Q1 Apr-Jun is 91 days and Q4 Jan-Mar is 90. Day arithmetic lands wrong,
    // which is the reason this helper exists at all.
    const compare = comparisonWindows({ kind: "calendar", unit: "quarter" }, "2026-05-10", 4);
    expect(compare?.previous.from).toBe("2026-01-01");
    expect(compare?.previous.to).toBe("2026-03-31");
  });

  it("keeps February whole when last year was a leap year", () => {
    const compare = comparisonWindows({ kind: "calendar", unit: "month" }, "2025-02-10", 4);
    expect(compare?.lastYear).toEqual({ from: "2024-02-01", to: "2024-02-29", label: "February 2024" });
  });

  it("returns null for a rolling or custom window, where last year has no meaning", () => {
    expect(comparisonWindows({ kind: "relative", days: 30 }, TODAY)).toBeNull();
    expect(comparisonWindows({ kind: "fixed", from: "2026-01-01", to: "2026-01-31" }, TODAY)).toBeNull();
  });

  it("compares a financial year with the one before it", () => {
    const compare = comparisonWindows({ kind: "calendar", unit: "year" }, TODAY, 4);
    expect(compare?.previous.label).toBe("FY 2025-26");
    expect(compare?.lastYear.label).toBe("FY 2025-26");
  });
});

describe("the period parameter's own vocabulary", () => {
  it("accepts every unit the pills can produce", () => {
    // The guard against the bug the accounting periods first shipped with:
    // pills that rendered ?period=quarter, a parser that rejected it, and a
    // page that silently showed the last 30 days instead.
    for (const unit of CALENDAR_UNITS) {
      expect(parseDateWindow({ period: unit }).invalid).toBe(false);
    }
  });

  it("still refuses a unit nothing offers", () => {
    expect(parseDateWindow({ period: "fortnight" }).invalid).toBe(true);
    expect(parseDateWindow({ period: "decade" }).invalid).toBe(true);
  });

  it("covers every pill in both lists", () => {
    for (const unit of [...CALENDAR_PRESETS, ...ACCOUNTING_PRESETS]) {
      expect(CALENDAR_UNITS).toContain(unit);
    }
  });
});
