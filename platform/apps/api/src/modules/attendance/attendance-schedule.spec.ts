import type { PatternRecord } from "@aura/shared";
import { datesBetween, scheduleBookFrom, workDayAt } from "./attendance-schedule";

const pattern = (over: Partial<PatternRecord> = {}): PatternRecord => ({
  id: "p-day",
  name: "Day",
  workDays: [1, 2, 3, 4, 5],
  startTime: "09:30",
  endTime: "18:30",
  graceMinutes: 10,
  breakAllowanceMinutes: 60,
  silenceThresholdMinutes: 10,
  promptTimeoutMinutes: 3,
  breaks: [{ label: "Lunch", startTime: "13:00", durationMinutes: 45 }],
  ...over,
});

const ZONE = "Asia/Kolkata";

describe("scheduleBookFrom", () => {
  it("uses the latest assignment on or before the date, and a NULL assignment unassigns", () => {
    const book = scheduleBookFrom(
      {
        assignments: [
          { telecallerId: "t1", from: "2026-09-01", patternId: "p-day" },
          { telecallerId: "t1", from: "2026-10-05", patternId: null },
        ],
        patterns: [pattern()],
        exceptions: [],
        requests: [],
      },
      ZONE,
    );
    // 2026-10-01 is a Thursday.
    expect(book.resolve("t1", "2026-10-01").kind).toBe("work");
    expect(book.resolve("t1", "2026-10-01").shiftStart).toBe("2026-10-01T04:00:00.000Z");
    expect(book.patternOn("t1", "2026-10-05")).toBeNull();
    expect(book.resolve("t1", "2026-10-05").kind).toBe("off");
    expect(book.resolve("t2", "2026-10-01").kind).toBe("off");
  });

  it("applies a workspace holiday to everyone and a personal exception only to its person", () => {
    const book = scheduleBookFrom(
      {
        assignments: [
          { telecallerId: "t1", from: "2026-09-01", patternId: "p-day" },
          { telecallerId: "t2", from: "2026-09-01", patternId: "p-day" },
        ],
        patterns: [pattern()],
        exceptions: [
          { telecallerId: null, onDate: "2026-10-02", kind: "holiday", label: "Gandhi Jayanti" },
          { telecallerId: "t2", onDate: "2026-10-01", kind: "day_off", label: null },
        ],
        requests: [],
      },
      ZONE,
    );
    expect(book.resolve("t1", "2026-10-02").kind).toBe("holiday");
    expect(book.resolve("t1", "2026-10-01").kind).toBe("work");
    expect(book.resolve("t2", "2026-10-01").kind).toBe("off");
  });

  it("applies approved leave unless asked to resolve without requests", () => {
    const book = scheduleBookFrom(
      {
        assignments: [{ telecallerId: "t1", from: "2026-09-01", patternId: "p-day" }],
        patterns: [pattern()],
        exceptions: [],
        requests: [
          {
            id: "r1",
            telecallerId: "t1",
            kind: "leave",
            status: "approved",
            leaveType: "sick",
            startDate: "2026-10-01",
            endDate: "2026-10-01",
          },
        ],
      },
      ZONE,
    );
    expect(book.resolve("t1", "2026-10-01").kind).toBe("leave");
    expect(book.resolve("t1", "2026-10-01", { withoutRequests: true }).kind).toBe("work");
  });
});

describe("workDayAt", () => {
  it("files 01:00 inside a 22:00-06:00 shift under the day the shift started", () => {
    const book = scheduleBookFrom(
      {
        assignments: [{ telecallerId: "t1", from: "2026-09-01", patternId: "p-night" }],
        patterns: [pattern({ id: "p-night", startTime: "22:00", endTime: "06:00", workDays: [1, 2, 3, 4, 5, 6, 7], breaks: [] })],
        exceptions: [],
        requests: [],
      },
      ZONE,
    );
    // 01:00 IST on 2 Oct = 19:30 UTC on 1 Oct.
    const at = Date.parse("2026-10-01T19:30:00.000Z");
    expect(workDayAt(book, "t1", at, "2026-10-02").date).toBe("2026-10-01");
    // 12:00 IST on 2 Oct is outside every shift - the calendar date.
    expect(workDayAt(book, "t1", Date.parse("2026-10-02T06:30:00.000Z"), "2026-10-02").date).toBe("2026-10-02");
  });

  it("lists an inclusive date range", () => {
    expect(datesBetween("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  });
});
