import type { ConsoleState } from "@aura/ui";
import {
  type AttendanceDayStatus,
  type AttendanceFlag,
  type LeaveType,
  type LiveBoardState,
  type RequestKind,
  type RequestStatus,
  type SegmentClass,
  DAY_STATUS_LABELS,
  FLAG_LABELS,
  LIVE_BOARD_LABELS,
  RULE_LABELS,
  SEGMENT_CLASS_LABELS,
} from "@aura/shared";

/**
 * The console's side of the attendance module (Build docs/33 §7): the shapes
 * `GET /v1/owner/attendance/*` returns, and the pure helpers both pages use to
 * print them.
 *
 * Pure and React-free on purpose, like notification-kinds.ts, so the rules for
 * "which colour is this state" and "what does this evidence mean in words" are
 * unit-tested rather than eyeballed. The labels themselves come from
 * @aura/shared, which the handset prints too - one word per state on both.
 */

// ── API shapes (JSON camelCase; the server sends null for absent values) ─────

export interface AttendanceChannel {
  id: string;
  label: string;
  provider: string;
  /** False while Meta has not approved `attendance_request_alert`; such a channel cannot be picked. */
  templateApproved: boolean | null;
  /**
   * False while Meta has not approved `attendance_absence_alert` (0143).
   * Reported only - unlike `templateApproved` this never blocks the channel,
   * because a workspace without it still gets absence alerts in the console.
   */
  absenceTemplateApproved: boolean | null;
}

export interface AttendanceSettings {
  enabled: boolean;
  leaveEscalationHours: number;
  whatsappAlerts: boolean;
  whatsappChannelId: string | null;
  timeZone: string;
  /** Owners only (doc 33 §6.4): a manager may see the WhatsApp toggle, not change it. */
  canEditWhatsapp: boolean;
  channels: AttendanceChannel[];
  approversWithoutWhatsapp: { membershipId: string; name: string }[];
  /** The shift-not-started wording (0143). Null = the workspace has never set one. */
  absentMessage: string | null;
  /** What null renders as, so the editor can show it as a placeholder. */
  absentMessageDefault: string;
}

export interface BreakSlot {
  label: string;
  startTime: string;
  durationMinutes: number;
}

export interface ShiftPattern {
  id: string;
  name: string;
  /** ISO weekdays, 1 = Monday. */
  workDays: number[];
  startTime: string;
  endTime: string;
  graceMinutes: number;
  breakAllowanceMinutes: number;
  silenceThresholdMinutes: number;
  promptTimeoutMinutes: number;
  breaks: BreakSlot[];
  assignedCount: number;
}

export interface AttendancePerson {
  telecallerId: string;
  name: string;
  shiftPatternId: string | null;
  shiftPatternName: string | null;
  reportsToMembershipId: string | null;
  reportsToName: string | null;
  appLeaveRequests: boolean;
  appBreakBooking: boolean;
  device: { id: string; label: string | null; appVersionCode: number | null; lastSeenAt: string | null } | null;
  needsAppUpdate: boolean;
  suggestedSilenceMinutes: number | null;
}

export interface Approver {
  membershipId: string;
  name: string;
  ownerRole: string | null;
  hasWhatsapp: boolean;
}

export interface PeopleResponse {
  people: AttendancePerson[];
  approvers: Approver[];
}

export interface AttendanceException {
  id: string;
  telecallerId: string | null;
  telecallerName: string | null;
  onDate: string;
  kind: "holiday" | "day_off" | "custom_hours";
  label: string | null;
  startTime: string | null;
  endTime: string | null;
}

export interface TodayRow {
  telecallerId: string;
  name: string;
  liveState: LiveBoardState;
  stateSince: string | null;
  dayKind: "work" | "off" | "holiday" | "leave" | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  workedSeconds: number | null;
  breakSeconds: number | null;
  technicalSeconds: number | null;
  awaySeconds: number | null;
  flags: AttendanceFlag[] | null;
  batteryPct: number | null;
  networkOk: boolean | null;
  pendingRequests: number | null;
}

export interface TodayResponse {
  date: string;
  timeZone: string;
  rows: TodayRow[];
  unassignedHandsets: number;
}

export interface TimesheetRow {
  telecallerId: string;
  name: string;
  workDate: string;
  status: AttendanceDayStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedSeconds: number | null;
  breakSeconds: number | null;
  bookedBreakSeconds: number | null;
  technicalSeconds: number | null;
  awaySeconds: number | null;
  unknownSeconds: number | null;
  lateSeconds: number | null;
  overtimeSeconds: number | null;
  reviewCount: number | null;
  flags: AttendanceFlag[] | null;
}

export interface TimesheetsResponse {
  from: string;
  to: string;
  rows: TimesheetRow[];
}

export interface DaySegment {
  id: string;
  startsAt: string;
  endsAt: string;
  class: SegmentClass;
  rule: number;
  ruleLabel: string | null;
  needsReview: boolean;
  evidence: Record<string, unknown> | null;
  overrideClass: "excused" | "unexcused" | null;
  overrideNote: string | null;
}

export interface DayResponse {
  day: {
    date: string;
    kind: "work" | "off" | "holiday" | "leave";
    label?: string | null;
    shiftStart?: string | null;
    shiftEnd?: string | null;
    halfDay?: "am" | "pm" | null;
    breaks: { label: string; startsAt: string; endsAt: string; source: "slot" | "booked" }[];
  };
  summary: (Partial<TimesheetRow> & { status?: AttendanceDayStatus }) | null;
  segments: DaySegment[];
}

export interface AttendanceRequest {
  id: string;
  telecallerId: string;
  telecallerName: string;
  kind: RequestKind;
  leaveType: LeaveType | null;
  startDate: string | null;
  endDate: string | null;
  halfDay: "am" | "pm" | null;
  startsAt: string | null;
  endsAt: string | null;
  reason: string | null;
  status: RequestStatus;
  source: string | null;
  approverMembershipId: string | null;
  approverName: string | null;
  escalatedAt: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  canDecide: boolean;
  whatsapp: { status: string; lastError: string | null } | null;
}

export interface ReviewSegment {
  id: string;
  telecallerId: string;
  telecallerName: string;
  workDate: string;
  startsAt: string;
  endsAt: string;
  class: SegmentClass;
  rule: number;
  ruleLabel: string | null;
  evidence: Record<string, unknown> | null;
}

// ── Tabs ────────────────────────────────────────────────────────────────────

export const ATTENDANCE_TABS = [
  { key: "today", label: "Today" },
  { key: "timesheets", label: "Timesheets" },
  { key: "requests", label: "Requests" },
  { key: "review", label: "Review" },
] as const;

export type AttendanceTab = (typeof ATTENDANCE_TABS)[number]["key"];

/**
 * The tabs a persona is offered. A telecaller sees their own day, timesheet
 * and requests (doc 33 §7.1) - Review is deciding what somebody ELSE's time
 * was, which is the manager's call.
 */
export function attendanceTabsFor(role: string): (typeof ATTENDANCE_TABS)[number][] {
  return ATTENDANCE_TABS.filter((t) => t.key !== "review" || role === "owner" || role === "manager");
}

/** `?tab=` read forgivingly: anything unknown, or not offered to this persona, is Today. */
export function resolveAttendanceTab(raw: string | string[] | undefined, role: string): AttendanceTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return attendanceTabsFor(role).find((t) => t.key === value)?.key ?? "today";
}

export const REQUEST_FILTERS = [
  { key: "mine", label: "Waiting for me" },
  { key: "pending", label: "All pending" },
  { key: "escalated", label: "Escalated" },
  { key: "decided", label: "Decided" },
] as const;

export type RequestFilter = (typeof REQUEST_FILTERS)[number]["key"];

/** A telecaller's own requests, which nobody on their side decides. */
export const OWN_REQUEST_FILTERS = [
  { key: "pending", label: "Pending" },
  { key: "decided", label: "Decided" },
  { key: "all", label: "All" },
] as const;

export type OwnRequestFilter = (typeof OWN_REQUEST_FILTERS)[number]["key"];

/** The query string `GET requests` takes for a filter chip. */
export function requestQuery(filter: RequestFilter | OwnRequestFilter): string {
  switch (filter) {
    case "mine":
      return "status=pending&mine=1";
    case "escalated":
      return "status=pending&escalated=1";
    case "decided":
      return "status=decided";
    case "all":
      return "status=all";
    default:
      return "status=pending";
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Seconds as h:mm - "7:05", "0:40". Null is "-", never "0:00": a duration the
 * API did not measure is not a duration of nothing (the productivity page's
 * rule, for the same reason).
 */
export function hmm(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "-";
  const total = Math.max(0, Math.round(seconds / 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "09:30:00" or "09:30" as "09:30" - Postgres `time` round-trips with seconds. */
export function wall(time: string | null | undefined): string {
  return time ? time.slice(0, 5) : "";
}

function minutesOf(time: string): number {
  const [h, m] = wall(time).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** A shift that ends at or before it starts crosses midnight. */
export function isNightShift(startTime: string, endTime: string): boolean {
  if (!startTime || !endTime) return false;
  return minutesOf(endTime) <= minutesOf(startTime);
}

const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** [1,2,3,4,5] as "Mon-Fri"; anything irregular as a list. */
export function describeWorkDays(days: readonly number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (sorted.length === 0) return "No days";
  if (sorted.length === 7) return "Every day";
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  if (contiguous && sorted.length >= 3) {
    return `${WEEKDAY_SHORT[sorted[0]! - 1]}-${WEEKDAY_SHORT[sorted[sorted.length - 1]! - 1]}`;
  }
  return sorted.map((d) => WEEKDAY_SHORT[d - 1]).join(", ");
}

export const WEEKDAYS = WEEKDAY_SHORT.map((label, i) => ({ day: i + 1, label }));

/** The label for a live state, with anything newer than this console printed as itself. */
export function liveStateLabel(state: string): string {
  return LIVE_BOARD_LABELS[state as LiveBoardState] ?? state;
}

export function dayStatusLabel(status: string): string {
  return DAY_STATUS_LABELS[status as AttendanceDayStatus] ?? status;
}

export function flagLabel(flag: string): string {
  return FLAG_LABELS[flag as AttendanceFlag] ?? flag;
}

export function segmentClassLabel(cls: string): string {
  return SEGMENT_CLASS_LABELS[cls as SegmentClass] ?? cls;
}

/** The API's rule label when it sent one, else the shared catalogue's. */
export function ruleLabel(rule: number, fromApi?: string | null): string {
  return fromApi || RULE_LABELS[rule] || `Rule ${rule}`;
}

// ── Colour (packages/ui/src/state.tsx is the rule) ───────────────────────────

/**
 * Which of the console's four state hues a live state takes.
 *
 * Red is MISSED here, so it goes to the one state that means a person is not
 * there: Away (a presence check went unanswered). Orange is "the system failed
 * at something", which is what Technical and Offline are - the phone, the
 * network or the app, not the person. Green is a conversation happening, so
 * only In call. Everything else - active, on break, off shift, on leave - is
 * a fact, not an alarm, and stays grey.
 */
export function liveStateTone(state: string): ConsoleState {
  switch (state) {
    case "IN_CALL":
      return "answered";
    case "AWAY":
      return "missed";
    case "TECHNICAL":
    case "OFFLINE":
      return "error";
    default:
      return "neutral";
  }
}

/** Absent is the one day status that is a miss; the rest are facts about the day. */
export function dayStatusTone(status: string): ConsoleState {
  return status === "absent" ? "missed" : "neutral";
}

/**
 * The fill for one stretch of the day timeline. Chart marks, so they come
 * from STATE_TONE's `mark` family (see state.tsx on why those differ from
 * `dot`) - resolved by the caller, which holds the kit import.
 */
export function segmentTone(cls: string): ConsoleState {
  switch (cls) {
    case "working":
    case "overtime":
      return "answered";
    case "away":
    case "absent":
    case "break_overrun":
    case "unscheduled_break":
      return "missed";
    case "technical":
      return "error";
    default:
      return "neutral";
  }
}

// ── Evidence in plain words ─────────────────────────────────────────────────

const TECHNICAL_REASONS: Record<string, string> = {
  no_signal: "no signal",
  calls_failing: "calls failing",
  headset_or_mic: "headset or microphone problem",
  phone_slow: "phone running slowly",
  other: "another problem",
};

const CORROBORATION: Record<string, string> = {
  network_lost: "the phone lost its network at the time",
  calls_failing: "calls were failing in the same stretch",
  dead_air_in_recording: "a call recording from the time has dead air",
};

const CAME_BACK_WITH: Record<string, string> = {
  boot: "the phone restarted",
  app_start: "the app was restarted",
  service_start: "the recording service restarted",
};

/**
 * What the classifier recorded about a stretch, as sentences a manager can act
 * on - never the raw JSON. Keys this console does not know are still shown,
 * plainly, rather than hidden: evidence that disappears is worse than
 * evidence that reads a little technically.
 */
export function describeEvidence(evidence: Record<string, unknown> | null | undefined): string[] {
  if (!evidence) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (value === null || value === undefined || value === false) continue;
    switch (key) {
      case "reason":
        out.push(`Reported: ${TECHNICAL_REASONS[String(value)] ?? String(value)}`);
        break;
      case "corroboration":
        out.push(`Backed up: ${CORROBORATION[String(value)] ?? String(value)}`);
        break;
      case "batteryPct":
        out.push(`Battery was at ${String(value)}% before the phone went quiet`);
        break;
      case "cameBackWith":
        out.push(`Came back when ${CAME_BACK_WITH[String(value)] ?? String(value)}`);
        break;
      case "lastBefore":
        out.push(`Last thing recorded before: ${String(value).replace(/_/g, " ")}`);
        break;
      case "ongoing":
        out.push("Still going on - the phone has not been heard from since");
        break;
      case "slot":
        out.push(`Scheduled break: ${String(value)}`);
        break;
      case "deferredSeconds": {
        const minutes = Math.round(Number(value) / 60);
        if (minutes > 0) out.push(`Started ${minutes} min after its slot (a call ran on)`);
        break;
      }
      case "flexible":
        out.push("Taken from the flexible break allowance");
        break;
      case "late":
        out.push("Counted as a late start");
        break;
      case "endedShiftEarly":
        out.push("The shift was ended early on the phone");
        break;
      default:
        out.push(`${key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}: ${String(value)}`);
    }
  }
  return out;
}

/** Where a timeline bar's stretch sits, as percentages of the window. Clamped, so an edge never spills. */
export function barGeometry(
  startsAt: string,
  endsAt: string,
  windowStart: number,
  windowEnd: number,
): { left: number; width: number } | null {
  const span = windowEnd - windowStart;
  if (!(span > 0)) return null;
  const s = Math.max(Date.parse(startsAt), windowStart);
  const e = Math.min(Date.parse(endsAt), windowEnd);
  if (!(e > s)) return null;
  return { left: ((s - windowStart) / span) * 100, width: ((e - s) / span) * 100 };
}

/**
 * The window a day's timeline is drawn over: the shift, widened to take in any
 * stretch outside it (an early start, overtime). Null when there is nothing to draw.
 */
export function timelineWindow(
  shiftStart: string | null | undefined,
  shiftEnd: string | null | undefined,
  segments: readonly { startsAt: string; endsAt: string }[],
): { start: number; end: number } | null {
  const points = [
    ...(shiftStart ? [Date.parse(shiftStart)] : []),
    ...(shiftEnd ? [Date.parse(shiftEnd)] : []),
    ...segments.flatMap((s) => [Date.parse(s.startsAt), Date.parse(s.endsAt)]),
  ].filter((n) => Number.isFinite(n));
  if (points.length < 2) return null;
  const start = Math.min(...points);
  const end = Math.max(...points);
  return end > start ? { start, end } : null;
}

// ── Zod issues ──────────────────────────────────────────────────────────────

/**
 * A zod error as `{ field: message }`, keyed by the first path segment -
 * `breaks.0.label` lands on `breaks` - so a form can put each message beside
 * the field it is about. The first message per field wins.
 */
export function issuesByField(issues: readonly { path: readonly PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
