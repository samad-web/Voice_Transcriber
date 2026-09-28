import { describe, expect, it } from "vitest";
import {
  AttendanceRequestInput,
  ExceptionInput,
  RequestDecisionInput,
  ShiftPatternInput,
  attendanceAlertText,
  canAutoApproveBreak,
  canDecideRequest,
  classifyAttendanceDay,
  escalationDueAt,
  liveBoardState,
  normalisePresenceBatch,
  resolveApprover,
  resolveAttendanceDay,
  suggestSilenceThreshold,
  type ClassifierEvent,
  type PatternRecord,
  type ResolvedDay,
} from "./attendance";
import { wallTimeToInstant } from "./time";

const ZONE = "Asia/Kolkata";
const DATE = "2026-09-28"; // a Monday

const at = (hhmm: string, date = DATE) => wallTimeToInstant(`${date}T${hhmm}`, ZONE)!;
const ms = (hhmm: string, date = DATE) => Date.parse(at(hhmm, date));
const min = (n: number) => n * 60_000;

const PATTERN: PatternRecord = {
  id: "p1",
  name: "Day",
  workDays: [1, 2, 3, 4, 5, 6],
  startTime: "09:30",
  endTime: "18:30",
  graceMinutes: 10,
  breakAllowanceMinutes: 60,
  silenceThresholdMinutes: 10,
  promptTimeoutMinutes: 3,
  breaks: [{ label: "Lunch", startTime: "13:00", durationMinutes: 45 }],
};

function day(overrides: Partial<Parameters<typeof resolveAttendanceDay>[0]> = {}): ResolvedDay {
  return resolveAttendanceDay({ date: DATE, zone: ZONE, pattern: PATTERN, exceptions: [], requests: [], ...overrides });
}

function ev(kind: ClassifierEvent["kind"], hhmm: string, payload?: Record<string, unknown>): ClassifierEvent {
  return { kind, at: at(hhmm), payload };
}

function state(hhmm: string, s: string, extra?: Record<string, unknown>): ClassifierEvent {
  return ev("state", hhmm, { state: s, ...extra });
}

/** Heartbeats every 2 minutes, inclusive - what a live phone produces. */
function beats(from: string, to: string, payload?: Record<string, unknown>): ClassifierEvent[] {
  const out: ClassifierEvent[] = [];
  for (let t = ms(from); t <= ms(to); t += min(2)) {
    out.push({ kind: "heartbeat", at: new Date(t).toISOString(), payload });
  }
  return out;
}

function classify(events: ClassifierEvent[], opts: { now?: number; day?: ResolvedDay } & Record<string, unknown> = {}) {
  return classifyAttendanceDay({
    day: opts.day ?? day(),
    events,
    now: opts.now ?? ms("20:00"),
    ...(opts as object),
  });
}

const secondsOf = (a: string, b: string) => (ms(b) - ms(a)) / 1000;

// ── Schedule resolution ─────────────────────────────────────────────────────

describe("resolveAttendanceDay", () => {
  it("turns a pattern into instants in the workspace zone", () => {
    const d = day();
    expect(d.kind).toBe("work");
    expect(d.shiftStart).toBe("2026-09-28T04:00:00.000Z");
    expect(d.shiftEnd).toBe("2026-09-28T13:00:00.000Z");
    expect(d.breaks).toEqual([
      { label: "Lunch", startsAt: "2026-09-28T07:30:00.000Z", endsAt: "2026-09-28T08:15:00.000Z", source: "slot" },
    ]);
  });

  it("is a day off on a weekday outside the pattern", () => {
    expect(resolveAttendanceDay({ date: "2026-09-27", zone: ZONE, pattern: PATTERN, exceptions: [], requests: [] }).kind).toBe("off");
  });

  it("is off with no pattern at all", () => {
    expect(day({ pattern: null }).kind).toBe("off");
  });

  it("puts a workspace holiday over the pattern", () => {
    const d = day({ exceptions: [{ telecallerId: null, onDate: DATE, kind: "holiday", label: "Navratri" }] });
    expect(d).toMatchObject({ kind: "holiday", label: "Navratri" });
  });

  it("lets a personal custom-hours exception beat a holiday, and drops the fixed slots", () => {
    const d = day({
      exceptions: [
        { telecallerId: null, onDate: DATE, kind: "holiday" },
        { telecallerId: "t1", onDate: DATE, kind: "custom_hours", startTime: "10:00", endTime: "14:00" },
      ],
    });
    expect(d.kind).toBe("work");
    expect(d.shiftStart).toBe(at("10:00"));
    expect(d.breaks).toEqual([]);
  });

  it("gives approved full leave precedence over everything", () => {
    const d = day({
      requests: [{ id: "r", kind: "leave", status: "approved", leaveType: "sick", startDate: DATE, endDate: DATE }],
    });
    expect(d).toMatchObject({ kind: "leave", label: "Sick" });
  });

  it("ignores leave that is still pending or was rejected", () => {
    for (const status of ["pending", "rejected", "cancelled"] as const) {
      const d = day({ requests: [{ id: "r", kind: "leave", status, leaveType: "casual", startDate: DATE, endDate: DATE }] });
      expect(d.kind).toBe("work");
    }
  });

  it("keeps the shift on a half day and marks which half", () => {
    const d = day({
      requests: [{ id: "r", kind: "leave", status: "approved", leaveType: "casual", startDate: DATE, endDate: DATE, halfDay: "pm" }],
    });
    expect(d).toMatchObject({ kind: "work", halfDay: "pm" });
  });

  it("runs a night shift over midnight and files it under the day it starts", () => {
    const night: PatternRecord = { ...PATTERN, startTime: "22:00", endTime: "06:00", breaks: [{ label: "Tea", startTime: "02:00", durationMinutes: 15 }] };
    const d = day({ pattern: night });
    expect(d.shiftStart).toBe(at("22:00"));
    expect(d.shiftEnd).toBe(at("06:00", "2026-09-29"));
    expect(d.breaks[0]!.startsAt).toBe(at("02:00", "2026-09-29"));
  });

  it("adds an approved break booking to the fixed slots, in order", () => {
    const d = day({ requests: [{ id: "b", kind: "break", status: "auto_approved", startsAt: at("11:00"), endsAt: at("11:10") }] });
    expect(d.breaks.map((b) => b.source)).toEqual(["booked", "slot"]);
  });

  it("uses an approved hours change as the window", () => {
    const d = day({ requests: [{ id: "h", kind: "hours_change", status: "approved", startsAt: at("12:00"), endsAt: at("20:00") }] });
    expect(d.shiftStart).toBe(at("12:00"));
    expect(d.shiftEnd).toBe(at("20:00"));
  });

  it("is DST-correct in a zone that changes clocks", () => {
    // 2026-11-01 is the US fall-back Sunday; the pattern runs every day.
    const everyDay = { ...PATTERN, workDays: [1, 2, 3, 4, 5, 6, 7], breaks: [] };
    const before = resolveAttendanceDay({ date: "2026-10-31", zone: "America/New_York", pattern: everyDay, exceptions: [], requests: [] });
    const after = resolveAttendanceDay({ date: "2026-11-01", zone: "America/New_York", pattern: everyDay, exceptions: [], requests: [] });
    expect(before.shiftStart).toBe("2026-10-31T13:30:00.000Z");
    expect(after.shiftStart).toBe("2026-11-01T14:30:00.000Z");
  });
});

// ── The classifier ──────────────────────────────────────────────────────────

describe("classifyAttendanceDay", () => {
  const normalDay = (): ClassifierEvent[] => [
    ev("shift_start", "09:28"),
    state("09:28", "ACTIVE"),
    ...beats("09:30", "18:30"),
    state("13:00", "ON_BREAK"),
    state("13:45", "ACTIVE"),
    state("18:30", "OFF_SHIFT"),
  ];

  it("files an ordinary day as present with worked time and the lunch break", () => {
    const out = classify(normalDay());
    expect(out.status).toBe("present");
    expect(out.checkInAt).toBe(at("09:30"));
    expect(out.breakSeconds).toBe(45 * 60);
    expect(out.workedSeconds).toBe(secondsOf("09:30", "18:30") - 45 * 60);
    expect(out.reviewCount).toBe(0);
    expect(out.flags).toEqual([]);
  });

  it("is upcoming before the shift, and before the grace runs out", () => {
    expect(classify([], { now: ms("09:00") }).status).toBe("upcoming");
    expect(classify([], { now: ms("09:35") }).status).toBe("upcoming");
  });

  it("is late (not started) once the grace has gone with no check-in, and absent after the shift (rule 12)", () => {
    const midday = classify([], { now: ms("11:00") });
    expect(midday.status).toBe("late");
    expect(midday.flags).toContain("not_started");
    const after = classify([], { now: ms("20:00") });
    expect(after.status).toBe("absent");
    expect(after.segments).toEqual([
      expect.objectContaining({ class: "absent", rule: 12, needsReview: false }),
    ]);
  });

  it("marks a check-in past the grace as late, with the minutes", () => {
    const events = [ev("shift_start", "10:05"), state("10:05", "ACTIVE"), ...beats("10:05", "18:30")];
    const out = classify(events);
    expect(out.status).toBe("late");
    expect(out.lateSeconds).toBe(35 * 60);
    expect(out.segments[0]).toMatchObject({ class: "not_started", startsAt: at("09:30"), endsAt: at("10:05") });
  });

  it("counts a first call as the check-in when nobody tapped Start shift", () => {
    const events = [ev("call_start", "09:32"), state("09:32", "IN_CALL"), ...beats("09:32", "18:30")];
    expect(classify(events).checkInAt).toBe(at("09:32"));
  });

  it("keeps time the phone worked through without network as working, and flags the outage (rule 3/4)", () => {
    const events = [
      ...normalDay(),
      ev("network_lost", "11:00"),
      ev("network_restored", "11:40"),
    ].map((e) =>
      Date.parse(e.at) >= ms("11:00") && Date.parse(e.at) <= ms("11:40")
        ? { ...e, receivedAt: at("11:41") }
        : e,
    );
    const out = classify(events);
    expect(out.flags).toContain("network_outage");
    expect(out.technicalSeconds).toBe(0);
    expect(out.workedSeconds).toBe(secondsOf("09:30", "18:30") - 45 * 60);
  });

  it("calls a silent stretch that ended in a boot after low battery a power problem, no review (rule 5)", () => {
    const events = [
      ev("shift_start", "09:30"),
      state("09:30", "ACTIVE"),
      ...beats("09:30", "11:00", { batteryPct: 2 }),
      ev("boot", "11:30"),
      ev("service_start", "11:31"),
      ...beats("11:32", "18:30"),
    ];
    const seg = classify(events).segments.find((s) => s.rule === 5);
    expect(seg).toMatchObject({ class: "technical", needsReview: false });
  });

  it("sends a restart with no power evidence to review (rule 8)", () => {
    const events = [
      ev("shift_start", "09:30"),
      state("09:30", "ACTIVE"),
      ...beats("09:30", "11:00", { batteryPct: 80 }),
      ev("app_start", "11:30"),
      ...beats("11:32", "18:30"),
    ];
    const out = classify(events);
    expect(out.segments.find((s) => s.rule === 8)).toMatchObject({ class: "technical", needsReview: true });
    expect(out.reviewCount).toBe(1);
  });

  it("sends an unexplained silence that ended without a restart to review as unknown (rule 11)", () => {
    const events = [ev("shift_start", "09:30"), state("09:30", "ACTIVE"), ...beats("09:30", "11:00"), ...beats("12:00", "18:30")];
    expect(classify(events).segments.find((s) => s.rule === 11)).toMatchObject({ class: "unknown", needsReview: true });
  });

  it("does not ask for review of a silence that is still going on", () => {
    const events = [ev("shift_start", "09:30"), state("09:30", "ACTIVE"), ...beats("09:30", "11:00")];
    const seg = classify(events, { now: ms("11:30") }).segments.find((s) => s.rule === 11);
    expect(seg).toMatchObject({ class: "unknown", needsReview: false });
  });

  it("starts away time when an unanswered prompt appeared, not when it expired (rule 10)", () => {
    const events = [
      ev("shift_start", "09:30"),
      state("09:30", "ACTIVE"),
      ...beats("09:30", "18:30"),
      state("11:00", "PROMPTING"),
      ev("prompt_shown", "11:00"),
      ev("prompt_expired", "11:03"),
      state("11:03", "AWAY"),
      state("11:30", "ACTIVE"),
    ];
    const out = classify(events);
    const away = out.segments.find((s) => s.class === "away")!;
    expect(away).toMatchObject({ startsAt: at("11:00"), endsAt: at("11:30"), rule: 10, needsReview: false });
    expect(out.awaySeconds).toBe(30 * 60);
  });

  it("excuses a reported problem the phone's record backs up (rule 6), and reviews one it does not (rule 7)", () => {
    const base = [ev("shift_start", "09:30"), state("09:30", "ACTIVE"), ...beats("09:30", "18:30")];
    const reported = [
      state("11:00", "PROMPTING"),
      ev("prompt_answered", "11:01", { answer: "technical", reason: "no_signal" }),
      state("11:01", "TECHNICAL"),
      state("11:20", "ACTIVE"),
    ];
    const backed = classify([...base, ...reported, ev("network_lost", "10:55"), ev("network_restored", "11:15")]);
    expect(backed.segments.find((s) => s.class === "technical")).toMatchObject({
      rule: 6,
      needsReview: false,
      evidence: expect.objectContaining({ corroboration: "network_lost" }),
    });
    const bare = classify([...base, ...reported]);
    expect(bare.segments.find((s) => s.class === "technical")).toMatchObject({ rule: 7, needsReview: true });
  });

  it("accepts failed calls and dead air in a recording as corroboration", () => {
    const base = [ev("shift_start", "09:30"), state("09:30", "ACTIVE"), ...beats("09:30", "18:30"), state("11:01", "TECHNICAL"), state("11:20", "ACTIVE")];
    const failing = classify([...base, ev("call_end", "11:02", { durationS: 2 }), ev("call_end", "11:05", { durationS: 3 })]);
    expect(failing.segments.find((s) => s.class === "technical")!.rule).toBe(6);
    const deadAir = classify(base, {
      callQuality: [{ startedAt: at("11:05"), endedAt: at("11:10"), zeroSignal: true, longestDeadAirSeconds: 0 }],
    } as never);
    expect(deadAir.segments.find((s) => s.class === "technical")!.rule).toBe(6);
  });

  it("keeps a lunch that started late because of a call at its full length, and records the deferral", () => {
    const events = [
      ev("shift_start", "09:30"),
      state("09:30", "ACTIVE"),
      ...beats("09:30", "18:30"),
      state("13:00", "IN_CALL"),
      state("13:12", "ON_BREAK"),
      state("13:57", "ACTIVE"),
    ];
    const out = classify(events);
    const lunch = out.segments.find((s) => s.class === "break")!;
    expect(lunch).toMatchObject({ startsAt: at("13:12"), endsAt: at("13:57"), rule: 2 });
    expect(lunch.evidence).toMatchObject({ slot: "Lunch", deferredSeconds: 12 * 60 });
    expect(out.flags).not.toContain("break_overrun");
  });

  it("splits a break that ran long into break and overrun", () => {
    const events = [ev("shift_start", "09:30"), state("09:30", "ACTIVE"), ...beats("09:30", "18:30"), state("13:00", "ON_BREAK"), state("14:05", "ACTIVE")];
    const out = classify(events);
    expect(out.flags).toContain("break_overrun");
    expect(out.segments.find((s) => s.class === "break_overrun")).toMatchObject({ startsAt: at("13:47"), endsAt: at("14:05") });
  });

  it("spends the flexible allowance on an ad-hoc break, then files the rest as unscheduled for review (rule 9)", () => {
    // Allowance 60, lunch 45 => 15 flexible minutes.
    const base = [ev("shift_start", "09:30"), state("09:30", "ACTIVE"), ...beats("09:30", "18:30"), state("13:00", "ON_BREAK"), state("13:45", "ACTIVE")];
    const small = classify([...base, state("16:00", "ON_BREAK"), state("16:10", "ACTIVE")]);
    expect(small.flags).not.toContain("unscheduled_break");
    const big = classify([...base, state("16:00", "ON_BREAK"), state("16:30", "ACTIVE")]);
    expect(big.segments.find((s) => s.class === "unscheduled_break")).toMatchObject({
      startsAt: at("16:15"),
      endsAt: at("16:30"),
      rule: 9,
      needsReview: true,
    });
  });

  it("files the leave half of a half day as leave, and the day as half_day", () => {
    const d = day({ requests: [{ id: "r", kind: "leave", status: "approved", leaveType: "casual", startDate: DATE, endDate: DATE, halfDay: "am" }] });
    const events = [ev("shift_start", "14:00"), state("14:00", "ACTIVE"), ...beats("14:00", "18:30")];
    const out = classify(events, { day: d });
    expect(out.status).toBe("half_day");
    expect(out.segments[0]).toMatchObject({ class: "leave", rule: 1, startsAt: at("09:30"), endsAt: at("14:00") });
    expect(out.flags).not.toContain("late");
  });

  it("files a full leave day as on_leave, with nothing to review", () => {
    const d = day({ requests: [{ id: "r", kind: "leave", status: "approved", leaveType: "sick", startDate: DATE, endDate: DATE }] });
    expect(classify([], { day: d })).toMatchObject({ status: "on_leave", reviewCount: 0 });
  });

  it("applies a manager's override and takes excused away time out of the away total", () => {
    const events = [
      ev("shift_start", "09:30"),
      state("09:30", "ACTIVE"),
      ...beats("09:30", "18:30"),
      state("11:00", "PROMPTING"),
      state("11:03", "AWAY"),
      state("11:30", "ACTIVE"),
    ];
    const out = classify(events, {
      overrides: [{ id: "o1", startsAt: at("11:00"), endsAt: at("11:30"), overrideClass: "excused" }],
    } as never);
    expect(out.segments.find((s) => s.class === "away")).toMatchObject({ overrideClass: "excused", overrideId: "o1" });
    expect(out.awaySeconds).toBe(0);
  });

  it("flags three 'I'm here' answers in a row with no call between them", () => {
    const events = [
      ...normalDay(),
      ev("prompt_answered", "10:00", { answer: "here" }),
      ev("prompt_answered", "10:15", { answer: "here" }),
      ev("prompt_answered", "10:30", { answer: "here" }),
    ];
    expect(classify(events).flags).toContain("responding_not_dialing");
    const withCall = [...events, ev("call_start", "10:20")];
    expect(classify(withCall).flags).not.toContain("responding_not_dialing");
  });

  it("counts calls after the shift as overtime", () => {
    const events = [...normalDay(), ev("call_start", "18:40"), ev("call_end", "18:52", { durationS: 720 })];
    expect(classify(events).overtimeSeconds).toBe(720);
  });

  it("flags ending the shift early and counts the rest as away", () => {
    const events = [ev("shift_start", "09:30"), state("09:30", "ACTIVE"), ...beats("09:30", "16:00"), ev("shift_end", "16:00"), state("16:00", "OFF_SHIFT")];
    const out = classify(events);
    expect(out.flags).toContain("early_leave");
    expect(out.segments.at(-1)).toMatchObject({ class: "away", startsAt: at("16:00"), endsAt: at("18:30") });
  });

  it("records calls on a day off as overtime without calling the day anything but off", () => {
    const sunday = resolveAttendanceDay({ date: "2026-09-27", zone: ZONE, pattern: PATTERN, exceptions: [], requests: [] });
    const out = classify([{ kind: "call_end", at: at("11:00", "2026-09-27"), payload: { durationS: 300 } }], { day: sunday });
    expect(out).toMatchObject({ status: "off", overtimeSeconds: 300, flags: ["worked_on_day_off"] });
  });

  it("is deterministic regardless of event order", () => {
    const events = normalDay();
    expect(classify([...events].reverse())).toEqual(classify(events));
  });
});

// ── Clock trust ─────────────────────────────────────────────────────────────

describe("normalisePresenceBatch", () => {
  it("places same-boot events by the monotonic clock, whatever the phone's wall clock says", () => {
    const received = Date.parse("2026-09-28T06:00:00Z");
    const { events, skewSeconds } = normalisePresenceBatch(
      {
        // The phone thinks it is an hour later than it is.
        sentAt: "2026-09-28T07:00:00Z",
        sentBootId: "7",
        sentMonoMs: 1_000_000,
        events: [{ kind: "heartbeat", at: "2026-09-28T06:58:00Z", bootId: "7", monoMs: 880_000 }],
      },
      received,
    );
    expect(skewSeconds).toBe(3600);
    expect(events[0]!.occurredAt).toBe("2026-09-28T05:58:00.000Z");
  });

  it("corrects earlier-boot events by the skew, and never places anything in the future", () => {
    const received = Date.parse("2026-09-28T06:00:00Z");
    const { events } = normalisePresenceBatch(
      {
        sentAt: "2026-09-28T06:10:00Z",
        sentBootId: "8",
        sentMonoMs: 5_000,
        events: [
          { kind: "boot", at: "2026-09-28T05:40:00Z", bootId: "7", monoMs: 9_000_000 },
          { kind: "heartbeat", at: "2026-09-28T09:00:00Z", bootId: "7", monoMs: 9_100_000 },
        ],
      },
      received,
    );
    expect(events[0]!.occurredAt).toBe("2026-09-28T05:30:00.000Z");
    expect(events[1]!.occurredAt).toBe("2026-09-28T06:00:00.000Z");
  });
});

// ── Routing and deciding ────────────────────────────────────────────────────

describe("approver routing", () => {
  it("routes to an active owner or manager, and to the owners otherwise", () => {
    expect(resolveApprover({ membershipId: "m", ownerRole: "manager", status: "active" })).toBe("m");
    expect(resolveApprover({ membershipId: "m", ownerRole: "owner", status: "active" })).toBe("m");
    expect(resolveApprover({ membershipId: "m", ownerRole: "manager", status: "suspended" })).toBeNull();
    expect(resolveApprover({ membershipId: "m", ownerRole: "telecaller", status: "active" })).toBeNull();
    expect(resolveApprover(null)).toBeNull();
  });

  it("lets the approver or any owner decide, never another manager, never the requester", () => {
    const request = { approverMembershipId: "mgr", telecallerId: "t1" };
    expect(canDecideRequest(request, { membershipId: "mgr", ownerRole: "manager", telecallerIds: [] })).toBe(true);
    expect(canDecideRequest(request, { membershipId: "own", ownerRole: "owner", telecallerIds: [] })).toBe(true);
    expect(canDecideRequest(request, { membershipId: "other", ownerRole: "manager", telecallerIds: [] })).toBe(false);
    expect(canDecideRequest(request, { membershipId: "own", ownerRole: "owner", telecallerIds: ["t1"] })).toBe(false);
    expect(canDecideRequest({ approverMembershipId: null, telecallerId: "t1" }, { membershipId: "mgr", ownerRole: "manager", telecallerIds: [] })).toBe(false);
  });

  it("escalates after the window, or two hours before the leave starts, whichever is first", () => {
    const createdAt = "2026-09-28T04:00:00.000Z";
    expect(escalationDueAt({ createdAt, approverMembershipId: "m", escalationHours: 24, startsAt: null })).toBe("2026-09-29T04:00:00.000Z");
    expect(escalationDueAt({ createdAt, approverMembershipId: "m", escalationHours: 24, startsAt: "2026-09-28T10:00:00.000Z" })).toBe("2026-09-28T08:00:00.000Z");
    // Leave starting within the floor escalates at once, never in the past.
    expect(escalationDueAt({ createdAt, approverMembershipId: "m", escalationHours: 24, startsAt: "2026-09-28T05:00:00.000Z" })).toBe(createdAt);
    expect(escalationDueAt({ createdAt, approverMembershipId: null, escalationHours: 24, startsAt: null })).toBeNull();
  });
});

describe("canAutoApproveBreak", () => {
  it("approves inside the allowance and refuses the rest with a reason", () => {
    const d = day();
    expect(canAutoApproveBreak(d, at("11:00"), at("11:15"))).toEqual({ ok: true });
    expect(canAutoApproveBreak(d, at("11:00"), at("11:20"))).toEqual({ ok: false, reason: "over_allowance" });
    expect(canAutoApproveBreak(d, at("13:30"), at("13:40"))).toEqual({ ok: false, reason: "overlaps" });
    expect(canAutoApproveBreak(d, at("08:00"), at("08:10"))).toEqual({ ok: false, reason: "outside_shift" });
    expect(canAutoApproveBreak(day({ pattern: null }), at("11:00"), at("11:10"))).toEqual({ ok: false, reason: "no_shift" });
  });
});

describe("liveBoardState", () => {
  const d = day();
  it("shows OFFLINE for a silent phone inside the shift, and the phone's state otherwise", () => {
    const live = { state: "ACTIVE" as const, lastReceivedAt: at("10:00") };
    expect(liveBoardState({ day: d, live, hasHandset: true, now: ms("10:03") })).toBe("ACTIVE");
    expect(liveBoardState({ day: d, live, hasHandset: true, now: ms("10:10") })).toBe("OFFLINE");
    expect(liveBoardState({ day: d, live: null, hasHandset: true, now: ms("10:10") })).toBe("NOT_STARTED");
    expect(liveBoardState({ day: d, live: null, hasHandset: false, now: ms("10:10") })).toBe("NO_HANDSET");
  });
});

// ── Schemas ─────────────────────────────────────────────────────────────────

describe("schemas", () => {
  const pattern = {
    name: "Day",
    workDays: [5, 1, 1],
    startTime: "09:30",
    endTime: "18:30",
    graceMinutes: 10,
    breakAllowanceMinutes: 60,
    silenceThresholdMinutes: 10,
    promptTimeoutMinutes: 3,
    breaks: [{ label: "Lunch", startTime: "13:00", durationMinutes: 45 }],
  };

  it("normalises work days and accepts a sane pattern", () => {
    const parsed = ShiftPatternInput.parse(pattern);
    expect(parsed.workDays).toEqual([1, 5]);
  });

  it("refuses breaks outside the shift or beyond the allowance", () => {
    expect(ShiftPatternInput.safeParse({ ...pattern, breaks: [{ label: "x", startTime: "19:00", durationMinutes: 15 }] }).success).toBe(false);
    expect(ShiftPatternInput.safeParse({ ...pattern, breakAllowanceMinutes: 30 }).success).toBe(false);
  });

  it("accepts a break after midnight on a night shift", () => {
    expect(
      ShiftPatternInput.safeParse({ ...pattern, startTime: "22:00", endTime: "06:00", breaks: [{ label: "Tea", startTime: "02:00", durationMinutes: 15 }] }).success,
    ).toBe(true);
  });

  it("keeps holidays workspace-wide and custom hours personal", () => {
    expect(ExceptionInput.safeParse({ telecallerId: null, onDate: DATE, kind: "holiday" }).success).toBe(true);
    expect(ExceptionInput.safeParse({ telecallerId: "00000000-0000-4000-8000-000000000001", onDate: DATE, kind: "holiday" }).success).toBe(false);
    expect(ExceptionInput.safeParse({ telecallerId: "00000000-0000-4000-8000-000000000001", onDate: DATE, kind: "custom_hours" }).success).toBe(false);
  });

  it("refuses a half day spanning dates, and backwards leave", () => {
    const leave = { kind: "leave", leaveType: "casual", startDate: DATE, endDate: DATE };
    expect(AttendanceRequestInput.safeParse(leave).success).toBe(true);
    expect(AttendanceRequestInput.safeParse({ ...leave, endDate: "2026-09-29", halfDay: "am" }).success).toBe(false);
    expect(AttendanceRequestInput.safeParse({ ...leave, endDate: "2026-09-27" }).success).toBe(false);
  });

  it("needs a note to reject", () => {
    expect(RequestDecisionInput.safeParse({ decision: "reject" }).success).toBe(false);
    expect(RequestDecisionInput.safeParse({ decision: "reject", note: "short-staffed" }).success).toBe(true);
    expect(RequestDecisionInput.safeParse({ decision: "approve" }).success).toBe(true);
  });
});

describe("attendanceAlertText", () => {
  it("names the dates and never carries the reason", () => {
    const text = attendanceAlertText({
      reason: "new_request",
      telecallerName: "Priya",
      kind: "leave",
      leaveType: "casual",
      startDate: "2026-10-03",
      endDate: "2026-10-04",
      zone: ZONE,
      link: "https://aura.example/admin/owner/attendance?tab=requests",
    });
    expect(text).toBe(
      "Leave request from Priya: casual, 3 Oct - 4 Oct (2 days). Waiting for your decision: https://aura.example/admin/owner/attendance?tab=requests",
    );
  });
});

describe("suggestSilenceThreshold", () => {
  it("clamps to 5-20 and never exceeds the pattern", () => {
    expect(suggestSilenceThreshold(null, 10)).toBe(10);
    expect(suggestSilenceThreshold(60, 10)).toBe(5);
    expect(suggestSilenceThreshold(420, 10)).toBe(7);
    expect(suggestSilenceThreshold(3600, 30)).toBe(20);
    expect(suggestSilenceThreshold(3600, 10)).toBe(10);
  });
});
