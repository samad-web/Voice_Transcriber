import { z } from "zod";
import { resolveTimeZone, shiftDateKey, wallTimeToInstant, zonedParts } from "./time";

/**
 * Attendance and shift scheduling (Build docs/33, migration 0140).
 *
 * Pure by design, like leads.ts and time.ts: the API validates with these
 * schemas, the worker classifies with `classifyAttendanceDay`, the console
 * renders with the same labels, and the handset's JSON contract is the
 * `DeviceAttendanceConfig` shape below. One definition, four consumers.
 *
 * Information only (doc 33 §12 Q3): nothing here computes pay.
 */

// ── Constants ───────────────────────────────────────────────────────────────

/** How often a phone on shift posts its presence batch. */
export const ATTENDANCE_HEARTBEAT_SECONDS = 120;
/** A silence in the phone's own timeline longer than this is a gap (§4). */
export const ATTENDANCE_GAP_SECONDS = ATTENDANCE_HEARTBEAT_SECONDS * 2;
/** Events per presence upload. The handset pages its offline backlog at this size. */
export const PRESENCE_BATCH_MAX = 500;
/** Raw presence events are purged after this many days. */
export const PRESENCE_RETENTION_DAYS = 90;
/** A connected call shorter than this counts as a failed call for corroboration. */
export const FAILED_CALL_SECONDS = 5;
/** Dead air longer than this in one connected call corroborates a fault. */
export const DEAD_AIR_FAULT_SECONDS = 60;
/** Consecutive "I'm here" answers with no call between them before a flag. */
export const RESPONDING_NOT_DIALING_COUNT = 3;
/** A break may start this long after its slot and still count as that slot (a call ran on). */
export const BREAK_DEFERRAL_TOLERANCE_MINUTES = 30;
/** Minutes past a break's allowed length before the time counts as overrun. */
export const BREAK_OVERRUN_GRACE_MINUTES = 2;
/** Minutes an overrun must reach before the manager is told. */
export const BREAK_OVERRUN_ALERT_MINUTES = 10;
/** Leave never waits with an absent manager past this point before it starts. */
export const LEAVE_ESCALATION_FLOOR_HOURS = 2;
/** The minimum handset versionCode that understands the attendance block. */
export const ATTENDANCE_MIN_VERSION_CODE = 10;
/** Bump when ATTENDANCE_NOTICE_TEXT changes, so every phone asks again. */
export const ATTENDANCE_NOTICE_VERSION = 1;
export const ATTENDANCE_NOTICE_TEXT =
  "Your workspace records attendance on this phone during your shift hours: when your shift starts " +
  "and ends, your breaks, call activity (not what is said), whether you answered a presence check, " +
  "and whether the phone had network and power. Nothing is recorded outside your shift, and this app " +
  "never listens to the room. You can see your own timeline on the Attendance tab. Your managers see " +
  "the same timeline.";

export const DEFAULT_SHIFT = {
  graceMinutes: 10,
  breakAllowanceMinutes: 60,
  silenceThresholdMinutes: 10,
  promptTimeoutMinutes: 3,
} as const;

// ── Enums ───────────────────────────────────────────────────────────────────

export const HandsetState = z.enum([
  "OFF_SHIFT",
  "ACTIVE",
  "IN_CALL",
  "PROMPTING",
  "AWAY",
  "TECHNICAL",
  "BREAK_DUE",
  "ON_BREAK",
]);
export type HandsetState = z.infer<typeof HandsetState>;

export const PresenceEventKind = z.enum([
  "heartbeat",
  "state",
  "shift_start",
  "shift_end",
  "call_start",
  "call_end",
  "prompt_shown",
  "prompt_answered",
  "prompt_expired",
  "break_started",
  "break_ended",
  "network_lost",
  "network_restored",
  "boot",
  "app_start",
  "service_start",
  "service_stop",
  "screen_unlock",
  "notice_acknowledged",
]);
export type PresenceEventKind = z.infer<typeof PresenceEventKind>;

export const PromptAnswer = z.enum(["here", "technical", "break"]);
export type PromptAnswer = z.infer<typeof PromptAnswer>;

export const TechnicalReason = z.enum(["no_signal", "calls_failing", "headset_or_mic", "phone_slow", "other"]);
export type TechnicalReason = z.infer<typeof TechnicalReason>;

export const SegmentClass = z.enum([
  "working",
  "break",
  "break_overrun",
  "unscheduled_break",
  "technical",
  "away",
  "leave",
  "unknown",
  "not_started",
  "absent",
  "overtime",
]);
export type SegmentClass = z.infer<typeof SegmentClass>;

export const AttendanceDayStatus = z.enum([
  "present",
  "late",
  "half_day",
  "absent",
  "on_leave",
  "holiday",
  "off",
  "upcoming",
]);
export type AttendanceDayStatus = z.infer<typeof AttendanceDayStatus>;

export const AttendanceFlag = z.enum([
  "late",
  "early_leave",
  "break_overrun",
  "unscheduled_break",
  "responding_not_dialing",
  "network_outage",
  "clock_skew",
  "not_started",
  "worked_on_day_off",
]);
export type AttendanceFlag = z.infer<typeof AttendanceFlag>;

export const LeaveType = z.enum(["casual", "sick", "earned", "unpaid", "other"]);
export type LeaveType = z.infer<typeof LeaveType>;

export const RequestKind = z.enum(["break", "leave", "hours_change"]);
export type RequestKind = z.infer<typeof RequestKind>;

export const RequestStatus = z.enum(["pending", "approved", "rejected", "auto_approved", "cancelled"]);
export type RequestStatus = z.infer<typeof RequestStatus>;

export const HalfDay = z.enum(["am", "pm"]);
export type HalfDay = z.infer<typeof HalfDay>;

export const ExceptionKind = z.enum(["holiday", "day_off", "custom_hours"]);
export type ExceptionKind = z.infer<typeof ExceptionKind>;

export const OverrideClass = z.enum(["excused", "unexcused"]);
export type OverrideClass = z.infer<typeof OverrideClass>;

// ── Labels (console and handset share the words) ────────────────────────────

export const HANDSET_STATE_LABELS: Record<HandsetState, string> = {
  OFF_SHIFT: "Off shift",
  ACTIVE: "Active",
  IN_CALL: "In call",
  PROMPTING: "Prompted",
  AWAY: "Away",
  TECHNICAL: "Technical problem",
  BREAK_DUE: "Break due",
  ON_BREAK: "On break",
};

export const SEGMENT_CLASS_LABELS: Record<SegmentClass, string> = {
  working: "Working",
  break: "Break",
  break_overrun: "Break overrun",
  unscheduled_break: "Unscheduled break",
  technical: "Technical",
  away: "Away",
  leave: "Leave",
  unknown: "Unknown",
  not_started: "Not started",
  absent: "Absent",
  overtime: "Overtime",
};

export const DAY_STATUS_LABELS: Record<AttendanceDayStatus, string> = {
  present: "Present",
  late: "Late",
  half_day: "Half day",
  absent: "Absent",
  on_leave: "On leave",
  holiday: "Holiday",
  off: "Day off",
  upcoming: "Upcoming",
};

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  casual: "Casual",
  sick: "Sick",
  earned: "Earned",
  unpaid: "Unpaid",
  other: "Other",
};

export const FLAG_LABELS: Record<AttendanceFlag, string> = {
  late: "Late",
  early_leave: "Left early",
  break_overrun: "Break overran",
  unscheduled_break: "Unscheduled break",
  responding_not_dialing: "Answering checks, not dialling",
  network_outage: "Network outage",
  clock_skew: "Phone clock wrong",
  not_started: "Shift not started",
  worked_on_day_off: "Worked on a day off",
};

/** Rule numbers from doc 33 §4, for the Review tab's "why". */
export const RULE_LABELS: Record<number, string> = {
  0: "What the phone recorded",
  1: "Approved leave",
  2: "Scheduled or approved break",
  3: "Phone kept working without network",
  4: "Network lost",
  5: "Phone ran out of power",
  6: "Reported a problem, and the phone's record backs it up",
  7: "Reported a problem, with nothing to back it up",
  8: "Phone or app restarted",
  9: "Break taken outside the allowance",
  10: "Presence check not answered",
  11: "Phone went silent with no explanation",
  12: "No sign of the phone all shift",
};

// ── Input schemas: owner console ────────────────────────────────────────────

const WallTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "expected HH:MM");
const DateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "expected YYYY-MM-DD");
const IsoInstant = z.string().datetime({ offset: true });

export const BreakSlotInput = z.object({
  label: z.string().trim().min(1).max(60),
  startTime: WallTime,
  durationMinutes: z.number().int().min(5).max(240),
});
export type BreakSlotInput = z.infer<typeof BreakSlotInput>;

export const ShiftPatternInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    workDays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .transform((days) => [...new Set(days)].sort((a, b) => a - b)),
    startTime: WallTime,
    endTime: WallTime,
    graceMinutes: z.number().int().min(0).max(240),
    breakAllowanceMinutes: z.number().int().min(0).max(480),
    silenceThresholdMinutes: z.number().int().min(3).max(120),
    promptTimeoutMinutes: z.number().int().min(1).max(30),
    breaks: z.array(BreakSlotInput).max(8),
  })
  .refine((p) => p.startTime !== p.endTime, { message: "start and end must differ", path: ["endTime"] })
  .refine((p) => p.breaks.reduce((sum, b) => sum + b.durationMinutes, 0) <= p.breakAllowanceMinutes, {
    message: "fixed breaks add up to more than the break allowance",
    path: ["breaks"],
  })
  .refine(
    (p) => p.breaks.every((b) => wallTimeWithinShift(b.startTime, b.durationMinutes, p.startTime, p.endTime)),
    { message: "every break must fall inside the shift", path: ["breaks"] },
  );
export type ShiftPatternInput = z.infer<typeof ShiftPatternInput>;

/**
 * Workspace settings. No `.default()` anywhere: a PUT that omits a field must
 * leave it alone, never reset it (the partial/default trap).
 */
export const AttendanceSettingsInput = z
  .object({
    enabled: z.boolean(),
    leaveEscalationHours: z.number().int().min(1).max(168),
    whatsappAlerts: z.boolean(),
    whatsappChannelId: z.string().uuid().nullable(),
  })
  .partial();
export type AttendanceSettingsInput = z.infer<typeof AttendanceSettingsInput>;

export const PeopleUpdateInput = z.object({
  telecallerIds: z.array(z.string().uuid()).min(1).max(500),
  /** Omitted = unchanged. `null` = unassign from `effectiveFrom`. */
  shiftPatternId: z.string().uuid().nullable().optional(),
  /** When a pattern change takes effect. Defaults to today in the API. */
  effectiveFrom: DateKey.optional(),
  reportsToMembershipId: z.string().uuid().nullable().optional(),
  appLeaveRequests: z.boolean().optional(),
  appBreakBooking: z.boolean().optional(),
});
export type PeopleUpdateInput = z.infer<typeof PeopleUpdateInput>;

export const ExceptionInput = z
  .object({
    telecallerId: z.string().uuid().nullable(),
    onDate: DateKey,
    kind: ExceptionKind,
    label: z.string().trim().max(80).nullish(),
    startTime: WallTime.nullish(),
    endTime: WallTime.nullish(),
  })
  .refine((e) => (e.kind === "holiday") === (e.telecallerId === null), {
    message: "a holiday is for the whole workspace; a day off or custom hours is for one person",
    path: ["telecallerId"],
  })
  .refine((e) => (e.kind === "custom_hours") === Boolean(e.startTime && e.endTime), {
    message: "custom hours need a start and an end, and only custom hours may have them",
    path: ["startTime"],
  })
  .refine((e) => !e.startTime || e.startTime !== e.endTime, { message: "start and end must differ", path: ["endTime"] });
export type ExceptionInput = z.infer<typeof ExceptionInput>;

const RequestBase = {
  reason: z.string().trim().max(500).nullish(),
};

export const LeaveRequestInput = z
  .object({
    kind: z.literal("leave"),
    leaveType: LeaveType,
    startDate: DateKey,
    endDate: DateKey,
    halfDay: HalfDay.nullish(),
    ...RequestBase,
  })
  .refine((r) => r.endDate >= r.startDate, { message: "the leave ends before it starts", path: ["endDate"] })
  .refine((r) => !r.halfDay || r.startDate === r.endDate, {
    message: "a half day is a single date",
    path: ["halfDay"],
  })
  .refine((r) => dateSpanDays(r.startDate, r.endDate) <= 60, {
    message: "apply for at most 60 days at a time",
    path: ["endDate"],
  });

export const TimedRequestInput = z
  .object({
    kind: z.enum(["break", "hours_change"]),
    startsAt: IsoInstant,
    endsAt: IsoInstant,
    ...RequestBase,
  })
  .refine((r) => Date.parse(r.endsAt) > Date.parse(r.startsAt), { message: "ends before it starts", path: ["endsAt"] })
  .refine((r) => r.kind !== "break" || Date.parse(r.endsAt) - Date.parse(r.startsAt) <= 4 * 3_600_000, {
    message: "a break is at most 4 hours",
    path: ["endsAt"],
  });

export const AttendanceRequestInput = z.union([LeaveRequestInput, TimedRequestInput]);
export type AttendanceRequestInput = z.infer<typeof AttendanceRequestInput>;

/** From the handset: the same shapes plus the offline id. */
export const DeviceAttendanceRequestInput = z.intersection(
  AttendanceRequestInput,
  z.object({ clientRef: z.string().min(8).max(80) }),
);
export type DeviceAttendanceRequestInput = z.infer<typeof DeviceAttendanceRequestInput>;

/** An owner/manager recording something for a telecaller; approved in the same step. */
export const OnBehalfRequestInput = z.intersection(
  AttendanceRequestInput,
  z.object({ telecallerId: z.string().uuid() }),
);
export type OnBehalfRequestInput = z.infer<typeof OnBehalfRequestInput>;

export const RequestDecisionInput = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(500).nullish(),
  })
  .refine((d) => d.decision === "approve" || Boolean(d.note && d.note.length > 0), {
    message: "say why when rejecting",
    path: ["note"],
  });
export type RequestDecisionInput = z.infer<typeof RequestDecisionInput>;

export const SegmentOverrideInput = z.object({
  overrideClass: OverrideClass,
  note: z.string().trim().min(1).max(500),
});
export type SegmentOverrideInput = z.infer<typeof SegmentOverrideInput>;

// ── Handset contract ────────────────────────────────────────────────────────

export const PresenceEventInput = z.object({
  kind: PresenceEventKind,
  /** The phone's wall clock when it happened. */
  at: IsoInstant,
  /** Settings.Global.BOOT_COUNT, as a string. */
  bootId: z.string().min(1).max(64),
  /** SystemClock.elapsedRealtime() when it happened. */
  monoMs: z.number().int().min(0),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type PresenceEventInput = z.infer<typeof PresenceEventInput>;

export const PresenceBatchInput = z.object({
  /** The phone's clock readings at the moment it SENT the batch. */
  sentAt: IsoInstant,
  sentBootId: z.string().min(1).max(64),
  sentMonoMs: z.number().int().min(0),
  /** Current state, so the Today board is right even with an empty batch. */
  state: HandsetState,
  stateSince: IsoInstant,
  batteryPct: z.number().int().min(0).max(100).optional(),
  networkOk: z.boolean().optional(),
  events: z.array(PresenceEventInput).max(PRESENCE_BATCH_MAX),
});
export type PresenceBatchInput = z.infer<typeof PresenceBatchInput>;

export const PresenceBatchResponse = z.object({
  accepted: z.number().int(),
  duplicates: z.number().int(),
  /** Set when the phone's clock is more than 2 minutes out. */
  clockSkewSeconds: z.number().int().optional(),
  /** When the config's scheduleVersion is newer than the phone's, fetch config. */
  scheduleVersion: z.number().int(),
});
export type PresenceBatchResponse = z.infer<typeof PresenceBatchResponse>;

export const DeviceScheduleBreak = z.object({
  label: z.string(),
  startsAt: IsoInstant,
  endsAt: IsoInstant,
  source: z.enum(["slot", "booked"]),
});
export type DeviceScheduleBreak = z.infer<typeof DeviceScheduleBreak>;

export const DeviceScheduleDay = z.object({
  date: DateKey,
  kind: z.enum(["work", "off", "holiday", "leave"]),
  /** Omitted (never null) when the day has no shift - Android optString rule. */
  shiftStart: IsoInstant.optional(),
  shiftEnd: IsoInstant.optional(),
  /** Present for a half day of leave. */
  halfDay: HalfDay.optional(),
  label: z.string().optional(),
  breaks: z.array(DeviceScheduleBreak),
});
export type DeviceScheduleDay = z.infer<typeof DeviceScheduleDay>;

/**
 * The `attendance` block of GET /devices/me/config. Omitted entirely while the
 * workspace switch is off, so a 1.1.x handset and a switched-off workspace
 * look identical to the phone.
 */
export const DeviceAttendanceConfig = z.object({
  enabled: z.literal(true),
  canApplyLeave: z.boolean(),
  canBookBreaks: z.boolean(),
  /** "Ravi" - who a request will go to. Omitted when it goes to the owners. */
  approverName: z.string().optional(),
  heartbeatSeconds: z.number().int(),
  silenceThresholdMinutes: z.number().int(),
  promptTimeoutMinutes: z.number().int(),
  graceMinutes: z.number().int(),
  breakAllowanceMinutes: z.number().int(),
  scheduleVersion: z.number().int(),
  timeZone: z.string(),
  /** Today and tomorrow, in the workspace zone. */
  days: z.array(DeviceScheduleDay),
  noticeVersion: z.number().int(),
  noticeText: z.string(),
});
export type DeviceAttendanceConfig = z.infer<typeof DeviceAttendanceConfig>;

// ── Schedule resolution ─────────────────────────────────────────────────────

export interface PatternRecord {
  id: string;
  name: string;
  workDays: number[];
  startTime: string;
  endTime: string;
  graceMinutes: number;
  breakAllowanceMinutes: number;
  silenceThresholdMinutes: number;
  promptTimeoutMinutes: number;
  breaks: { label: string; startTime: string; durationMinutes: number }[];
}

export interface ExceptionRecord {
  telecallerId: string | null;
  onDate: string;
  kind: ExceptionKind;
  label?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}

export interface RequestRecord {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  leaveType?: LeaveType | null;
  startDate?: string | null;
  endDate?: string | null;
  halfDay?: HalfDay | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface ResolvedBreak {
  label: string;
  startsAt: string;
  endsAt: string;
  source: "slot" | "booked";
}

export interface ResolvedDay {
  date: string;
  kind: "work" | "off" | "holiday" | "leave";
  label?: string;
  shiftStart?: string;
  shiftEnd?: string;
  halfDay?: HalfDay;
  graceMinutes: number;
  breakAllowanceMinutes: number;
  silenceThresholdMinutes: number;
  promptTimeoutMinutes: number;
  breaks: ResolvedBreak[];
}

function minutesOf(wall: string): number {
  const [h, m] = wall.split(":").map(Number);
  return h! * 60 + m!;
}

/** True when a break starting at `start` for `minutes` lies inside the shift. */
function wallTimeWithinShift(start: string, minutes: number, shiftStart: string, shiftEnd: string): boolean {
  const s = minutesOf(shiftStart);
  let e = minutesOf(shiftEnd);
  if (e <= s) e += 1440;
  let b = minutesOf(start);
  if (b < s) b += 1440;
  return b >= s && b + minutes <= e;
}

function dateSpanDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
}

/** ISO weekday (1 = Monday) of a date key. */
export function isoWeekdayOf(dateKey: string): number {
  const d = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The instant a wall time on a date means, rolling to the next date when `nextDay`. */
function wallInstant(date: string, wall: string, zone: string, nextDay = false): string {
  const day = nextDay ? shiftDateKey(date, 1) : date;
  return wallTimeToInstant(`${day}T${wall}`, zone)!;
}

/**
 * What a telecaller's day looks like: shift window, breaks, or why there is
 * none. The single place a pattern, the exceptions and approved requests are
 * combined - the device config, the classifier and the console all call it.
 *
 * Precedence: approved full leave > a personal exception > a workspace holiday
 * > the pattern. An approved hours change replaces the window; approved break
 * bookings are added to the fixed slots.
 */
export function resolveAttendanceDay(input: {
  date: string;
  zone: string;
  pattern: PatternRecord | null;
  exceptions: ExceptionRecord[];
  requests: RequestRecord[];
}): ResolvedDay {
  const zone = resolveTimeZone(input.zone);
  const p = input.pattern;
  const base: ResolvedDay = {
    date: input.date,
    kind: "off",
    graceMinutes: p?.graceMinutes ?? DEFAULT_SHIFT.graceMinutes,
    breakAllowanceMinutes: p?.breakAllowanceMinutes ?? DEFAULT_SHIFT.breakAllowanceMinutes,
    silenceThresholdMinutes: p?.silenceThresholdMinutes ?? DEFAULT_SHIFT.silenceThresholdMinutes,
    promptTimeoutMinutes: p?.promptTimeoutMinutes ?? DEFAULT_SHIFT.promptTimeoutMinutes,
    breaks: [],
  };

  const approved = input.requests.filter((r) => r.status === "approved" || r.status === "auto_approved");
  const leave = approved.find(
    (r) => r.kind === "leave" && r.startDate && r.endDate && r.startDate <= input.date && input.date <= r.endDate,
  );
  if (leave && !leave.halfDay) {
    return { ...base, kind: "leave", label: leave.leaveType ? LEAVE_TYPE_LABELS[leave.leaveType] : "Leave" };
  }

  const personal = input.exceptions.find((e) => e.telecallerId !== null && e.onDate === input.date);
  const holiday = input.exceptions.find((e) => e.telecallerId === null && e.onDate === input.date);

  if (personal?.kind === "day_off") return { ...base, kind: "off", label: personal.label ?? "Day off" };
  if (!personal && holiday) return { ...base, kind: "holiday", label: holiday.label ?? "Holiday" };

  let startWall: string | null = null;
  let endWall: string | null = null;
  if (personal?.kind === "custom_hours" && personal.startTime && personal.endTime) {
    startWall = personal.startTime.slice(0, 5);
    endWall = personal.endTime.slice(0, 5);
  } else if (p && p.workDays.includes(isoWeekdayOf(input.date))) {
    startWall = p.startTime.slice(0, 5);
    endWall = p.endTime.slice(0, 5);
  }

  let shiftStart: string | null = null;
  let shiftEnd: string | null = null;
  if (startWall && endWall) {
    shiftStart = wallInstant(input.date, startWall, zone);
    shiftEnd = wallInstant(input.date, endWall, zone, minutesOf(endWall) <= minutesOf(startWall));
  }

  // An approved hours change whose start falls on this date replaces the window.
  const hours = approved.find(
    (r) => r.kind === "hours_change" && r.startsAt && r.endsAt && dayOf(r.startsAt, zone) === input.date,
  );
  if (hours) {
    shiftStart = new Date(hours.startsAt!).toISOString();
    shiftEnd = new Date(hours.endsAt!).toISOString();
  }

  if (!shiftStart || !shiftEnd) return { ...base, kind: "off", label: personal?.label ?? undefined };

  const breaks: ResolvedBreak[] = [];
  if (p && !(personal?.kind === "custom_hours") && !hours) {
    for (const slot of p.breaks) {
      const wall = slot.startTime.slice(0, 5);
      const startsAt = wallInstant(input.date, wall, zone, minutesOf(wall) < minutesOf(startWall!));
      breaks.push({
        label: slot.label,
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + slot.durationMinutes * 60_000).toISOString(),
        source: "slot",
      });
    }
  }
  const startMs = Date.parse(shiftStart);
  const endMs = Date.parse(shiftEnd);
  for (const r of approved) {
    if (r.kind !== "break" || !r.startsAt || !r.endsAt) continue;
    const s = Date.parse(r.startsAt);
    if (s >= startMs && s < endMs) {
      breaks.push({
        label: "Booked break",
        startsAt: new Date(s).toISOString(),
        endsAt: new Date(Date.parse(r.endsAt)).toISOString(),
        source: "booked",
      });
    }
  }
  breaks.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

  return {
    ...base,
    kind: "work",
    shiftStart,
    shiftEnd,
    halfDay: leave?.halfDay ?? undefined,
    label: leave?.halfDay ? `Half day ${leave.halfDay === "am" ? "morning" : "afternoon"} leave` : undefined,
    breaks,
  };
}

function dayOf(instant: string, zone: string): string {
  const p = zonedParts(instant, zone)!;
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The device-config form of a resolved day - optional keys omitted, never null. */
export function toDeviceScheduleDay(day: ResolvedDay): DeviceScheduleDay {
  return {
    date: day.date,
    kind: day.kind,
    ...(day.shiftStart ? { shiftStart: day.shiftStart } : {}),
    ...(day.shiftEnd ? { shiftEnd: day.shiftEnd } : {}),
    ...(day.halfDay ? { halfDay: day.halfDay } : {}),
    ...(day.label ? { label: day.label } : {}),
    breaks: day.breaks,
  };
}

/**
 * The half of a split shift that is leave. Morning leave covers shift start to
 * the midpoint; afternoon leave covers the midpoint to the end.
 */
export function halfDayLeaveWindow(day: ResolvedDay): { start: number; end: number } | null {
  if (!day.halfDay || !day.shiftStart || !day.shiftEnd) return null;
  const s = Date.parse(day.shiftStart);
  const e = Date.parse(day.shiftEnd);
  const mid = s + Math.round((e - s) / 2);
  return day.halfDay === "am" ? { start: s, end: mid } : { start: mid, end: e };
}

// ── Break booking ───────────────────────────────────────────────────────────

/**
 * Whether a break the telecaller books can be approved on the spot (doc 33 §12
 * Q2): inside the shift, not overlapping another break, and within the day's
 * allowance counting the fixed slots.
 */
export function canAutoApproveBreak(day: ResolvedDay, startsAt: string, endsAt: string): {
  ok: boolean;
  reason?: "no_shift" | "outside_shift" | "overlaps" | "over_allowance";
} {
  if (day.kind !== "work" || !day.shiftStart || !day.shiftEnd) return { ok: false, reason: "no_shift" };
  const s = Date.parse(startsAt);
  const e = Date.parse(endsAt);
  if (s < Date.parse(day.shiftStart) || e > Date.parse(day.shiftEnd)) return { ok: false, reason: "outside_shift" };
  if (day.breaks.some((b) => s < Date.parse(b.endsAt) && e > Date.parse(b.startsAt))) {
    return { ok: false, reason: "overlaps" };
  }
  const used = day.breaks.reduce((sum, b) => sum + (Date.parse(b.endsAt) - Date.parse(b.startsAt)), 0);
  if (used + (e - s) > day.breakAllowanceMinutes * 60_000) return { ok: false, reason: "over_allowance" };
  return { ok: true };
}

// ── Approver routing (doc 33 §6.3) ──────────────────────────────────────────

export interface ApproverCandidate {
  membershipId: string;
  ownerRole: string | null;
  status: string;
}

/**
 * The membership a new request goes to, or null for "every active owner".
 * Only an ACTIVE owner or manager can be an approver; a suspended or demoted
 * manager falls through to the owners rather than leaving a request with
 * nobody.
 */
export function resolveApprover(reportsTo: ApproverCandidate | null): string | null {
  if (!reportsTo) return null;
  if (reportsTo.status !== "active") return null;
  if (reportsTo.ownerRole !== "owner" && reportsTo.ownerRole !== "manager") return null;
  return reportsTo.membershipId;
}

/**
 * Whether `actor` may approve or reject `request`. The assigned approver or any
 * owner - and never somebody deciding their own request.
 */
export function canDecideRequest(
  request: { approverMembershipId: string | null; telecallerId: string },
  actor: { membershipId: string; ownerRole: string | null; telecallerIds: string[] },
): boolean {
  if (actor.telecallerIds.includes(request.telecallerId)) return false;
  if (actor.ownerRole === "owner") return true;
  return request.approverMembershipId !== null && request.approverMembershipId === actor.membershipId;
}

/**
 * When a pending request should also go to the owners: `hours` after it was
 * made, or `LEAVE_ESCALATION_FLOOR_HOURS` before it starts, whichever comes
 * first - but never before it was made. Null when it already goes to the
 * owners (no approver).
 */
export function escalationDueAt(input: {
  createdAt: string;
  approverMembershipId: string | null;
  escalationHours: number;
  /** The request's first instant: leave start at shift start, or startsAt. */
  startsAt: string | null;
}): string | null {
  if (!input.approverMembershipId) return null;
  const created = Date.parse(input.createdAt);
  let due = created + input.escalationHours * 3_600_000;
  if (input.startsAt) {
    due = Math.min(due, Date.parse(input.startsAt) - LEAVE_ESCALATION_FLOOR_HOURS * 3_600_000);
  }
  return new Date(Math.max(due, created)).toISOString();
}

// ── Clock trust (doc 33 §4) ─────────────────────────────────────────────────

/**
 * The server's instant for each event. Events from the boot the batch was sent
 * in are placed by the monotonic clock (immune to a phone whose time was
 * changed); events from an earlier boot fall back to wall time corrected by the
 * skew measured on this batch.
 */
export function normalisePresenceBatch(
  batch: Pick<PresenceBatchInput, "sentAt" | "sentBootId" | "sentMonoMs" | "events">,
  receivedAtMs: number,
): { events: (PresenceEventInput & { occurredAt: string })[]; skewSeconds: number } {
  const skewMs = Date.parse(batch.sentAt) - receivedAtMs;
  const events = batch.events.map((e) => {
    let at: number;
    if (e.bootId === batch.sentBootId && e.monoMs <= batch.sentMonoMs) {
      at = receivedAtMs - (batch.sentMonoMs - e.monoMs);
    } else {
      at = Date.parse(e.at) - skewMs;
    }
    // Nothing is allowed to have happened in the future.
    return { ...e, occurredAt: new Date(Math.min(at, receivedAtMs)).toISOString() };
  });
  return { events, skewSeconds: Math.round(skewMs / 1000) };
}

// ── The classifier (doc 33 §4) ──────────────────────────────────────────────

export interface ClassifierEvent {
  kind: PresenceEventKind;
  /** Server-corrected instant, ISO. */
  at: string;
  payload?: Record<string, unknown>;
  /** received_at - occurred_at > a few minutes means it was uploaded late. */
  receivedAt?: string;
}

export interface CallQualityRecord {
  startedAt: string;
  endedAt: string;
  zeroSignal: boolean;
  longestDeadAirSeconds: number;
}

export interface OverrideRecord {
  id: string;
  startsAt: string;
  endsAt: string;
  overrideClass: OverrideClass;
}

export interface ClassifiedSegment {
  startsAt: string;
  endsAt: string;
  class: SegmentClass;
  rule: number;
  needsReview: boolean;
  evidence: Record<string, unknown>;
  overrideClass?: OverrideClass;
  overrideId?: string;
}

export interface ClassifiedDay {
  status: AttendanceDayStatus;
  shiftStartAt: string | null;
  shiftEndAt: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedSeconds: number;
  breakSeconds: number;
  bookedBreakSeconds: number;
  technicalSeconds: number;
  awaySeconds: number;
  unknownSeconds: number;
  lateSeconds: number;
  overtimeSeconds: number;
  reviewCount: number;
  flags: AttendanceFlag[];
  segments: ClassifiedSegment[];
}

interface Interval {
  start: number;
  end: number;
  cls: SegmentClass;
  rule: number;
  review: boolean;
  evidence: Record<string, unknown>;
}

const STATE_CLASS: Record<HandsetState, SegmentClass> = {
  OFF_SHIFT: "not_started",
  ACTIVE: "working",
  IN_CALL: "working",
  PROMPTING: "working",
  AWAY: "away",
  TECHNICAL: "technical",
  BREAK_DUE: "working",
  ON_BREAK: "break",
};

const iso = (ms: number) => new Date(ms).toISOString();

function stateOf(e: ClassifierEvent): HandsetState | null {
  if (e.kind !== "state") return null;
  const parsed = HandsetState.safeParse(e.payload?.state);
  return parsed.success ? parsed.data : null;
}

/**
 * Turns one telecaller's day of phone events into classified time.
 *
 * The phone's own state machine is the base line - it keeps running with no
 * network, so a stretch it recorded is a stretch it knows about. On top of it:
 * gaps where the phone recorded nothing at all (rules 5, 8, 11), corroboration
 * of a reported technical problem (6 vs 7), breaks matched to their slots or
 * the flexible allowance (2, 9, overrun), unanswered checks (10), leave (1)
 * and no-show (12). Pure and deterministic: same inputs, same segments.
 */
export function classifyAttendanceDay(input: {
  day: ResolvedDay;
  events: ClassifierEvent[];
  callQuality?: CallQualityRecord[];
  overrides?: OverrideRecord[];
  now: number;
  gapSeconds?: number;
}): ClassifiedDay {
  const { day } = input;
  const gapMs = (input.gapSeconds ?? ATTENDANCE_GAP_SECONDS) * 1000;
  const events = [...input.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const flags = new Set<AttendanceFlag>();

  const empty = (status: AttendanceDayStatus): ClassifiedDay => ({
    status,
    shiftStartAt: day.shiftStart ?? null,
    shiftEndAt: day.shiftEnd ?? null,
    checkInAt: null,
    checkOutAt: null,
    workedSeconds: 0,
    breakSeconds: 0,
    bookedBreakSeconds: 0,
    technicalSeconds: 0,
    awaySeconds: 0,
    unknownSeconds: 0,
    lateSeconds: 0,
    overtimeSeconds: 0,
    reviewCount: 0,
    flags: [],
    segments: [],
  });

  // ── Days with no shift ──
  if (day.kind !== "work" || !day.shiftStart || !day.shiftEnd) {
    const status: AttendanceDayStatus = day.kind === "leave" ? "on_leave" : day.kind === "holiday" ? "holiday" : "off";
    const out = empty(status);
    // Calls on a day off are overtime, not an error.
    const worked = callSeconds(events, -Infinity, Infinity);
    if (worked > 0) {
      out.overtimeSeconds = worked;
      out.flags = ["worked_on_day_off"];
    }
    return out;
  }

  const shiftStart = Date.parse(day.shiftStart);
  const shiftEnd = Date.parse(day.shiftEnd);
  const graceMs = day.graceMinutes * 60_000;
  const horizon = Math.min(shiftEnd, input.now);

  if (input.now < shiftStart) {
    return empty("upcoming");
  }

  // ── Check-in: the first explicit start or call inside the window (an hour early counts) ──
  const inWindow = events.filter((e) => {
    const t = Date.parse(e.at);
    return t >= shiftStart - 3_600_000 && t <= shiftEnd;
  });
  const checkInEvent = inWindow.find((e) => e.kind === "shift_start" || e.kind === "call_start");
  const checkIn = checkInEvent ? Math.max(Date.parse(checkInEvent.at), shiftStart) : null;

  const leaveWin = halfDayLeaveWindow(day);

  if (checkIn === null) {
    if (input.now < shiftStart + graceMs && !leaveWin) return empty("upcoming");
    const out = empty(day.halfDay ? "half_day" : "absent");
    const segs: Interval[] = [];
    if (leaveWin) {
      segs.push({ start: leaveWin.start, end: leaveWin.end, cls: "leave", rule: 1, review: false, evidence: {} });
    }
    const absentWindows = subtract([{ start: shiftStart, end: horizon }], leaveWin ? [leaveWin] : []);
    for (const w of absentWindows) {
      if (w.end > w.start) {
        segs.push({ ...w, cls: input.now >= shiftEnd ? "absent" : "not_started", rule: 12, review: false, evidence: {} });
      }
    }
    out.segments = finalise(segs, input.overrides);
    out.awaySeconds = 0;
    if (!leaveWin) {
      out.status = input.now >= shiftEnd ? "absent" : "late";
      if (out.status === "late") {
        out.flags = ["not_started"];
        out.lateSeconds = Math.round((horizon - shiftStart) / 1000);
      }
    }
    return out;
  }

  // ── Base line: the phone's state timeline between check-in and the horizon ──
  const base: Interval[] = [];
  let current: HandsetState = "ACTIVE";
  let cursor = checkIn;
  let promptStart: number | null = null;
  let lastAnswer: { answer: PromptAnswer; reason?: string; at: number } | null = null;

  const pushBase = (end: number, state: HandsetState) => {
    if (end <= cursor) return;
    base.push({
      start: cursor,
      end,
      cls: STATE_CLASS[state],
      rule: 0,
      review: false,
      evidence: state === "TECHNICAL" && lastAnswer ? { reason: lastAnswer.reason ?? null } : {},
    });
  };

  for (const e of events) {
    const t = Date.parse(e.at);
    if (t < checkIn) {
      const s = stateOf(e);
      if (s) current = s === "OFF_SHIFT" ? "ACTIVE" : s;
      continue;
    }
    if (t > horizon) break;
    if (e.kind === "prompt_answered") {
      const a = PromptAnswer.safeParse(e.payload?.answer);
      if (a.success) {
        const r = e.payload?.reason;
        lastAnswer = { answer: a.data, reason: typeof r === "string" ? r : undefined, at: t };
      }
    }
    const s = stateOf(e);
    if (!s || s === current) continue;
    pushBase(t, current);
    // A prompt that ended in AWAY: the away time began when the prompt appeared.
    if (current === "PROMPTING") {
      if (s === "AWAY" && promptStart !== null) {
        const last = base[base.length - 1];
        if (last && last.start >= promptStart) last.cls = "away";
      }
      promptStart = null;
    }
    if (s === "PROMPTING") promptStart = t;
    current = s === "OFF_SHIFT" && t < shiftEnd ? "AWAY" : s;
    cursor = t;
    if (s === "OFF_SHIFT") {
      // An early "end shift": the rest of the window is not working time.
      break;
    }
  }
  if (cursor < horizon && current !== "OFF_SHIFT") pushBase(horizon, current);

  // Promptings still open at the horizon count as working until answered.
  // (Nothing to do: PROMPTING maps to working.)

  // ── Gaps: stretches inside the window where the phone recorded nothing ──
  const eventTimes = events.map((e) => Date.parse(e.at)).filter((t) => t >= checkIn && t <= horizon);
  const gaps: Interval[] = [];
  let prev = checkIn;
  for (const t of [...eventTimes, horizon]) {
    if (t - prev > gapMs) {
      gaps.push(classifyGap(prev, t, events, input.now, horizon));
    }
    prev = Math.max(prev, t);
  }

  // ── Network outages that the phone worked through (rule 3/4 evidence) ──
  const outages = networkOutages(events, checkIn, horizon);
  if (outages.length > 0) flags.add("network_outage");
  const lateUploads = events.some(
    (e) => e.receivedAt && Date.parse(e.receivedAt) - Date.parse(e.at) > 10 * 60_000,
  );
  if (lateUploads) flags.add("network_outage");

  // Gaps replace whatever the base line said about that time.
  let timeline = overlay(base, gaps);

  // ── Technical corroboration (rules 6 / 7) ──
  timeline = timeline.map((iv) => {
    if (iv.cls !== "technical" || iv.rule !== 0) return iv;
    const corroboration = corroborate(iv, events, outages, input.callQuality ?? []);
    return corroboration
      ? { ...iv, rule: 6, evidence: { ...iv.evidence, corroboration } }
      : { ...iv, rule: 7, review: true };
  });

  // ── Away: unanswered presence checks (rule 10) ──
  timeline = timeline.map((iv) => (iv.cls === "away" && iv.rule === 0 ? { ...iv, rule: 10 } : iv));

  // ── Breaks: match to slots / bookings, then the flexible allowance (rules 2, 9) ──
  timeline = classifyBreaks(timeline, day, flags);

  // ── Half-day leave (rule 1) wins over everything in its half ──
  if (leaveWin) {
    timeline = overlay(timeline, [{ ...leaveWin, cls: "leave", rule: 1, review: false, evidence: {} }]);
  }

  // ── Late start - measured from when work was due, which morning leave moves ──
  const workStart = day.halfDay === "am" && leaveWin ? leaveWin.end : shiftStart;
  const workEnd = day.halfDay === "pm" && leaveWin ? leaveWin.start : shiftEnd;
  const late = checkIn > workStart + graceMs;
  const lateSeconds = late ? Math.round((checkIn - workStart) / 1000) : 0;
  if (checkIn > shiftStart) {
    const notStarted = subtract([{ start: shiftStart, end: checkIn }], leaveWin ? [leaveWin] : []);
    for (const w of notStarted) {
      if (w.end > w.start) {
        timeline.push({ ...w, cls: "not_started", rule: 0, review: false, evidence: { late } });
      }
    }
  }
  if (late) flags.add("late");

  // ── Overtime: calls after the shift ended ──
  const overtimeSeconds = input.now > shiftEnd ? callSeconds(events, shiftEnd, shiftEnd + 12 * 3_600_000) : 0;

  // ── Early leave: an explicit end of shift well before the end ──
  const endEvent = events.find((e) => e.kind === "shift_end" && Date.parse(e.at) >= checkIn);
  const endState = events.find(
    (e) => stateOf(e) === "OFF_SHIFT" && Date.parse(e.at) > checkIn && Date.parse(e.at) < shiftEnd,
  );
  const earlyAt = [endEvent, endState]
    .map((e) => (e ? Date.parse(e.at) : Infinity))
    .reduce((a, b) => Math.min(a, b), Infinity);
  if (earlyAt < workEnd - 15 * 60_000 && earlyAt <= input.now) {
    flags.add("early_leave");
    timeline = overlay(timeline, [
      { start: earlyAt, end: Math.min(workEnd, input.now), cls: "away", rule: 10, review: false, evidence: { endedShiftEarly: true } },
    ]);
  }

  // ── Responding but not dialling ──
  if (respondingNotDialing(events, checkIn, horizon)) flags.add("responding_not_dialing");

  const segments = finalise(timeline, input.overrides);

  // ── Totals ──
  const sum = (classes: SegmentClass[]) =>
    Math.round(
      segments
        .filter((s) => classes.includes(s.class))
        .reduce((acc, s) => acc + (Date.parse(s.endsAt) - Date.parse(s.startsAt)), 0) / 1000,
    );
  const excusedOf = (cls: SegmentClass) =>
    Math.round(
      segments
        .filter((s) => s.class === cls && s.overrideClass === "excused")
        .reduce((acc, s) => acc + (Date.parse(s.endsAt) - Date.parse(s.startsAt)), 0) / 1000,
    );

  const lastActivity = events
    .filter((e) => e.kind !== "heartbeat" && Date.parse(e.at) >= checkIn)
    .map((e) => Date.parse(e.at))
    .reduce((a, b) => Math.max(a, b), checkIn);
  const checkOut =
    input.now >= shiftEnd || endEvent ? Math.min(Math.max(lastActivity, checkIn), endEvent ? Date.parse(endEvent.at) : Infinity) : null;

  const bookedBreakSeconds = Math.round(
    day.breaks.reduce((acc, b) => acc + (Date.parse(b.endsAt) - Date.parse(b.startsAt)), 0) / 1000,
  );

  let status: AttendanceDayStatus = late ? "late" : "present";
  if (day.halfDay) status = "half_day";

  return {
    status,
    shiftStartAt: day.shiftStart,
    shiftEndAt: day.shiftEnd,
    checkInAt: iso(checkIn),
    checkOutAt: checkOut !== null && Number.isFinite(checkOut) ? iso(checkOut) : null,
    workedSeconds: sum(["working"]),
    breakSeconds: sum(["break", "break_overrun", "unscheduled_break"]),
    bookedBreakSeconds,
    technicalSeconds: sum(["technical"]),
    awaySeconds: Math.max(0, sum(["away"]) - excusedOf("away")),
    unknownSeconds: Math.max(0, sum(["unknown"]) - excusedOf("unknown")),
    lateSeconds,
    overtimeSeconds,
    reviewCount: segments.filter((s) => s.needsReview && !s.overrideClass).length,
    flags: [...flags].sort(),
    segments,
  };
}

/** Why the phone recorded nothing between `start` and `end` (rules 5, 8, 11). */
function classifyGap(start: number, end: number, events: ClassifierEvent[], now: number, horizon: number): Interval {
  const before = [...events].reverse().find((e) => Date.parse(e.at) <= start);
  const after = events.find((e) => Date.parse(e.at) >= end);
  const battery = [...events]
    .reverse()
    .find((e) => Date.parse(e.at) <= start && typeof e.payload?.batteryPct === "number");
  const lowBattery = typeof battery?.payload?.batteryPct === "number" && (battery.payload.batteryPct as number) <= 3;
  const afterIsBoot = after?.kind === "boot";
  const afterIsRestart = after?.kind === "app_start" || after?.kind === "service_start";
  const ongoing = !after && end >= horizon && horizon >= now - 1000;

  if (lowBattery && (afterIsBoot || ongoing)) {
    return { start, end, cls: "technical", rule: 5, review: false, evidence: { batteryPct: battery!.payload!.batteryPct } };
  }
  if (afterIsBoot || afterIsRestart) {
    return {
      start,
      end,
      cls: "technical",
      rule: 8,
      review: true,
      evidence: { cameBackWith: after!.kind, lastBefore: before?.kind ?? null },
    };
  }
  return { start, end, cls: "unknown", rule: 11, review: !ongoing, evidence: { ongoing } };
}

function networkOutages(events: ClassifierEvent[], from: number, to: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let lostAt: number | null = null;
  for (const e of events) {
    const t = Date.parse(e.at);
    if (e.kind === "network_lost" && lostAt === null) lostAt = t;
    if (e.kind === "network_restored" && lostAt !== null) {
      if (t > from && lostAt < to) out.push({ start: Math.max(lostAt, from), end: Math.min(t, to) });
      lostAt = null;
    }
  }
  if (lostAt !== null && lostAt < to) out.push({ start: Math.max(lostAt, from), end: to });
  return out;
}

function corroborate(
  iv: Interval,
  events: ClassifierEvent[],
  outages: { start: number; end: number }[],
  quality: CallQualityRecord[],
): string | null {
  const from = iv.start - 10 * 60_000;
  const to = iv.end;
  if (outages.some((o) => o.start < to && o.end > from)) return "network_lost";
  const failed = events.filter((e) => {
    const t = Date.parse(e.at);
    const d = e.payload?.durationS;
    return e.kind === "call_end" && t >= from && t <= to && typeof d === "number" && d < FAILED_CALL_SECONDS;
  });
  if (failed.length >= 2) return "calls_failing";
  const bad = quality.some((q) => {
    const s = Date.parse(q.startedAt);
    return s >= from && s <= to && (q.zeroSignal || q.longestDeadAirSeconds > DEAD_AIR_FAULT_SECONDS);
  });
  if (bad) return "dead_air_in_recording";
  return null;
}

function classifyBreaks(timeline: Interval[], day: ResolvedDay, flags: Set<AttendanceFlag>): Interval[] {
  const allowanceMs = day.breakAllowanceMinutes * 60_000;
  const slotTotal = day.breaks.reduce((a, b) => a + (Date.parse(b.endsAt) - Date.parse(b.startsAt)), 0);
  let flexibleLeft = Math.max(0, allowanceMs - slotTotal);
  const used = new Set<number>();
  const out: Interval[] = [];

  for (const iv of timeline) {
    if (iv.cls !== "break" || iv.rule !== 0) {
      out.push(iv);
      continue;
    }
    // A slot this break belongs to: overlapping it, or starting within the deferral tolerance after it.
    const idx = day.breaks.findIndex((b, i) => {
      if (used.has(i)) return false;
      const s = Date.parse(b.startsAt);
      const e = Date.parse(b.endsAt);
      return (iv.start < e && iv.end > s) || (iv.start >= s && iv.start <= s + BREAK_DEFERRAL_TOLERANCE_MINUTES * 60_000);
    });
    if (idx >= 0) {
      used.add(idx);
      const b = day.breaks[idx]!;
      const allowed = Date.parse(b.endsAt) - Date.parse(b.startsAt) + BREAK_OVERRUN_GRACE_MINUTES * 60_000;
      const deferredMs = Math.max(0, iv.start - Date.parse(b.startsAt));
      const cut = iv.start + allowed;
      if (iv.end <= cut) {
        out.push({ ...iv, rule: 2, evidence: { slot: b.label, deferredSeconds: Math.round(deferredMs / 1000) } });
      } else {
        out.push({ ...iv, end: cut, rule: 2, evidence: { slot: b.label, deferredSeconds: Math.round(deferredMs / 1000) } });
        out.push({ ...iv, start: cut, cls: "break_overrun", rule: 2, evidence: { slot: b.label } });
        flags.add("break_overrun");
      }
      continue;
    }
    // No slot: spend the flexible allowance, then it is unscheduled (rule 9).
    const length = iv.end - iv.start;
    if (length <= flexibleLeft) {
      flexibleLeft -= length;
      out.push({ ...iv, rule: 2, evidence: { flexible: true } });
    } else {
      if (flexibleLeft > 0) {
        out.push({ ...iv, end: iv.start + flexibleLeft, rule: 2, evidence: { flexible: true } });
      }
      out.push({ ...iv, start: iv.start + flexibleLeft, cls: "unscheduled_break", rule: 9, review: true });
      flexibleLeft = 0;
      flags.add("unscheduled_break");
    }
  }
  return out;
}

function respondingNotDialing(events: ClassifierEvent[], from: number, to: number): boolean {
  let run = 0;
  for (const e of events) {
    const t = Date.parse(e.at);
    if (t < from || t > to) continue;
    if (e.kind === "call_start") run = 0;
    if (e.kind === "prompt_answered" && e.payload?.answer === "here") {
      run += 1;
      if (run >= RESPONDING_NOT_DIALING_COUNT) return true;
    }
  }
  return false;
}

/** Seconds of calls that ended between `from` and `to`, from call_end durations. */
function callSeconds(events: ClassifierEvent[], from: number, to: number): number {
  return events
    .filter((e) => e.kind === "call_end")
    .filter((e) => {
      const t = Date.parse(e.at);
      return t >= from && t <= to;
    })
    .reduce((acc, e) => acc + (typeof e.payload?.durationS === "number" ? (e.payload.durationS as number) : 0), 0);
}

/** `base` with `top` laid over it: wherever a top interval exists, it wins. */
function overlay(base: Interval[], top: Interval[]): Interval[] {
  if (top.length === 0) return base;
  const out: Interval[] = [];
  for (const b of base) {
    for (const piece of subtract([{ start: b.start, end: b.end }], top)) {
      if (piece.end > piece.start) out.push({ ...b, start: piece.start, end: piece.end });
    }
  }
  return [...out, ...top].sort((a, b) => a.start - b.start);
}

function subtract(
  from: { start: number; end: number }[],
  minus: { start: number; end: number }[],
): { start: number; end: number }[] {
  let pieces = from;
  for (const m of minus) {
    const next: { start: number; end: number }[] = [];
    for (const p of pieces) {
      if (m.end <= p.start || m.start >= p.end) {
        next.push(p);
        continue;
      }
      if (m.start > p.start) next.push({ start: p.start, end: m.start });
      if (m.end < p.end) next.push({ start: m.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

/** Sort, merge touching intervals of the same kind, apply overrides. */
function finalise(intervals: Interval[], overrides: OverrideRecord[] = []): ClassifiedSegment[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.end >= iv.start &&
      last.cls === iv.cls &&
      last.rule === iv.rule &&
      last.review === iv.review &&
      JSON.stringify(last.evidence) === JSON.stringify(iv.evidence)
    ) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ ...iv });
    }
  }
  return merged.map((iv) => {
    const o = overrides.find((ov) => Date.parse(ov.startsAt) < iv.end && Date.parse(ov.endsAt) > iv.start);
    return {
      startsAt: iso(iv.start),
      endsAt: iso(iv.end),
      class: iv.cls,
      rule: iv.rule,
      needsReview: iv.review,
      evidence: iv.evidence,
      ...(o ? { overrideClass: o.overrideClass, overrideId: o.id } : {}),
    };
  });
}

// ── Live board helpers ──────────────────────────────────────────────────────

export type LiveBoardState = HandsetState | "OFFLINE" | "ON_LEAVE" | "NOT_STARTED" | "NO_HANDSET";

/**
 * What the Today board shows for one person. A phone that has not posted for
 * two heartbeats is OFFLINE whatever its last state said.
 */
export function liveBoardState(input: {
  day: ResolvedDay;
  live: { state: HandsetState; lastReceivedAt: string } | null;
  hasHandset: boolean;
  now: number;
}): LiveBoardState {
  if (input.day.kind === "leave") return "ON_LEAVE";
  if (!input.hasHandset) return "NO_HANDSET";
  if (!input.live) return input.day.kind === "work" ? "NOT_STARTED" : "OFF_SHIFT";
  if (input.now - Date.parse(input.live.lastReceivedAt) > ATTENDANCE_GAP_SECONDS * 1000) {
    const inShift =
      input.day.kind === "work" &&
      input.day.shiftStart &&
      input.day.shiftEnd &&
      input.now >= Date.parse(input.day.shiftStart) &&
      input.now <= Date.parse(input.day.shiftEnd);
    return inShift ? "OFFLINE" : "OFF_SHIFT";
  }
  return input.live.state;
}

export const LIVE_BOARD_LABELS: Record<LiveBoardState, string> = {
  ...HANDSET_STATE_LABELS,
  OFFLINE: "Offline",
  ON_LEAVE: "On leave",
  NOT_STARTED: "Not started",
  NO_HANDSET: "No handset",
};

// ── Threshold suggestion (doc 33 §12 Q4) ────────────────────────────────────

/**
 * A silence threshold suggested from a telecaller's own p90 gap between calls,
 * clamped to 5-20 minutes and never above the pattern's value.
 */
export function suggestSilenceThreshold(p90GapSeconds: number | null, patternMinutes: number): number {
  if (p90GapSeconds === null || !Number.isFinite(p90GapSeconds)) return patternMinutes;
  const suggested = Math.min(20, Math.max(5, Math.ceil(p90GapSeconds / 60)));
  return Math.min(suggested, patternMinutes);
}

// ── WhatsApp alert text (doc 33 §6.4) ───────────────────────────────────────

/**
 * The approver's WhatsApp message. Never carries the telecaller's reason: a
 * sick-leave reason is a health detail and does not belong in a chat app.
 */
export function attendanceAlertText(input: {
  reason: "new_request" | "escalation";
  telecallerName: string;
  kind: RequestKind;
  leaveType?: LeaveType | null;
  startDate?: string | null;
  endDate?: string | null;
  halfDay?: HalfDay | null;
  startsAt?: string | null;
  endsAt?: string | null;
  zone: string;
  link: string;
}): string {
  const what = describeRequest(input);
  const head =
    input.reason === "escalation"
      ? `Still waiting: ${input.kind === "leave" ? "leave" : "a"} request from ${input.telecallerName}`
      : `${input.kind === "leave" ? "Leave" : input.kind === "break" ? "Break" : "Hours change"} request from ${input.telecallerName}`;
  return `${head}: ${what}. Waiting for your decision: ${input.link}`;
}

export function describeRequest(input: {
  kind: RequestKind;
  leaveType?: LeaveType | null;
  startDate?: string | null;
  endDate?: string | null;
  halfDay?: HalfDay | null;
  startsAt?: string | null;
  endsAt?: string | null;
  zone: string;
}): string {
  if (input.kind === "leave" && input.startDate && input.endDate) {
    const type = input.leaveType ? LEAVE_TYPE_LABELS[input.leaveType].toLowerCase() : "leave";
    if (input.halfDay) {
      return `${type}, ${shortDate(input.startDate)} ${input.halfDay === "am" ? "morning" : "afternoon"}`;
    }
    const days = dateSpanDays(input.startDate, input.endDate);
    return input.startDate === input.endDate
      ? `${type}, ${shortDate(input.startDate)}`
      : `${type}, ${shortDate(input.startDate)} - ${shortDate(input.endDate)} (${days} days)`;
  }
  if (input.startsAt && input.endsAt) {
    const zone = resolveTimeZone(input.zone);
    const s = zonedParts(input.startsAt, zone)!;
    const e = zonedParts(input.endsAt, zone)!;
    const date = `${s.year}-${String(s.month).padStart(2, "0")}-${String(s.day).padStart(2, "0")}`;
    return `${shortDate(date)}, ${clock12(s.hour, s.minute)} - ${clock12(e.hour, e.minute)}`;
  }
  return input.kind;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(dateKey: string): string {
  const [, m, d] = dateKey.split("-").map(Number);
  return `${d} ${MONTHS[m! - 1]}`;
}

function clock12(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}
