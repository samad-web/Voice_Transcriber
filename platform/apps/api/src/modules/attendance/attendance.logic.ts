import {
  ATTENDANCE_HEARTBEAT_SECONDS,
  ATTENDANCE_MIN_VERSION_CODE,
  ATTENDANCE_NOTICE_TEXT,
  ATTENDANCE_NOTICE_VERSION,
  type DeviceAttendanceConfig,
  type ResolvedDay,
  shiftDateKey,
  toDeviceScheduleDay,
} from "@aura/shared";

/**
 * Pure pieces of the attendance API (doc 33, migration 0140) - everything that
 * decides a shape or a number without touching the database, so the specs can
 * pin it.
 */

/**
 * The handset's versionCode, from `devices.app_version`.
 *
 * GET /devices/me/update is the only writer of that column and it stores
 * `String(versionCode)` (devices.controller.ts). Anything that is not a bare
 * integer - a versionName some future writer puts there - reads as unknown
 * rather than being mis-parsed ("1.2.0" must not become 1).
 */
export function versionCodeOf(appVersion: string | null | undefined): number | null {
  if (!appVersion || !/^\d{1,9}$/.test(appVersion.trim())) return null;
  return Number(appVersion.trim());
}

/** Whether a handset can use the attendance block. Unknown counts as able: an old app ignores unknown keys. */
export function handsetUnderstandsAttendance(versionCode: number | null): boolean {
  return versionCode === null || versionCode >= ATTENDANCE_MIN_VERSION_CODE;
}

/** "Update the app first" on the People table: a phone we KNOW is too old, or one that never said. */
export function handsetNeedsUpdate(hasDevice: boolean, versionCode: number | null): boolean {
  return hasDevice && (versionCode === null || versionCode < ATTENDANCE_MIN_VERSION_CODE);
}

/**
 * A stable non-negative 31-bit hash (FNV-1a) - fits a Kotlin Int and a JS
 * number, and changes whenever the text does.
 */
export function stableHash31(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 1) & 0x7fffffff;
}

export interface AttendanceBlockInput {
  zone: string;
  canApplyLeave: boolean;
  canBookBreaks: boolean;
  approverName: string | null;
  /** Yesterday, today, tomorrow - resolved. */
  yesterday: ResolvedDay;
  today: ResolvedDay;
  tomorrow: ResolvedDay;
  now: number;
}

/**
 * The `attendance` block of GET /devices/me/config.
 *
 * `days` is today and tomorrow - plus YESTERDAY at the front while its shift is
 * still running, because a night shift belongs to the day it starts (doc 33
 * §6.2) and a phone at 01:00 inside a 22:00-06:00 shift must know it is on
 * shift. Every entry carries its own `date`.
 *
 * `scheduleVersion` is a hash of everything else in the block, so it moves
 * exactly when something the phone would act on moves - a pattern edit, an
 * exception, a decided request, a switch, a new approver - and never
 * otherwise. The timings come from today's resolved day.
 */
export function buildAttendanceBlock(input: AttendanceBlockInput): DeviceAttendanceConfig {
  const days = [input.today, input.tomorrow];
  const y = input.yesterday;
  if (y.kind === "work" && y.shiftEnd && Date.parse(y.shiftEnd) > input.now) days.unshift(y);

  const body = {
    enabled: true as const,
    canApplyLeave: input.canApplyLeave,
    canBookBreaks: input.canBookBreaks,
    ...(input.approverName ? { approverName: input.approverName } : {}),
    heartbeatSeconds: ATTENDANCE_HEARTBEAT_SECONDS,
    silenceThresholdMinutes: input.today.silenceThresholdMinutes,
    promptTimeoutMinutes: input.today.promptTimeoutMinutes,
    graceMinutes: input.today.graceMinutes,
    breakAllowanceMinutes: input.today.breakAllowanceMinutes,
    timeZone: input.zone,
    days: days.map(toDeviceScheduleDay),
    noticeVersion: ATTENDANCE_NOTICE_VERSION,
    noticeText: ATTENDANCE_NOTICE_TEXT,
  };
  return { ...body, scheduleVersion: stableHash31(JSON.stringify(body)) };
}

// ── Request views ───────────────────────────────────────────────────────────

export interface RequestRow {
  id: string;
  telecaller_id: string;
  telecaller_name: string | null;
  kind: string;
  leave_type: string | null;
  start_date: string | null;
  end_date: string | null;
  half_day: string | null;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  reason: string | null;
  status: string;
  source: string;
  approver_membership_id: string | null;
  approver_name: string | null;
  escalated_at: Date | string | null;
  created_at: Date | string;
  decided_at: Date | string | null;
  decided_by_name: string | null;
  decision_note: string | null;
}

/** Shared SELECT for a request with its names; callers add WHERE/ORDER. */
export const REQUEST_SELECT = `
  SELECT r.id, r.telecaller_id, t.display_name AS telecaller_name, r.kind, r.leave_type,
         r.start_date::text AS start_date, r.end_date::text AS end_date, r.half_day,
         r.starts_at, r.ends_at, r.reason, r.status, r.source, r.approver_membership_id,
         NULLIF(btrim(COALESCE(au.name, '')), '') AS approver_name,
         r.escalated_at, r.created_at, r.decided_at,
         NULLIF(btrim(COALESCE(du.name, '')), '') AS decided_by_name, r.decision_note
    FROM attendance_requests r
    JOIN telecallers t ON t.id = r.telecaller_id
    LEFT JOIN memberships am ON am.id = r.approver_membership_id
    LEFT JOIN users au ON au.id = am.user_id
    LEFT JOIN users du ON du.id = r.decided_by`;

export const isoOrNull = (v: Date | string | null | undefined): string | null =>
  v === null || v === undefined ? null : new Date(v).toISOString();

/**
 * The handset's view of a request. Optional keys are OMITTED, never null -
 * Android's optString turns a JSON null into the string "null".
 */
export function toDeviceRequestView(r: RequestRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id,
    kind: r.kind,
    status: r.status,
    createdAt: isoOrNull(r.created_at),
  };
  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== "") out[key] = value;
  };
  put("leaveType", r.leave_type);
  put("startDate", r.start_date);
  put("endDate", r.end_date);
  put("halfDay", r.half_day);
  put("startsAt", isoOrNull(r.starts_at));
  put("endsAt", isoOrNull(r.ends_at));
  put("reason", r.reason);
  // Who it is WITH - only while there is a named approver. NULL means every
  // owner, and the phone says "With the owners" on its own.
  if (r.approver_membership_id) put("approverName", r.approver_name ?? "Your manager");
  put("decisionNote", r.decision_note);
  put("decidedAt", isoOrNull(r.decided_at));
  return out;
}

export interface WhatsappOutboxSummary {
  status: string;
  lastError: string | null;
}

/**
 * One line per request out of its outbox rows (one per recipient). The worst
 * outcome wins, because the Requests tab exists to say "WhatsApp not
 * delivered" when any recipient missed it.
 */
export function summariseWhatsapp(rows: { status: string; last_error: string | null }[]): WhatsappOutboxSummary | null {
  if (rows.length === 0) return null;
  const order = ["failed", "queued", "sent", "skipped"];
  const worst = [...rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0]!;
  return { status: worst.status, lastError: worst.last_error ?? null };
}

/** The console's view of a request. Owner responses use null for absent values. */
export function toOwnerRequestView(
  r: RequestRow,
  canDecide: boolean,
  whatsapp: WhatsappOutboxSummary | null,
): Record<string, unknown> {
  return {
    id: r.id,
    telecallerId: r.telecaller_id,
    telecallerName: r.telecaller_name,
    kind: r.kind,
    leaveType: r.leave_type,
    startDate: r.start_date,
    endDate: r.end_date,
    halfDay: r.half_day,
    startsAt: isoOrNull(r.starts_at),
    endsAt: isoOrNull(r.ends_at),
    reason: r.reason,
    status: r.status,
    source: r.source,
    approverMembershipId: r.approver_membership_id,
    approverName: r.approver_membership_id ? (r.approver_name ?? "Manager") : null,
    escalatedAt: isoOrNull(r.escalated_at),
    createdAt: isoOrNull(r.created_at),
    decidedAt: isoOrNull(r.decided_at),
    decidedByName: r.decided_by_name,
    decisionNote: r.decision_note,
    canDecide,
    whatsapp,
  };
}

// ── The WhatsApp template (doc 33 §6.4) ─────────────────────────────────────

/**
 * The WABA template a workspace must have approved in Meta before the toggle
 * can go on for a WABA channel. Aura never submits templates (see
 * messaging-channels.controller.ts syncTemplates); the owner creates it in
 * Meta's tooling, category Utility, and syncs templates in Conversations.
 *
 * Its body takes exactly three positional parameters, in this order:
 *   {{1}} the telecaller's name
 *   {{2}} what is being asked - "leave: casual, 3 Oct - 4 Oct (2 days)"
 *   {{3}} the link to the console's Requests tab
 * The worker (attendance-whatsapp.ts) fills them in that order.
 */
export const ATTENDANCE_WABA_TEMPLATE = "attendance_request_alert";
export const ATTENDANCE_WABA_TEMPLATE_PARAMS = 3;

// ── Persona scope ───────────────────────────────────────────────────────────

/** A uuid that matches no row - owner-scope.ts's sentinel, for an own-scoped persona with no telecaller identity. */
export const MATCHES_NOTHING = "00000000-0000-0000-0000-000000000000";

/**
 * The one telecaller an own-scoped persona may see, or null for "everyone".
 * Attendance rows hang off the telecaller identity exactly as calls and the
 * productivity rollup do (owner-scope.ts), so this is that rule applied to
 * the `telecallers` table itself, whose key is `id` rather than
 * `telecaller_id`.
 */
export function ownTelecallerOnly(scope: { scope: "all" | "own"; telecallerId: string | null }): string | null {
  if (scope.scope !== "own") return null;
  return scope.telecallerId ?? MATCHES_NOTHING;
}

/** snake_case row keys to camelCase, for returning an attendance_days row as-is. */
export function camelRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

// ── Dates and CSV ───────────────────────────────────────────────────────────

/** Days in an inclusive date range. */
export function rangeDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Every date a leave covers, capped (the input schema allows 60). */
export function leaveDates(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  for (let d = startDate; d <= endDate && out.length < 62; d = shiftDateKey(d, 1)) out.push(d);
  return out;
}

/**
 * One CSV cell. Quoted when it must be, and a leading = + - @ is defused with a
 * quote mark: a telecaller's name is user input, and a spreadsheet that runs
 * `=HYPERLINK(...)` from a timesheet export is a formula-injection hole.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = Array.isArray(value) ? value.join(" ") : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
