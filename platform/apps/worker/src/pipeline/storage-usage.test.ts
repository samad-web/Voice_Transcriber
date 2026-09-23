import { describe, expect, it, vi } from "vitest";

vi.mock("@aura/db", () => ({ getAdminPool: vi.fn() }));

import { estimateDue, quotaAlertDecision } from "./storage-usage";

describe("estimateDue - the nightly database estimate", () => {
  // 2026-09-21 01:30 IST = 2026-09-20 20:00 UTC.
  const beforeTwoIst = new Date("2026-09-20T20:00:00Z");
  // 2026-09-21 02:30 IST = 2026-09-20 21:00 UTC.
  const afterTwoIst = new Date("2026-09-20T21:00:00Z");

  it("waits for 02:00 IST even when nothing has ever been estimated", () => {
    expect(estimateDue(beforeTwoIst, null)).toBe(false);
    expect(estimateDue(afterTwoIst, null)).toBe(true);
  });

  it("runs once per IST day, not hourly", () => {
    // Estimated at 02:05 IST today -> not again at 02:30 or at 15:00.
    const doneToday = new Date("2026-09-20T20:35:00Z");
    expect(estimateDue(afterTwoIst, doneToday)).toBe(false);
    expect(estimateDue(new Date("2026-09-21T09:30:00Z"), doneToday)).toBe(false);
  });

  it("runs again the next night", () => {
    const doneYesterday = new Date("2026-09-19T20:35:00Z");
    expect(estimateDue(afterTwoIst, doneYesterday)).toBe(true);
  });
});

describe("quotaAlertDecision", () => {
  it("tells the owners when 80 % is first crossed, and not again at 85 %", () => {
    expect(quotaAlertDecision(81, null)).toEqual({ level: 80, notify: true });
    expect(quotaAlertDecision(85, 80)).toEqual({ level: 80, notify: false });
  });

  it("tells them again at 100 %", () => {
    expect(quotaAlertDecision(100, 80)).toEqual({ level: 100, notify: true });
    expect(quotaAlertDecision(140, 100)).toEqual({ level: 100, notify: false });
  });

  it("resets under 80 %, so a second climb is told again", () => {
    expect(quotaAlertDecision(50, 80)).toEqual({ level: null, notify: false });
    expect(quotaAlertDecision(82, null)).toEqual({ level: 80, notify: true });
  });

  it("records a drop from 100 to 80 without telling anyone", () => {
    // A raised quota: nothing new to say, but the next 100 must be told.
    expect(quotaAlertDecision(90, 100)).toEqual({ level: 80, notify: false });
  });

  it("never alerts without a quota", () => {
    expect(quotaAlertDecision(null, null)).toEqual({ level: null, notify: false });
  });
});
