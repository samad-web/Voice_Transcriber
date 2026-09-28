import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import {
  canAutoApproveBreak,
  dayKeyIn,
  DeviceAttendanceRequestInput,
  normalisePresenceBatch,
  PresenceBatchInput,
  PRESENCE_RETENTION_DAYS,
  shiftDateKey,
  todayIn,
  toDeviceScheduleDay,
} from "@aura/shared";
import { DeviceAuthGuard, type DeviceRequest } from "../../common/device-auth.guard";
import { DbService } from "../../db/db.service";
import { classifyOnTheFly } from "./attendance-classify";
import { attendanceBlockFor, type DeviceAttendanceContext, loadDeviceAttendanceContext } from "./attendance-device";
import { loadScheduleBook, type Queryable, workDayAt } from "./attendance-schedule";
import { leaveDates, REQUEST_SELECT, type RequestRow, toDeviceRequestView } from "./attendance.logic";
import { AttendanceService } from "./attendance.service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The skew beyond which the phone is told its clock is wrong. */
const SKEW_REPORT_SECONDS = 120;

/**
 * The handset's attendance surface (doc 33 §9, migration 0140).
 *
 * DeviceAuthGuard like every `devices/me` route: the signed device token IS the
 * identity, and the telecaller is ALWAYS the one the device is bound to at the
 * moment of the request - never a value from the body. Not throttled for the
 * reason device-telemetry.controller.ts gives: a tenant's phones share one NAT
 * address, and the presence beacon is every two minutes per phone on shift.
 *
 * Most telecallers have no console login (doc 33 §6.1), so this is their only
 * way to see their own day and to ask for leave or a break. The per-person
 * switches are enforced HERE; the phone hiding a button is a convenience.
 */
@Controller("devices/me")
@UseGuards(DeviceAuthGuard)
@SkipThrottle()
export class DeviceAttendanceController {
  constructor(
    private readonly db: DbService,
    private readonly attendance: AttendanceService,
  ) {}

  /**
   * A batch of phone events, which is also the heartbeat.
   *
   * Idempotent on (device, boot, monotonic ms, kind). Always 200 - with the
   * workspace switch off, or the phone bound to nobody, the events are dropped
   * and `accepted` is 0: a phone can lag one config refresh behind the
   * console, and an error would only make it retry the same batch forever.
   */
  @Post("presence")
  @HttpCode(200)
  async presence(@Req() req: DeviceRequest, @Body() body: unknown) {
    const parsed = PresenceBatchInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const batch = parsed.data;
    const { deviceId, orgId } = req.device;
    const now = Date.now();
    const { events, skewSeconds } = normalisePresenceBatch(batch, now);

    const result = await this.db.withOrg(orgId, async (client) => {
      const ctx = await loadDeviceAttendanceContext(client, deviceId);
      if (!ctx) throw new UnauthorizedException("device not found");

      if (!ctx.enabled || !ctx.telecaller || ctx.deviceStatus !== "active") {
        await client.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [deviceId]);
        return { accepted: 0, duplicates: 0, scheduleVersion: 0, touched: false };
      }
      const telecallerId = ctx.telecaller.id;

      const stateSinceMs = Math.min(now, Date.parse(batch.stateSince) - skewSeconds * 1000);
      const lastEventMs = events.reduce((m, e) => Math.max(m, Date.parse(e.occurredAt)), 0);

      // Older days a late upload touched. Today and yesterday are rebuilt by
      // every classifier pass anyway; a phone that was offline for three days
      // is what this is for. The day before each event's date too - a night
      // shift belongs to the day it started.
      const today = todayIn(ctx.zone, now);
      const floor = shiftDateKey(today, -PRESENCE_RETENTION_DAYS);
      const dirty = new Set<string>();
      for (const e of events) {
        const d = dayKeyIn(e.occurredAt, ctx.zone);
        if (!d) continue;
        for (const date of [d, shiftDateKey(d, -1)]) {
          if (date < shiftDateKey(today, -1) && date >= floor) dirty.add(date);
        }
      }

      // One round trip for every write the beacon makes (the database is
      // ~125ms away and this runs every two minutes per phone on shift).
      const {
        rows: [written],
      } = await client.query<{ accepted: number }>(
        `WITH ins AS (
           INSERT INTO presence_events
             (org_id, device_id, telecaller_id, kind, occurred_at, device_wall_at, boot_id, mono_ms, payload)
           SELECT $1, $2, $3, x.kind, x.occurred_at, x.device_wall_at, x.boot_id, x.mono_ms,
                  COALESCE(x.payload, '{}'::jsonb)
             FROM jsonb_to_recordset($4::jsonb)
                  AS x(kind text, occurred_at timestamptz, device_wall_at timestamptz,
                       boot_id text, mono_ms bigint, payload jsonb)
           ON CONFLICT (device_id, boot_id, mono_ms, kind) DO NOTHING
           RETURNING 1
         ),
         live AS (
           INSERT INTO attendance_live_state
             (telecaller_id, org_id, device_id, state, state_since, last_event_at, last_received_at,
              battery_pct, network_ok)
           VALUES ($3, $1, $2, $5, $6::timestamptz, COALESCE($7::timestamptz, now()), now(), $8, $9)
           ON CONFLICT (telecaller_id) DO UPDATE SET
             device_id        = EXCLUDED.device_id,
             state            = EXCLUDED.state,
             state_since      = EXCLUDED.state_since,
             last_event_at    = GREATEST(attendance_live_state.last_event_at, EXCLUDED.last_event_at),
             last_received_at = now(),
             battery_pct      = COALESCE(EXCLUDED.battery_pct, attendance_live_state.battery_pct),
             network_ok       = COALESCE(EXCLUDED.network_ok, attendance_live_state.network_ok)
           RETURNING 1
         ),
         dev AS (
           UPDATE devices SET last_seen_at = now() WHERE id = $2 RETURNING 1
         ),
         dirty AS (
           INSERT INTO attendance_dirty_days (org_id, telecaller_id, work_date)
           SELECT $1, $3, d FROM unnest($10::date[]) AS d
           ON CONFLICT (telecaller_id, work_date) DO UPDATE SET marked_at = now()
           RETURNING 1
         )
         SELECT (SELECT count(*) FROM ins)::int AS accepted,
                (SELECT count(*) FROM live)::int AS live,
                (SELECT count(*) FROM dev)::int AS dev,
                (SELECT count(*) FROM dirty)::int AS dirty`,
        [
          orgId,
          deviceId,
          telecallerId,
          JSON.stringify(
            events.map((e) => ({
              kind: e.kind,
              occurred_at: e.occurredAt,
              device_wall_at: e.at,
              boot_id: e.bootId,
              mono_ms: e.monoMs,
              payload: e.payload ?? {},
            })),
          ),
          batch.state,
          new Date(stateSinceMs).toISOString(),
          lastEventMs > 0 ? new Date(lastEventMs).toISOString() : null,
          batch.batteryPct ?? null,
          batch.networkOk ?? null,
          [...dirty],
        ],
      );

      // The phone that is posting presence is new enough by definition, so
      // the version gate does not apply to the number it is told.
      const block = await attendanceBlockFor(client, { ...ctx, versionCode: null }, now);
      const accepted = written?.accepted ?? 0;
      return {
        accepted,
        duplicates: events.length - accepted,
        scheduleVersion: block?.scheduleVersion ?? 0,
        touched: true,
      };
    });

    if (result.touched) this.attendance.announce(orgId);
    return {
      accepted: result.accepted,
      duplicates: result.duplicates,
      ...(Math.abs(skewSeconds) > SKEW_REPORT_SECONDS ? { clockSkewSeconds: skewSeconds } : {}),
      scheduleVersion: result.scheduleVersion,
    };
  }

  /** The telecaller's own day - the phone's Attendance screen. Same timeline a manager sees. */
  @Get("attendance")
  async myDay(@Req() req: DeviceRequest, @Query("date") dateParam?: string) {
    const { deviceId, orgId } = req.device;
    if (dateParam !== undefined && !DATE_RE.test(dateParam)) {
      throw new BadRequestException("date must be YYYY-MM-DD");
    }
    const now = Date.now();
    return this.db.withOrg(orgId, async (client) => {
      const ctx = await this.requireContext(client, deviceId);
      const telecallerId = ctx.telecaller!.id;
      const date = dateParam ?? todayIn(ctx.zone, now);

      const book = await loadScheduleBook(client, [telecallerId], shiftDateKey(date, -1), shiftDateKey(date, 1), ctx.zone);
      const day = book.resolve(telecallerId, date);

      const {
        rows: [stored],
      } = await client.query<{
        day: {
          status: string;
          worked_seconds: number;
          break_seconds: number;
          technical_seconds: number;
          away_seconds: number;
          flags: string[];
        } | null;
        segments: { startsAt: string; endsAt: string; class: string; needsReview: boolean }[] | null;
      }>(
        `SELECT (SELECT row_to_json(d) FROM (
                   SELECT status, worked_seconds, break_seconds, technical_seconds, away_seconds, flags
                     FROM attendance_days WHERE telecaller_id = $1 AND work_date = $2::date) d) AS day,
                (SELECT json_agg(json_build_object('startsAt', s.starts_at, 'endsAt', s.ends_at,
                                                   'class', s.class, 'needsReview', s.needs_review)
                                 ORDER BY s.starts_at)
                   FROM attendance_segments s WHERE s.telecaller_id = $1 AND s.work_date = $2::date) AS segments`,
        [telecallerId, date],
      );

      let summary: Record<string, unknown>;
      let segments: { startsAt: string; endsAt: string; class: string; needsReview: boolean }[];
      if (stored?.day) {
        summary = {
          status: stored.day.status,
          workedSeconds: stored.day.worked_seconds,
          breakSeconds: stored.day.break_seconds,
          technicalSeconds: stored.day.technical_seconds,
          awaySeconds: stored.day.away_seconds,
          flags: stored.day.flags ?? [],
        };
        segments = (stored.segments ?? []).map((s) => ({
          startsAt: new Date(s.startsAt).toISOString(),
          endsAt: new Date(s.endsAt).toISOString(),
          class: s.class,
          needsReview: s.needsReview,
        }));
      } else {
        // Not reached by the worker yet (it runs every five minutes) - the
        // same classifier, on the fly, so the phone never shows a blank day.
        const c = await classifyOnTheFly(client, telecallerId, day, ctx.zone, now);
        summary = {
          status: c.status,
          workedSeconds: c.workedSeconds,
          breakSeconds: c.breakSeconds,
          technicalSeconds: c.technicalSeconds,
          awaySeconds: c.awaySeconds,
          flags: c.flags,
        };
        segments = c.segments.map((s) => ({
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          class: s.class,
          needsReview: s.needsReview,
        }));
      }

      const { rows: requests } = await client.query<RequestRow>(
        `${REQUEST_SELECT}
          WHERE r.telecaller_id = $1
            AND (r.created_at > now() - interval '30 days'
                 OR r.ends_at > now()
                 OR r.end_date >= current_date)
          ORDER BY r.created_at DESC
          LIMIT 200`,
        [telecallerId],
      );

      return {
        date,
        day: toDeviceScheduleDay(day),
        summary,
        segments,
        requests: requests.map(toDeviceRequestView),
      };
    });
  }

  /**
   * Apply for leave, book a break, or ask to change today's hours.
   *
   * Idempotent on the phone's own `clientRef`: an application written offline
   * and sent twice is stored once, and the replay gets the stored request back
   * with `duplicate: true`. A break inside the allowance is approved on the
   * spot (doc 33 §12 Q2); everything else waits for the approver.
   */
  @Post("attendance/requests")
  async createRequest(@Req() req: DeviceRequest, @Body() body: unknown) {
    const parsed = DeviceAttendanceRequestInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const { deviceId, orgId } = req.device;
    const now = Date.now();

    const outcome = await this.db.withOrg(orgId, async (client) => {
      const ctx = await this.requireContext(client, deviceId);
      const tc = ctx.telecaller!;
      const allowed = input.kind === "leave" ? tc.appLeaveRequests : tc.appBreakBooking;
      if (!allowed) {
        throw new ForbiddenException({
          code: "app_requests_disabled",
          message:
            input.kind === "leave"
              ? "Applying for leave from the app is not switched on for you. Ask your manager."
              : "Booking breaks from the app is not switched on for you. Ask your manager.",
        });
      }

      // A replay short-circuits before any routing, so it never notifies twice.
      const existing = await this.findByClientRef(client, orgId, deviceId, input.clientRef);
      if (existing) return { row: existing, duplicate: true, autoApproved: false, telecallerId: tc.id };

      let status: "pending" | "auto_approved" = "pending";
      let workDates: string[];
      if (input.kind === "leave") {
        workDates = leaveDates(input.startDate, input.endDate);
      } else {
        const startsMs = Date.parse(input.startsAt);
        const calendar = dayKeyIn(input.startsAt, ctx.zone) ?? todayIn(ctx.zone, now);
        const book = await loadScheduleBook(client, [tc.id], shiftDateKey(calendar, -1), calendar, ctx.zone);
        const { date, day } = workDayAt(book, tc.id, startsMs, calendar);
        workDates = [date];
        if (input.kind === "break" && startsMs >= now - 5 * 60_000 && canAutoApproveBreak(day, input.startsAt, input.endsAt).ok) {
          status = "auto_approved";
        }
      }
      const approver = status === "pending" ? tc.approverMembershipId : null;

      const {
        rows: [inserted],
      } = await client.query<{ id: string }>(
        `INSERT INTO attendance_requests
           (org_id, telecaller_id, kind, leave_type, start_date, end_date, half_day,
            starts_at, ends_at, reason, status, approver_membership_id, source, device_id, client_ref)
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12,
                 'device', $13, $14)
         ON CONFLICT (org_id, device_id, client_ref) WHERE client_ref IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          orgId,
          tc.id,
          input.kind,
          input.kind === "leave" ? input.leaveType : null,
          input.kind === "leave" ? input.startDate : null,
          input.kind === "leave" ? input.endDate : null,
          input.kind === "leave" ? (input.halfDay ?? null) : null,
          input.kind === "leave" ? null : input.startsAt,
          input.kind === "leave" ? null : input.endsAt,
          input.reason ?? null,
          status,
          approver,
          deviceId,
          input.clientRef,
        ],
      );
      if (!inserted) {
        // Lost a race with a concurrent replay of the same clientRef.
        const row = await this.findByClientRef(client, orgId, deviceId, input.clientRef);
        if (!row) throw new ConflictException("request could not be stored");
        return { row, duplicate: true, autoApproved: false, telecallerId: tc.id };
      }

      if (status === "pending") {
        await this.attendance.routeNewRequest(
          client,
          orgId,
          {
            id: inserted.id,
            telecallerName: tc.name,
            kind: input.kind,
            leaveType: input.kind === "leave" ? input.leaveType : null,
            startDate: input.kind === "leave" ? input.startDate : null,
            endDate: input.kind === "leave" ? input.endDate : null,
            halfDay: input.kind === "leave" ? (input.halfDay ?? null) : null,
            startsAt: input.kind === "leave" ? null : input.startsAt,
            endsAt: input.kind === "leave" ? null : input.endsAt,
            approverMembershipId: approver,
          },
          ctx.zone,
          ctx.whatsappAlerts,
        );
      } else {
        await this.attendance.markDirty(client, orgId, workDates.map((date) => ({ telecallerId: tc.id, date })));
      }
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'device', $2, 'attendance.request_create', 'attendance_request', $3, $4)`,
        [orgId, deviceId, inserted.id, JSON.stringify({ kind: input.kind, status, telecallerId: tc.id })],
      );

      const row = await this.findById(client, inserted.id);
      const tokens = status === "auto_approved" ? await this.attendance.deviceTokens(client, { telecallerIds: [tc.id] }) : [];
      return { row: row!, duplicate: false, autoApproved: status === "auto_approved", telecallerId: tc.id, tokens };
    });

    if (!outcome.duplicate) {
      if ("tokens" in outcome && outcome.tokens) this.attendance.pushConfigRefresh(outcome.tokens);
      this.attendance.announce(orgId, outcome.row.id);
    }
    return { request: toDeviceRequestView(outcome.row), duplicate: outcome.duplicate };
  }

  /**
   * Cancel one of the telecaller's own requests: any pending one, or a booked
   * break that has not started. Approved LEAVE is not cancellable from the
   * phone - only a manager can take it back, so approved leave cannot quietly
   * disappear from the record (doc 33 §6.3).
   */
  @Delete("attendance/requests/:id")
  async cancelRequest(@Req() req: DeviceRequest, @Param("id", ParseUUIDPipe) id: string) {
    const { deviceId, orgId } = req.device;
    const outcome = await this.db.withOrg(orgId, async (client) => {
      const ctx = await this.requireContext(client, deviceId);
      const tc = ctx.telecaller!;
      const {
        rows: [current],
      } = await client.query<{ status: string; kind: string; starts_at: Date | null; start_date: string | null; end_date: string | null }>(
        `SELECT status, kind, starts_at, start_date::text AS start_date, end_date::text AS end_date
           FROM attendance_requests WHERE id = $1 AND telecaller_id = $2 FOR UPDATE`,
        [id, tc.id],
      );
      if (!current) throw new NotFoundException("request not found");

      const bookedBreakNotStarted =
        current.kind === "break" &&
        (current.status === "approved" || current.status === "auto_approved") &&
        current.starts_at !== null &&
        new Date(current.starts_at).getTime() > Date.now();
      if (current.status !== "pending" && !bookedBreakNotStarted) {
        throw new ConflictException({
          code: "not_cancellable",
          message: "Only a request that is still waiting, or a booked break that has not started, can be cancelled.",
        });
      }

      await client.query(`UPDATE attendance_requests SET status = 'cancelled' WHERE id = $1`, [id]);
      if (bookedBreakNotStarted) {
        const date = dayKeyIn(current.starts_at!, ctx.zone);
        if (date) await this.attendance.markDirty(client, orgId, [{ telecallerId: tc.id, date }]);
      }
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'device', $2, 'attendance.request_cancel', 'attendance_request', $3, $4)`,
        [orgId, deviceId, id, JSON.stringify({ previousStatus: current.status })],
      );
      const row = await this.findById(client, id);
      const tokens = await this.attendance.deviceTokens(client, { telecallerIds: [tc.id] });
      return { row: row!, tokens };
    });
    this.attendance.pushConfigRefresh(outcome.tokens);
    this.attendance.announce(orgId, id);
    return { request: toDeviceRequestView(outcome.row) };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /** The device's context, refusing when attendance is off or nobody holds the phone. */
  private async requireContext(client: Queryable, deviceId: string): Promise<DeviceAttendanceContext> {
    const ctx = await loadDeviceAttendanceContext(client, deviceId);
    if (!ctx) throw new UnauthorizedException("device not found");
    if (!ctx.enabled) {
      throw new ConflictException({ code: "attendance_disabled", message: "Attendance is switched off for this workspace." });
    }
    if (!ctx.telecaller) {
      throw new ConflictException({
        code: "not_assigned",
        message: "This phone is not assigned to a telecaller yet. Ask your manager.",
      });
    }
    return ctx;
  }

  private async findByClientRef(client: Queryable, orgId: string, deviceId: string, clientRef: string) {
    const {
      rows: [row],
    } = await client.query<RequestRow>(
      `${REQUEST_SELECT} WHERE r.org_id = $1 AND r.device_id = $2 AND r.client_ref = $3`,
      [orgId, deviceId, clientRef],
    );
    return row ?? null;
  }

  private async findById(client: Queryable, id: string) {
    const {
      rows: [row],
    } = await client.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
    return row ?? null;
  }
}
