import { describe, expect, it } from "vitest";
import {
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
