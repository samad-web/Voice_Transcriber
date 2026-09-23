import { describe, expect, it } from "vitest";
import {
  CALL_LOG_PERIODS,
  CallLogDateQuery,
  callLogDateParams,
  callLogDateSelection,
  callLogPeriodLabel,
  isCallLogPeriod,
} from "./call-log";

describe("CallLogDateQuery (the API's strict parse)", () => {
  it("accepts a preset, a pair of dates, or nothing, and defaults to newest first", () => {
    expect(CallLogDateQuery.parse({})).toEqual({ sort: "newest" });
    expect(CallLogDateQuery.parse({ period: "last7" })).toEqual({ period: "last7", sort: "newest" });
    expect(CallLogDateQuery.parse({ from: "2026-09-01", to: "2026-09-21", sort: "oldest" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-21",
      sort: "oldest",
    });
  });

  it("accepts a single day as a pair of the same date", () => {
    expect(CallLogDateQuery.safeParse({ from: "2026-09-13", to: "2026-09-13" }).success).toBe(true);
  });

  it("refuses a lone date, a reversed pair, a date that does not exist, and an unknown preset", () => {
    expect(CallLogDateQuery.safeParse({ from: "2026-09-01" }).success).toBe(false);
    expect(CallLogDateQuery.safeParse({ to: "2026-09-01" }).success).toBe(false);
    expect(CallLogDateQuery.safeParse({ from: "2026-09-21", to: "2026-09-01" }).success).toBe(false);
    // Date-shaped but not a date: it would reach Postgres and 500 there.
    expect(CallLogDateQuery.safeParse({ from: "2026-02-31", to: "2026-03-01" }).success).toBe(false);
    expect(CallLogDateQuery.safeParse({ period: "last_week" }).success).toBe(false);
    expect(CallLogDateQuery.safeParse({ sort: "loudest" }).success).toBe(false);
  });
});

describe("callLogDateSelection (the web tier's forgiving read of a URL)", () => {
  it("is nothing when nothing usable is there", () => {
    expect(callLogDateSelection({})).toBeNull();
    expect(callLogDateSelection({ period: "fortnight" })).toBeNull();
    expect(callLogDateSelection({ from: "yesterday", to: "" })).toBeNull();
  });

  it("reads a preset", () => {
    expect(callLogDateSelection({ period: "this_month" })).toEqual({ kind: "period", period: "this_month" });
  });

  it("makes a lone date that one day, whichever end it was given as", () => {
    const day = { kind: "range", from: "2026-09-13", to: "2026-09-13" };
    expect(callLogDateSelection({ from: "2026-09-13" })).toEqual(day);
    expect(callLogDateSelection({ to: "2026-09-13" })).toEqual(day);
  });

  it("puts a reversed pair the right way round rather than failing the page", () => {
    expect(callLogDateSelection({ from: "2026-09-21", to: "2026-09-01" })).toEqual({
      kind: "range",
      from: "2026-09-01",
      to: "2026-09-21",
    });
  });

  it("lets explicit dates win over a preset, and drops a date that is not one", () => {
    expect(callLogDateSelection({ period: "today", from: "2026-09-01", to: "2026-09-02" })).toEqual({
      kind: "range",
      from: "2026-09-01",
      to: "2026-09-02",
    });
    expect(callLogDateSelection({ period: "today", from: "2026-02-31" })).toEqual({
      kind: "period",
      period: "today",
    });
  });

  it("always produces something the strict parse accepts", () => {
    const inputs = [
      { from: "2026-09-21", to: "2026-09-01" },
      { from: "2026-09-13" },
      { to: "2026-09-13" },
      { period: "last30" },
    ];
    for (const input of inputs) {
      const params = callLogDateParams(callLogDateSelection(input));
      expect([input, CallLogDateQuery.safeParse(params).success]).toEqual([input, true]);
    }
  });
});

describe("the preset vocabulary", () => {
  it("labels every preset and recognises only its own keys", () => {
    for (const { key, label } of CALL_LOG_PERIODS) {
      expect(isCallLogPeriod(key)).toBe(true);
      expect(callLogPeriodLabel(key)).toBe(label);
    }
    expect(isCallLogPeriod("week")).toBe(false);
    expect(isCallLogPeriod(null)).toBe(false);
  });

  it("travels as the parameter the API reads", () => {
    expect(callLogDateParams(null)).toEqual({});
    expect(callLogDateParams({ kind: "period", period: "yesterday" })).toEqual({ period: "yesterday" });
    expect(callLogDateParams({ kind: "range", from: "2026-09-01", to: "2026-09-02" })).toEqual({
      from: "2026-09-01",
      to: "2026-09-02",
    });
  });
});
