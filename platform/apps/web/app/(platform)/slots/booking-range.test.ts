import { describe, expect, it } from "vitest";
import { bookingPresets, bookingRange, parseBookingWindow } from "./booking-range";

describe("parseBookingWindow", () => {
  it("looks forward a fortnight by default, as the list always did", () => {
    expect(parseBookingWindow({})).toEqual({ window: { kind: "next", days: 14 }, invalid: false });
  });

  it("reads the next N days, the last N days, and an explicit range", () => {
    expect(parseBookingWindow({ next: "7" }).window).toEqual({ kind: "next", days: 7 });
    expect(parseBookingWindow({ days: "30" }).window).toEqual({ kind: "last", days: 30 });
    expect(parseBookingWindow({ from: "2026-09-01", to: "2026-09-15" }).window).toEqual({
      kind: "fixed",
      from: "2026-09-01",
      to: "2026-09-15",
    });
    // An explicit range wins, as everywhere else.
    expect(parseBookingWindow({ next: "7", from: "2026-09-01", to: "2026-09-02" }).window.kind).toBe("fixed");
  });

  it("falls back to the next fortnight, and says so, for what cannot be read", () => {
    for (const sp of [{ next: "0" }, { next: "abc" }, { days: "400" }, { from: "2026-02-31", to: "2026-03-01" }]) {
      expect([sp, parseBookingWindow(sp)]).toEqual([sp, { window: { kind: "next", days: 14 }, invalid: true }]);
    }
  });
});

describe("bookingRange", () => {
  it("counts from the scheduler zone's today, today included", () => {
    expect(bookingRange({ kind: "next", days: 14 }, "2026-09-22")).toEqual({ from: "2026-09-22", to: "2026-10-05" });
    expect(bookingRange({ kind: "last", days: 7 }, "2026-09-22")).toEqual({ from: "2026-09-16", to: "2026-09-22" });
    expect(bookingRange({ kind: "fixed", from: "2026-01-01", to: "2026-01-02" }, "2026-09-22")).toEqual({
      from: "2026-01-01",
      to: "2026-01-02",
    });
  });
});

describe("bookingPresets", () => {
  it("offers what is coming first, and lights the window showing", () => {
    expect(bookingPresets({ kind: "next", days: 14 }).map((p) => [p.label, p.href, p.active])).toEqual([
      ["Next 7 days", "/slots?next=7", false],
      ["Next 14 days", "/slots", true],
      ["Next 30 days", "/slots?next=30", false],
      ["Last 7 days", "/slots?days=7", false],
      ["Last 30 days", "/slots?days=30", false],
    ]);
    expect(bookingPresets({ kind: "fixed", from: "2026-09-01", to: "2026-09-02" }).some((p) => p.active)).toBe(false);
  });
});
