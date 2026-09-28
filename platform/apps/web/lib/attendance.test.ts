import { describe, expect, it } from "vitest";
import { ShiftPatternInput } from "@aura/shared";
import {
  attendanceTabsFor,
  barGeometry,
  describeEvidence,
  describeWorkDays,
  hmm,
  isNightShift,
  issuesByField,
  liveStateLabel,
  liveStateTone,
  requestQuery,
  resolveAttendanceTab,
  segmentTone,
  timelineWindow,
} from "./attendance";

describe("hmm", () => {
  it("prints h:mm and never pretends an unmeasured duration was zero", () => {
    expect(hmm(0)).toBe("0:00");
    expect(hmm(2400)).toBe("0:40");
    expect(hmm(7 * 3600 + 5 * 60)).toBe("7:05");
    expect(hmm(null)).toBe("-");
    expect(hmm(undefined)).toBe("-");
  });
});

describe("tabs", () => {
  it("keeps Review from a telecaller - deciding somebody else's time is the manager's", () => {
    expect(attendanceTabsFor("telecaller").map((t) => t.key)).toEqual(["today", "timesheets", "requests"]);
    expect(attendanceTabsFor("manager").map((t) => t.key)).toContain("review");
  });

  it("falls back to Today for anything unknown or not offered", () => {
    expect(resolveAttendanceTab(undefined, "owner")).toBe("today");
    expect(resolveAttendanceTab("nonsense", "owner")).toBe("today");
    expect(resolveAttendanceTab("review", "telecaller")).toBe("today");
    expect(resolveAttendanceTab(["requests"], "owner")).toBe("requests");
  });

  it("asks the API for exactly what each request chip names", () => {
    expect(requestQuery("mine")).toBe("status=pending&mine=1");
    expect(requestQuery("escalated")).toBe("status=pending&escalated=1");
    expect(requestQuery("decided")).toBe("status=decided");
    expect(requestQuery("pending")).toBe("status=pending");
    expect(requestQuery("all")).toBe("status=all");
  });
});

describe("colour", () => {
  it("spends red only on a person not being there, and orange on the phone failing", () => {
    expect(liveStateTone("AWAY")).toBe("missed");
    expect(liveStateTone("TECHNICAL")).toBe("error");
    expect(liveStateTone("OFFLINE")).toBe("error");
    expect(liveStateTone("IN_CALL")).toBe("answered");
    for (const neutral of ["ACTIVE", "ON_BREAK", "OFF_SHIFT", "ON_LEAVE", "NOT_STARTED", "NO_HANDSET"]) {
      expect([neutral, liveStateTone(neutral)]).toEqual([neutral, "neutral"]);
    }
    expect(segmentTone("absent")).toBe("missed");
    expect(segmentTone("technical")).toBe("error");
    expect(segmentTone("break")).toBe("neutral");
  });

  it("labels a state this console does not know as itself rather than blank", () => {
    expect(liveStateLabel("ON_BREAK")).toBe("On break");
    expect(liveStateLabel("FROM_THE_FUTURE")).toBe("FROM_THE_FUTURE");
  });
});

describe("shift helpers", () => {
  it("calls a shift that ends at or before its start a night shift", () => {
    expect(isNightShift("22:00", "06:00")).toBe(true);
    expect(isNightShift("09:30:00", "18:30:00")).toBe(false);
  });

  it("names the usual week plainly", () => {
    expect(describeWorkDays([1, 2, 3, 4, 5])).toBe("Mon-Fri");
    expect(describeWorkDays([1, 2, 3, 4, 5, 6, 7])).toBe("Every day");
    expect(describeWorkDays([1, 3, 5])).toBe("Mon, Wed, Fri");
  });

  it("puts the shared schema's messages on the field they are about", () => {
    const result = ShiftPatternInput.safeParse({
      name: "Day",
      workDays: [1],
      startTime: "09:00",
      endTime: "18:00",
      graceMinutes: 10,
      breakAllowanceMinutes: 30,
      silenceThresholdMinutes: 10,
      promptTimeoutMinutes: 3,
      breaks: [{ label: "Lunch", startTime: "13:00", durationMinutes: 60 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(issuesByField(result.error.issues).breaks).toMatch(/allowance/);
    }
  });
});

describe("evidence", () => {
  it("reads the classifier's evidence as sentences", () => {
    expect(describeEvidence({ reason: "no_signal", corroboration: "network_lost" })).toEqual([
      "Reported: no signal",
      "Backed up: the phone lost its network at the time",
    ]);
    expect(describeEvidence({ cameBackWith: "boot", lastBefore: "heartbeat" })).toEqual([
      "Came back when the phone restarted",
      "Last thing recorded before: heartbeat",
    ]);
    expect(describeEvidence({ ongoing: false })).toEqual([]);
    expect(describeEvidence(null)).toEqual([]);
  });

  it("shows an unknown key rather than dropping it", () => {
    expect(describeEvidence({ someNewThing: 3 })).toEqual(["some New Thing: 3"]);
  });
});

describe("timeline geometry", () => {
  const start = Date.parse("2026-09-25T04:00:00Z");
  const end = Date.parse("2026-09-25T12:00:00Z");

  it("places a stretch as percentages of the window, clamped to it", () => {
    expect(barGeometry("2026-09-25T04:00:00Z", "2026-09-25T08:00:00Z", start, end)).toEqual({ left: 0, width: 50 });
    expect(barGeometry("2026-09-25T02:00:00Z", "2026-09-25T06:00:00Z", start, end)).toEqual({ left: 0, width: 25 });
    expect(barGeometry("2026-09-25T13:00:00Z", "2026-09-25T14:00:00Z", start, end)).toBeNull();
  });

  it("widens the shift to take in stretches outside it", () => {
    const w = timelineWindow("2026-09-25T04:00:00Z", "2026-09-25T12:00:00Z", [
      { startsAt: "2026-09-25T12:00:00Z", endsAt: "2026-09-25T13:00:00Z" },
    ]);
    expect(w).toEqual({ start, end: Date.parse("2026-09-25T13:00:00Z") });
    expect(timelineWindow(null, null, [])).toBeNull();
  });
});
