import { describe, expect, it } from "vitest";
import {
  inQuietWindow,
  quietHoursFromEnv,
  quietWindowEndsAt,
  shouldHoldForQuietHours,
  type QuietHours,
} from "./quiet-hours";

/** 21:00 → 09:00 Asia/Kolkata: the window that wraps midnight. */
const IST: QuietHours = { startHour: 21, endHour: 9, timeZone: "Asia/Kolkata" };

/**
 * An instant, given as an IST wall-clock time. Built from an ISO offset string
 * rather than by arithmetic on UTC parts — the offset is the thing under test,
 * so computing it in the test too would let both sides be wrong together.
 */
const at = (istClock: string): Date => new Date(`2026-08-20T${istClock}:00+05:30`);

describe("inQuietWindow — wrapping window (21:00 → 09:00)", () => {
  it("is quiet at 23:00 and at 03:00", () => {
    expect(inQuietWindow(at("23:00"), IST)).toBe(true);
    expect(inQuietWindow(at("03:00"), IST)).toBe(true);
  });

  it("is not quiet during the working day", () => {
    expect(inQuietWindow(at("12:00"), IST)).toBe(false);
    expect(inQuietWindow(at("20:59"), IST)).toBe(false);
  });

  it("treats the boundaries as [start, end)", () => {
    // 21:00 exactly is quiet; 09:00 exactly is not — otherwise a message
    // queued for 09:00 sharp waits a further day.
    expect(inQuietWindow(at("21:00"), IST)).toBe(true);
    expect(inQuietWindow(at("09:00"), IST)).toBe(false);
    expect(inQuietWindow(at("08:59"), IST)).toBe(true);
  });
});

describe("inQuietWindow — non-wrapping window (01:00 → 06:00)", () => {
  const night: QuietHours = { startHour: 1, endHour: 6, timeZone: "Asia/Kolkata" };

  it("is quiet only inside the span", () => {
    expect(inQuietWindow(at("02:00"), night)).toBe(true);
    expect(inQuietWindow(at("00:30"), night)).toBe(false);
    expect(inQuietWindow(at("06:00"), night)).toBe(false);
  });
});

describe("inQuietWindow — zero-width window", () => {
  it("means NOTHING is quiet, not everything", () => {
    // The safe reading: the alternative freezes every send the moment
    // somebody types the same hour twice.
    const zero: QuietHours = { startHour: 9, endHour: 9, timeZone: "Asia/Kolkata" };
    expect(inQuietWindow(at("09:00"), zero)).toBe(false);
    expect(inQuietWindow(at("03:00"), zero)).toBe(false);
  });
});

describe("quietWindowEndsAt", () => {
  it("returns this morning's 09:00 when it is already past midnight", () => {
    const resume = quietWindowEndsAt(at("03:00"), IST);
    expect(resume.toISOString()).toBe(new Date("2026-08-20T09:00:00+05:30").toISOString());
  });

  it("returns TOMORROW's 09:00 when it is still the evening", () => {
    const resume = quietWindowEndsAt(at("22:00"), IST);
    expect(resume.toISOString()).toBe(new Date("2026-08-21T09:00:00+05:30").toISOString());
  });
});

describe("shouldHoldForQuietHours", () => {
  it("holds a nurture message at 03:00", () => {
    expect(shouldHoldForQuietHours("nurture_1", at("03:00"), IST)).toBe(true);
  });

  it("NEVER holds a 1-hour call reminder", () => {
    // Deferring this past the window delivers it after the call it is about,
    // which is worse than sending it late at night.
    expect(shouldHoldForQuietHours("reminder_call_1h", at("03:00"), IST)).toBe(false);
    expect(shouldHoldForQuietHours("reminder_call_5m", at("03:00"), IST)).toBe(false);
  });

  it("holds the courtesy messages — a thank-you keeps until morning", () => {
    expect(shouldHoldForQuietHours("call_attended", at("03:00"), IST)).toBe(true);
    expect(shouldHoldForQuietHours("call_no_show", at("03:00"), IST)).toBe(true);
  });

  it("holds nothing when quiet hours are not configured", () => {
    expect(shouldHoldForQuietHours("nurture_1", at("03:00"), null)).toBe(false);
  });

  it("holds nothing during the day", () => {
    expect(shouldHoldForQuietHours("nurture_1", at("14:00"), IST)).toBe(false);
  });
});

describe("quietHoursFromEnv", () => {
  it("is null when unset — it never invents a window", () => {
    expect(quietHoursFromEnv({})).toBeNull();
  });

  it("is null for the EMPTY STRING compose passes for an unset var", () => {
    // `${VAR:-}` arrives as "", not undefined. `??` would keep it — the exact
    // mistake that silently disabled Google Calendar on 2026-08-10.
    expect(quietHoursFromEnv({ QUIET_HOURS_START: "", QUIET_HOURS_END: "" })).toBeNull();
    expect(quietHoursFromEnv({ QUIET_HOURS_START: "21", QUIET_HOURS_END: "  " })).toBeNull();
  });

  it("is null for out-of-range or non-numeric hours", () => {
    expect(quietHoursFromEnv({ QUIET_HOURS_START: "21", QUIET_HOURS_END: "24" })).toBeNull();
    expect(quietHoursFromEnv({ QUIET_HOURS_START: "nine", QUIET_HOURS_END: "21" })).toBeNull();
  });

  it("reads the window and defaults the zone to Asia/Kolkata", () => {
    expect(quietHoursFromEnv({ QUIET_HOURS_START: "21", QUIET_HOURS_END: "9" })).toEqual({
      startHour: 21,
      endHour: 9,
      timeZone: "Asia/Kolkata",
    });
  });

  it("honours SCHEDULER_TIMEZONE, the same var the outbox already reads", () => {
    expect(
      quietHoursFromEnv({
        QUIET_HOURS_START: "22",
        QUIET_HOURS_END: "8",
        SCHEDULER_TIMEZONE: "Europe/London",
      }),
    ).toEqual({ startHour: 22, endHour: 8, timeZone: "Europe/London" });
  });
});

describe("localMinutesOfDay via a DST zone", () => {
  it("tracks the offset change rather than assuming a fixed one", () => {
    // Europe/London is +01:00 in August. A fixed-offset implementation (the
    // shape B2 Consultants' version uses, correct for IST only) reads this
    // hour wrong for half the year.
    const london: QuietHours = { startHour: 21, endHour: 9, timeZone: "Europe/London" };
    // 20:30 UTC = 21:30 London in summer → inside the window.
    expect(inQuietWindow(new Date("2026-08-20T20:30:00Z"), london)).toBe(true);
    // 20:30 UTC = 20:30 London in winter → outside it.
    expect(inQuietWindow(new Date("2026-01-20T20:30:00Z"), london)).toBe(false);
  });
});
