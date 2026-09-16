import { resolveWindow } from "./reports.controller";

/**
 * The report window. The dashboard builds every drill-down link from the
 * `from`/`to` a report echoes, so the arithmetic here is what decides whether
 * "Last 30 days" and the list it opens cover the same days.
 */
describe("resolveWindow", () => {
  it("counts `days` inclusively, ending on `to`", () => {
    expect(resolveWindow(undefined, "2026-09-15", 30)).toEqual({ from: "2026-08-17", to: "2026-09-15" });
    expect(resolveWindow(undefined, "2026-09-15", 7)).toEqual({ from: "2026-09-09", to: "2026-09-15" });
    expect(resolveWindow(undefined, "2026-09-15", 1)).toEqual({ from: "2026-09-15", to: "2026-09-15" });
  });

  it("keeps the 90-day default when no days are given", () => {
    expect(resolveWindow(undefined, "2026-09-15")).toEqual({ from: "2026-06-18", to: "2026-09-15" });
  });

  it("lets an explicit `from` win over `days`", () => {
    expect(resolveWindow("2026-09-01", "2026-09-15", 7)).toEqual({ from: "2026-09-01", to: "2026-09-15" });
  });

  it("crosses a year boundary", () => {
    expect(resolveWindow(undefined, "2027-01-05", 7)).toEqual({ from: "2026-12-30", to: "2027-01-05" });
  });
});
