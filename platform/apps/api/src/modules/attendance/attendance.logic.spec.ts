import { ATTENDANCE_MIN_VERSION_CODE, type ResolvedDay } from "@aura/shared";
import {
  buildAttendanceBlock,
  csvCell,
  handsetNeedsUpdate,
  handsetUnderstandsAttendance,
  MATCHES_NOTHING,
  ownTelecallerOnly,
  rangeDays,
  stableHash31,
  summariseWhatsapp,
  toCsv,
  toDeviceRequestView,
  type RequestRow,
  versionCodeOf,
} from "./attendance.logic";

const day = (over: Partial<ResolvedDay> = {}): ResolvedDay => ({
  date: "2026-10-01",
  kind: "work",
  shiftStart: "2026-10-01T04:00:00.000Z",
  shiftEnd: "2026-10-01T13:00:00.000Z",
  graceMinutes: 10,
  breakAllowanceMinutes: 60,
  silenceThresholdMinutes: 10,
  promptTimeoutMinutes: 3,
  breaks: [],
  ...over,
});

describe("versionCodeOf", () => {
  it("reads the bare versionCode the update poll stores", () => {
    expect(versionCodeOf("10")).toBe(10);
    expect(versionCodeOf(" 9 ")).toBe(9);
  });
  it("treats a versionName or junk as unknown, never mis-parsed", () => {
    expect(versionCodeOf("1.2.0")).toBeNull();
    expect(versionCodeOf("")).toBeNull();
    expect(versionCodeOf(null)).toBeNull();
  });
});

describe("the version gate", () => {
  it("sends the block to an unknown or new-enough handset, not to a known-old one", () => {
    expect(handsetUnderstandsAttendance(null)).toBe(true);
    expect(handsetUnderstandsAttendance(ATTENDANCE_MIN_VERSION_CODE)).toBe(true);
    expect(handsetUnderstandsAttendance(ATTENDANCE_MIN_VERSION_CODE - 1)).toBe(false);
  });
  it("asks for an update only for a phone that exists and is not known to be new enough", () => {
    expect(handsetNeedsUpdate(false, null)).toBe(false);
    expect(handsetNeedsUpdate(true, null)).toBe(true);
    expect(handsetNeedsUpdate(true, 9)).toBe(true);
    expect(handsetNeedsUpdate(true, 10)).toBe(false);
  });
});

describe("buildAttendanceBlock", () => {
  const base = {
    zone: "Asia/Kolkata",
    canApplyLeave: true,
    canBookBreaks: false,
    approverName: null,
    yesterday: day({ date: "2026-09-30", shiftStart: "2026-09-30T04:00:00.000Z", shiftEnd: "2026-09-30T13:00:00.000Z" }),
    today: day(),
    tomorrow: day({ date: "2026-10-02", kind: "off", shiftStart: undefined, shiftEnd: undefined }),
    now: Date.parse("2026-10-01T06:00:00.000Z"),
  };

  it("omits approverName (never null) when requests go to the owners", () => {
    const block = buildAttendanceBlock(base);
    expect("approverName" in block).toBe(false);
    expect(block.days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect("shiftStart" in block.days[1]!).toBe(false);
  });

  it("puts yesterday first while a night shift that started yesterday is still running", () => {
    const night = buildAttendanceBlock({
      ...base,
      yesterday: day({ date: "2026-09-30", shiftStart: "2026-09-30T16:30:00.000Z", shiftEnd: "2026-10-01T00:30:00.000Z" }),
      now: Date.parse("2026-09-30T20:00:00.000Z"),
    });
    expect(night.days.map((d) => d.date)).toEqual(["2026-09-30", "2026-10-01", "2026-10-02"]);
  });

  it("gives a scheduleVersion that is a non-negative int and moves with anything the phone acts on", () => {
    const a = buildAttendanceBlock(base);
    expect(Number.isInteger(a.scheduleVersion)).toBe(true);
    expect(a.scheduleVersion).toBeGreaterThanOrEqual(0);
    expect(a.scheduleVersion).toBeLessThanOrEqual(0x7fffffff);
    expect(buildAttendanceBlock(base).scheduleVersion).toBe(a.scheduleVersion);
    expect(buildAttendanceBlock({ ...base, canBookBreaks: true }).scheduleVersion).not.toBe(a.scheduleVersion);
    expect(buildAttendanceBlock({ ...base, approverName: "Ravi" }).scheduleVersion).not.toBe(a.scheduleVersion);
    expect(
      buildAttendanceBlock({ ...base, today: day({ shiftEnd: "2026-10-01T13:30:00.000Z" }) }).scheduleVersion,
    ).not.toBe(a.scheduleVersion);
  });

  it("hashes stably", () => {
    expect(stableHash31("abc")).toBe(stableHash31("abc"));
    expect(stableHash31("abc")).not.toBe(stableHash31("abd"));
  });
});

describe("toDeviceRequestView", () => {
  const row: RequestRow = {
    id: "r1",
    telecaller_id: "t1",
    telecaller_name: "Priya",
    kind: "leave",
    leave_type: "casual",
    start_date: "2026-10-03",
    end_date: "2026-10-03",
    half_day: null,
    starts_at: null,
    ends_at: null,
    reason: null,
    status: "pending",
    source: "device",
    approver_membership_id: null,
    approver_name: null,
    escalated_at: null,
    created_at: new Date("2026-10-01T05:00:00Z"),
    decided_at: null,
    decided_by_name: null,
    decision_note: null,
  };

  it("omits every absent optional key instead of sending null (Android optString)", () => {
    const view = toDeviceRequestView(row);
    expect(view).toEqual({
      id: "r1",
      kind: "leave",
      status: "pending",
      createdAt: "2026-10-01T05:00:00.000Z",
      leaveType: "casual",
      startDate: "2026-10-03",
      endDate: "2026-10-03",
    });
    expect(Object.values(view)).not.toContain(null);
  });

  it("names the approver only when there is one", () => {
    expect(toDeviceRequestView({ ...row, approver_membership_id: "m1", approver_name: "Ravi" }).approverName).toBe("Ravi");
    expect(toDeviceRequestView({ ...row, approver_membership_id: "m1" }).approverName).toBe("Your manager");
  });
});

describe("summariseWhatsapp", () => {
  it("reports the worst outcome across recipients", () => {
    expect(summariseWhatsapp([])).toBeNull();
    expect(
      summariseWhatsapp([
        { status: "sent", last_error: null },
        { status: "failed", last_error: "no" },
      ]),
    ).toEqual({ status: "failed", lastError: "no" });
    expect(summariseWhatsapp([{ status: "skipped", last_error: "x" }, { status: "queued", last_error: null }])?.status).toBe(
      "queued",
    );
  });
});

describe("CSV", () => {
  it("defuses spreadsheet formulas in user text and quotes where needed", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell('Priya, "P"')).toBe('"Priya, ""P"""');
    expect(csvCell(null)).toBe("");
    expect(csvCell(["late", "break_overrun"])).toBe("late break_overrun");
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe("a,b\r\n1,x\r\n");
  });

  it("counts an inclusive range", () => {
    expect(rangeDays("2026-10-01", "2026-10-01")).toBe(1);
    expect(rangeDays("2026-10-01", "2027-01-01")).toBe(93);
  });
});

describe("ownTelecallerOnly", () => {
  it("narrows an own-scoped persona to their telecaller, or to nothing at all", () => {
    expect(ownTelecallerOnly({ scope: "all", telecallerId: null })).toBeNull();
    expect(ownTelecallerOnly({ scope: "own", telecallerId: "t1" })).toBe("t1");
    expect(ownTelecallerOnly({ scope: "own", telecallerId: null })).toBe(MATCHES_NOTHING);
  });
});
