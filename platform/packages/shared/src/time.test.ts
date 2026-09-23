import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_ZONE,
  canonicalTimeZone,
  dayKeyIn,
  formatDate,
  formatDateKey,
  formatDateTime,
  formatDayMonth,
  formatHourBand,
  formatRelative,
  formatTime,
  formatUtcOffset,
  formatWeekdayDate,
  instantToWallTime,
  isValidTimeZone,
  parseOffsetQuery,
  resolveTimeZone,
  searchTimeZones,
  shiftDateKey,
  timeZoneCity,
  timeZoneLabel,
  timeZoneOptions,
  timeZoneShortLabel,
  timeZoneSpellings,
  todayIn,
  utcOffsetMinutes,
  wallTimeToInstant,
  weekdayOfDateKey,
  zonedParts,
} from "./time";

describe("zone names", () => {
  it("folds ICU's legacy spellings onto the current IANA name, case-insensitively", () => {
    expect(canonicalTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("asia/kolkata")).toBe("Asia/Kolkata");
    expect(canonicalTimeZone("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(canonicalTimeZone("Etc/UTC")).toBe("UTC");
    expect(canonicalTimeZone("GMT")).toBe("UTC");
  });

  it("rejects what is not a zone", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(canonicalTimeZone("not a zone")).toBeNull();
    expect(resolveTimeZone("not a zone")).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE);
  });

  it("offers a legacy spelling to an older database only where one exists", () => {
    expect(timeZoneSpellings("Europe/Kyiv")).toEqual(["Europe/Kyiv", "Europe/Kiev"]);
    expect(timeZoneSpellings("Asia/Calcutta")).toEqual(["Asia/Kolkata", "Asia/Calcutta"]);
    expect(timeZoneSpellings("Asia/Dubai")).toEqual(["Asia/Dubai"]);
    expect(timeZoneSpellings("UTC")).toEqual(["UTC"]);
  });

  it("names a zone by city and offset", () => {
    expect(timeZoneCity("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(timeZoneLabel("Asia/Kolkata", "2026-09-22T00:00:00Z")).toBe("Kolkata (IST · UTC+05:30)");
    // A DST zone is named by its offset on that date, never by an abbreviation
    // that is wrong for half the year.
    expect(timeZoneShortLabel("America/New_York", "2026-07-01T12:00:00Z")).toBe("UTC-04:00");
    expect(timeZoneShortLabel("America/New_York", "2026-12-01T12:00:00Z")).toBe("UTC-05:00");
  });
});

describe("day keys", () => {
  it("puts the IST midnight at 18:30 UTC, not at 00:00 UTC", () => {
    expect(dayKeyIn("2026-09-21T18:29:59Z", "Asia/Kolkata")).toBe("2026-09-21");
    expect(dayKeyIn("2026-09-21T18:30:00Z", "Asia/Kolkata")).toBe("2026-09-22");
    // The same instant is still the 21st in UTC - the bug the dashboard had.
    expect(dayKeyIn("2026-09-21T18:30:00Z", "UTC")).toBe("2026-09-21");
  });

  it("handles quarter-hour offsets", () => {
    // Kathmandu is UTC+05:45.
    expect(dayKeyIn("2026-09-21T18:14:00Z", "Asia/Kathmandu")).toBe("2026-09-21");
    expect(dayKeyIn("2026-09-21T18:15:00Z", "Asia/Kathmandu")).toBe("2026-09-22");
  });

  it("reads today in the workspace's zone, not the machine's", () => {
    const now = "2026-09-21T20:00:00Z";
    expect(todayIn("Asia/Kolkata", now)).toBe("2026-09-22");
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-09-21");
  });

  it("shifts calendar dates without a zone", () => {
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("gives an ISO weekday", () => {
    // 22 Sep 2026 is a Tuesday.
    expect(zonedParts("2026-09-22T06:00:00Z", "Asia/Kolkata")?.weekday).toBe(2);
    expect(zonedParts("2026-09-20T06:00:00Z", "Asia/Kolkata")?.weekday).toBe(7);
    expect(weekdayOfDateKey("2026-09-22")).toBe("Tue");
  });
});

describe("offsets and wall times", () => {
  it("measures offsets, DST included", () => {
    expect(utcOffsetMinutes("Asia/Kolkata", "2026-09-22T00:00:00Z")).toBe(330);
    expect(utcOffsetMinutes("Europe/London", "2026-07-01T00:00:00Z")).toBe(60);
    expect(utcOffsetMinutes("Europe/London", "2026-01-01T00:00:00Z")).toBe(0);
    expect(formatUtcOffset(330)).toBe("UTC+05:30");
    expect(formatUtcOffset(-300)).toBe("UTC-05:00");
    expect(formatUtcOffset(0)).toBe("UTC+00:00");
  });

  it("reads a typed wall time in the workspace zone", () => {
    expect(wallTimeToInstant("2026-09-22T18:00", "Asia/Kolkata")).toBe("2026-09-22T12:30:00.000Z");
    expect(wallTimeToInstant("2026-09-22T18:00", "Asia/Dubai")).toBe("2026-09-22T14:00:00.000Z");
    expect(wallTimeToInstant("garbage", "Asia/Kolkata")).toBeNull();
  });

  it("round-trips a wall time through an instant", () => {
    for (const zone of ["Asia/Kolkata", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      const iso = wallTimeToInstant("2026-11-05T09:15", zone)!;
      expect(instantToWallTime(iso, zone)).toBe("2026-11-05T09:15");
    }
  });

  it("resolves a DST gap to the first real instant and an overlap to a real one", () => {
    // 8 Mar 2026, New York: 02:00-02:59 does not exist.
    const gap = wallTimeToInstant("2026-03-08T02:30", "America/New_York")!;
    expect(instantToWallTime(gap, "America/New_York")).toBe("2026-03-08T03:30");
    // 1 Nov 2026: 01:30 happens twice; either reading is a real 01:30.
    const overlap = wallTimeToInstant("2026-11-01T01:30", "America/New_York")!;
    expect(instantToWallTime(overlap, "America/New_York")).toBe("2026-11-01T01:30");
  });
});

describe("formatting vocabulary (doc 30 R7)", () => {
  const instant = "2026-09-22T09:00:00Z"; // 2:30 pm IST

  it("prints fixed-table words so every machine agrees", () => {
    expect(formatDate(instant, "Asia/Kolkata")).toBe("22 Sep 2026");
    expect(formatDayMonth(instant, "Asia/Kolkata")).toBe("22 Sep");
    expect(formatWeekdayDate(instant, "Asia/Kolkata")).toBe("Tue 22 Sep");
    expect(formatTime(instant, "Asia/Kolkata")).toBe("2:30 pm");
    expect(formatDateTime(instant, "Asia/Kolkata")).toBe("22 Sep 2026, 2:30 pm");
  });

  it("uses the zone, so the same instant is a different day elsewhere", () => {
    expect(formatDateTime("2026-09-21T20:00:00Z", "Asia/Kolkata")).toBe("22 Sep 2026, 1:30 am");
    expect(formatDateTime("2026-09-21T20:00:00Z", "America/Los_Angeles")).toBe("21 Sep 2026, 1:00 pm");
  });

  it("gets noon and midnight right on a 12-hour clock", () => {
    expect(formatTime("2026-09-21T18:30:00Z", "Asia/Kolkata")).toBe("12:00 am");
    expect(formatTime("2026-09-22T06:30:00Z", "Asia/Kolkata")).toBe("12:00 pm");
  });

  it("says relative times the way relativeTime always has, and dates after a month", () => {
    const now = "2026-09-22T12:00:00Z";
    expect(formatRelative("2026-09-22T11:59:40Z", "Asia/Kolkata", now)).toBe("just now");
    expect(formatRelative("2026-09-22T11:55:00Z", "Asia/Kolkata", now)).toBe("5m ago");
    expect(formatRelative("2026-09-22T09:00:00Z", "Asia/Kolkata", now)).toBe("3h ago");
    expect(formatRelative("2026-09-20T12:00:00Z", "Asia/Kolkata", now)).toBe("2d ago");
    expect(formatRelative("2026-09-22T12:05:00Z", "Asia/Kolkata", now)).toBe("in 5m");
    expect(formatRelative("2026-07-01T12:00:00Z", "Asia/Kolkata", now)).toBe("1 Jul 2026");
  });

  it("never shifts a calendar date through a zone", () => {
    expect(formatDateKey("2026-09-22")).toBe("22 Sep 2026");
    expect(formatDateKey("2026-09-22", { year: false })).toBe("22 Sep");
    expect(formatDateKey(null)).toBe("-");
  });

  it("labels an hour band on a 24-hour scale", () => {
    expect(formatHourBand(13)).toBe("13:00–14:00");
    expect(formatHourBand(23)).toBe("23:00–00:00");
  });

  it("prints a dash, not 'Invalid Date', for garbage", () => {
    expect(formatDateTime("nope", "Asia/Kolkata")).toBe("-");
    expect(formatRelative("nope", "Asia/Kolkata")).toBe("-");
  });
});

describe("the picker's catalogue", () => {
  const at = "2026-09-22T00:00:00Z";
  const options = timeZoneOptions(at);

  it("lists current IANA names once each, UTC included", () => {
    const ids = options.map((o) => o.id);
    expect(ids).toContain("Asia/Kolkata");
    expect(ids).not.toContain("Asia/Calcutta");
    expect(ids).toContain("UTC");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is ordered by offset", () => {
    for (let i = 1; i < options.length; i++) {
      expect(options[i]!.offsetMinutes).toBeGreaterThanOrEqual(options[i - 1]!.offsetMinutes);
    }
  });

  it("parses offset queries", () => {
    expect(parseOffsetQuery("+5:30")).toBe(330);
    expect(parseOffsetQuery("UTC+4")).toBe(240);
    expect(parseOffsetQuery("gmt-05")).toBe(-300);
    expect(parseOffsetQuery("+0545")).toBe(345);
    expect(parseOffsetQuery("dubai")).toBeNull();
  });

  it("finds a zone by what people actually type", () => {
    const first = (q: string) => searchTimeZones(options, q)[0]?.id;
    expect(first("india")).toBe("Asia/Kolkata");
    expect(first("IST")).toBe("Asia/Kolkata");
    expect(first("mumbai")).toBe("Asia/Kolkata");
    expect(first("dubai")).toBe("Asia/Dubai");
    expect(first("uae")).toBe("Asia/Dubai");
    expect(first("new york")).toBe("America/New_York");
    expect(searchTimeZones(options, "+5:30").map((o) => o.id)).toContain("Asia/Kolkata");
    expect(searchTimeZones(options, "+5:30").every((o) => o.offsetMinutes === 330)).toBe(true);
    expect(searchTimeZones(options, "zzzz-no-such-place")).toEqual([]);
  });
});
