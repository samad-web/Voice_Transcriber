import {
  type ApproverCandidate,
  type DeviceAttendanceConfig,
  resolveApprover,
  resolveTimeZone,
  shiftDateKey,
  todayIn,
} from "@aura/shared";
import { loadScheduleBook, type Queryable, type ScheduleBook } from "./attendance-schedule";
import { buildAttendanceBlock, handsetUnderstandsAttendance, versionCodeOf } from "./attendance.logic";

/**
 * Who a handset is, for attendance purposes, in one read.
 *
 * `telecaller` is null when the device is bound to nobody or to an archived
 * telecaller - such a phone gets no attendance block and its presence events
 * are dropped (a phone may lag one config refresh behind an unbinding).
 */
export interface DeviceAttendanceContext {
  deviceStatus: string;
  enabled: boolean;
  zone: string;
  leaveEscalationHours: number;
  whatsappAlerts: boolean;
  versionCode: number | null;
  telecaller: {
    id: string;
    name: string;
    appLeaveRequests: boolean;
    appBreakBooking: boolean;
    reportsTo: ApproverCandidate | null;
    /** The resolved approver's membership id, or null = every owner. */
    approverMembershipId: string | null;
    approverName: string | null;
  } | null;
}

export async function loadDeviceAttendanceContext(
  client: Queryable,
  deviceId: string,
): Promise<DeviceAttendanceContext | null> {
  const {
    rows: [row],
  } = await client.query<{
    device_status: string;
    app_version: string | null;
    attendance_enabled: boolean;
    reporting_timezone: string | null;
    leave_escalation_hours: number;
    attendance_whatsapp_alerts: boolean;
    tc_id: string | null;
    tc_name: string | null;
    app_leave_requests: boolean | null;
    app_break_booking: boolean | null;
    rm_id: string | null;
    rm_role: string | null;
    rm_status: string | null;
    rm_name: string | null;
  }>(
    `SELECT d.status AS device_status, d.app_version,
            o.attendance_enabled, o.reporting_timezone, o.leave_escalation_hours,
            o.attendance_whatsapp_alerts,
            t.id AS tc_id, t.display_name AS tc_name, t.app_leave_requests, t.app_break_booking,
            rm.id AS rm_id, rm.owner_role AS rm_role, rm.status AS rm_status,
            NULLIF(btrim(COALESCE(ru.name, '')), '') AS rm_name
       FROM devices d
       JOIN organizations o ON o.id = d.org_id
       LEFT JOIN telecallers t ON t.id = d.telecaller_id AND t.status = 'active'
       LEFT JOIN memberships rm ON rm.id = t.reports_to_membership_id
       LEFT JOIN users ru ON ru.id = rm.user_id AND ru.status = 'active'
      WHERE d.id = $1`,
    [deviceId],
  );
  if (!row) return null;

  const reportsTo: ApproverCandidate | null = row.rm_id
    ? { membershipId: row.rm_id, ownerRole: row.rm_role, status: row.rm_status ?? "suspended" }
    : null;
  const approverMembershipId = resolveApprover(reportsTo);

  return {
    deviceStatus: row.device_status,
    enabled: row.attendance_enabled === true,
    zone: resolveTimeZone(row.reporting_timezone),
    leaveEscalationHours: row.leave_escalation_hours ?? 24,
    whatsappAlerts: row.attendance_whatsapp_alerts === true,
    versionCode: versionCodeOf(row.app_version),
    telecaller: row.tc_id
      ? {
          id: row.tc_id,
          name: row.tc_name ?? "A telecaller",
          appLeaveRequests: row.app_leave_requests === true,
          appBreakBooking: row.app_break_booking === true,
          reportsTo,
          approverMembershipId,
          approverName: approverMembershipId ? (row.rm_name ?? "Your manager") : null,
        }
      : null,
  };
}

/** Yesterday..tomorrow for one telecaller - what the config block and the beacon need. */
export async function loadDeviceWeek(
  client: Queryable,
  ctx: DeviceAttendanceContext,
  now: number,
): Promise<{ book: ScheduleBook; today: string } | null> {
  if (!ctx.telecaller) return null;
  const today = todayIn(ctx.zone, now);
  const book = await loadScheduleBook(client, [ctx.telecaller.id], shiftDateKey(today, -1), shiftDateKey(today, 1), ctx.zone);
  return { book, today };
}

/**
 * The `attendance` block for GET /devices/me/config, or null when it must be
 * OMITTED: the workspace switch is off, the phone is bound to nobody, or the
 * handset is known to be older than ATTENDANCE_MIN_VERSION_CODE. An unknown
 * version gets the block - org.json ignores keys it does not read, which
 * PlatformApi.fetchConfig on 1.1.x does (it reads three named keys and nothing
 * else).
 */
export async function attendanceBlockFor(
  client: Queryable,
  ctx: DeviceAttendanceContext,
  now: number,
): Promise<DeviceAttendanceConfig | null> {
  if (!ctx.enabled || !ctx.telecaller || !handsetUnderstandsAttendance(ctx.versionCode)) return null;
  const week = await loadDeviceWeek(client, ctx, now);
  if (!week) return null;
  const id = ctx.telecaller.id;
  return buildAttendanceBlock({
    zone: ctx.zone,
    canApplyLeave: ctx.telecaller.appLeaveRequests,
    canBookBreaks: ctx.telecaller.appBreakBooking,
    approverName: ctx.telecaller.approverName,
    yesterday: week.book.resolve(id, shiftDateKey(week.today, -1)),
    today: week.book.resolve(id, week.today),
    tomorrow: week.book.resolve(id, shiftDateKey(week.today, 1)),
    now,
  });
}
