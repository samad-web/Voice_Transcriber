import { describe, expect, it } from "vitest";
import {
  DEFAULT_STALE_AFTER_DAYS,
  idleDays,
  normaliseStaleAfterDays,
  staleDays,
} from "./deal-staleness";

const NOW = Date.parse("2026-09-15T12:00:00Z");
const daysAgo = (d: number, extraHours = 0) => new Date(NOW - d * 86_400_000 - extraHours * 3_600_000).toISOString();

describe("idleDays", () => {
  it("floors to whole days", () => {
    expect(idleDays(daysAgo(6, 23), NOW)).toBe(6);
    expect(idleDays(daysAgo(7), NOW)).toBe(7);
  });
  it("is null for nothing to measure, and never negative for a clock-skewed future time", () => {
    expect(idleDays(null, NOW)).toBeNull();
    expect(idleDays("not a date", NOW)).toBeNull();
    expect(idleDays(new Date(NOW + 60_000).toISOString(), NOW)).toBe(0);
  });
});

describe("staleDays", () => {
  it("flags an open deal at exactly the threshold, not a day before", () => {
    expect(staleDays({ status: "open", last_activity_at: daysAgo(7) }, 7, NOW)).toBe(7);
    expect(staleDays({ status: "open", last_activity_at: daysAgo(6, 23) }, 7, NOW)).toBeNull();
  });
  it("never flags a closed deal, however old", () => {
    expect(staleDays({ status: "won", last_activity_at: daysAgo(90) }, 7, NOW)).toBeNull();
    expect(staleDays({ status: "lost", last_activity_at: daysAgo(90) }, 7, NOW)).toBeNull();
  });
});

describe("normaliseStaleAfterDays", () => {
  it("defaults to 7 when there is nothing usable", () => {
    expect(DEFAULT_STALE_AFTER_DAYS).toBe(7);
    expect(normaliseStaleAfterDays(undefined)).toBe(7);
    expect(normaliseStaleAfterDays("abc")).toBe(7);
  });
  it("clamps into 1..365 and rounds", () => {
    expect(normaliseStaleAfterDays(0)).toBe(1);
    expect(normaliseStaleAfterDays("900")).toBe(365);
    expect(normaliseStaleAfterDays(10.6)).toBe(11);
  });
});
