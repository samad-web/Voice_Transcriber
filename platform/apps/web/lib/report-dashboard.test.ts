import { describe, expect, it } from "vitest";
import {
  closedDealsHref,
  fillDays,
  formatDateRange,
  formatDuration,
  formatPercent,
  formatPercentPoints,
  leadsArrivedHref,
  niceCeiling,
  openDealsHref,
  overdueTasksHref,
  staleDealsHref,
} from "./report-dashboard";
import { viewQueryFrom } from "./list-views";

const P = "5ebb336b-4f09-4b61-8d8b-107e191bb22d";
const queryOf = (href: string) => new URLSearchParams(href.split("?")[1] ?? "");

// The date range itself moved to lib/date-range.ts, shared with every report.

describe("formatting", () => {
  it("words a response time by its size", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(0.4)).toBe("<1 min");
    expect(formatDuration(14.6)).toBe("15 min");
    expect(formatDuration(90)).toBe("1.5 h");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(60 * 30)).toBe("30 h");
    expect(formatDuration(60 * 24 * 5)).toBe("5 d");
  });

  it("formats a percentage and a date range", () => {
    expect(formatPercent(0.41666)).toBe("42%");
    expect(formatPercent(null)).toBe("-");
    // The SLA reports' *Pct fields are already 0-100 - the "5000%" bug.
    expect(formatPercentPoints(50)).toBe("50%");
    expect(formatPercentPoints(66.7)).toBe("67%");
    expect(formatPercentPoints(null)).toBe("-");
    expect(formatDateRange("2026-08-17", "2026-09-15")).toBe("17 Aug – 15 Sep");
    expect(formatDateRange("2026-09-15", "2026-09-15")).toBe("15 Sep");
  });
});

describe("drill-down links", () => {
  it("opens exactly the window and pipeline the report echoed", () => {
    const href = closedDealsHref(P, "2026-08-17", "2026-09-15");
    expect(href.startsWith("/owner/deals?")).toBe(true);
    expect(Object.fromEntries(queryOf(href))).toEqual({
      createdFrom: "2026-08-17",
      createdTo: "2026-09-15",
      pipelineId: P,
      status: "closed",
      view: "table",
    });
  });

  it("survives the deals list's own normalisation, so a saved view of it is the same list", () => {
    for (const href of [closedDealsHref(P, "2026-08-17", "2026-09-15"), openDealsHref(P, "negotiation"), staleDealsHref(P)]) {
      const q = queryOf(href);
      expect(viewQueryFrom("deals", q)).toEqual(Object.fromEntries([...q.entries()].filter(([k, v]) => !(k === "sort" && v === "activity"))));
    }
  });

  it("builds the lead and task links", () => {
    expect(Object.fromEntries(queryOf(leadsArrivedHref("2026-09-01", "2026-09-01", true)))).toEqual({
      createdFrom: "2026-09-01",
      createdTo: "2026-09-01",
      responded: "no",
    });
    expect(overdueTasksHref()).toBe("/owner/tasks?due=overdue");
    expect(openDealsHref(null)).toBe("/owner/deals?sort=amount&status=open&view=table");
  });
});

describe("chart data", () => {
  it("fills the days the report left out, in order", () => {
    const days = fillDays(
      [
        { date: "2026-09-02", leads: 3 },
        { date: "2026-08-31", leads: 1 },
      ],
      "2026-08-30",
      "2026-09-02",
      (date) => ({ date, leads: 0 }),
    );
    expect(days.map((d) => `${d.date}:${d.leads}`)).toEqual([
      "2026-08-30:0",
      "2026-08-31:1",
      "2026-09-01:0",
      "2026-09-02:3",
    ]);
  });

  it("rounds an axis top to 1/2/5/10 steps", () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(3)).toBe(5);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(12)).toBe(20);
    expect(niceCeiling(200)).toBe(200);
    expect(niceCeiling(4200)).toBe(5000);
  });
});
