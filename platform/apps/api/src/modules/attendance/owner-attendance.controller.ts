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
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import {
  AttendanceSettingsInput,
  canDecideRequest,
  dayKeyIn,
  ExceptionInput,
  liveBoardState,
  OnBehalfRequestInput,
  PeopleUpdateInput,
  RequestDecisionInput,
  resolveTimeZone,
  RULE_LABELS,
  SegmentOverrideInput,
  ShiftPatternInput,
  shiftDateKey,
  suggestSilenceThreshold,
  todayIn,
  DEFAULT_SHIFT,
  type HandsetState,
  zonedParts,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OwnerScope, type OwnerRecordScope } from "../../common/owner-scope";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { datesBetween, loadScheduleBook, type Queryable, workDayAt } from "./attendance-schedule";
import {
  ATTENDANCE_WABA_TEMPLATE,
  ATTENDANCE_WABA_TEMPLATE_PARAMS,
  camelRow,
  handsetNeedsUpdate,
  isoOrNull,
  leaveDates,
  ownTelecallerOnly,
  rangeDays,
  REQUEST_SELECT,
  type RequestRow,
  summariseWhatsapp,
  toCsv,
  toOwnerRequestView,
  versionCodeOf,
} from "./attendance.logic";
import { AttendanceService } from "./attendance.service";

const DateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const RangeQuery = z.object({ from: DateKey.optional(), to: DateKey.optional() });
const TimesheetQuery = z.object({ from: DateKey, to: DateKey, telecallerId: z.string().uuid().optional() });
const DayQuery = z.object({ telecallerId: z.string().uuid(), date: DateKey });
const RequestsQuery = z.object({
  status: z.enum(["pending", "decided", "all"]).optional(),
  mine: z.enum(["1", "0", "true", "false"]).optional(),
  escalated: z.enum(["1", "0", "true", "false"]).optional(),
});

/** Timesheets are read a pay period at a time at most. */
const MAX_TIMESHEET_DAYS = 93;

const PATTERN_SELECT = `
  SELECT p.id, p.name, p.work_days::int[] AS work_days,
         to_char(p.start_time, 'HH24:MI') AS start_time, to_char(p.end_time, 'HH24:MI') AS end_time,
         p.grace_minutes, p.break_allowance_minutes, p.silence_threshold_minutes, p.prompt_timeout_minutes,
         (SELECT COALESCE(json_agg(json_build_object(
                   'label', s.label, 'startTime', to_char(s.start_time, 'HH24:MI'),
                   'durationMinutes', s.duration_minutes) ORDER BY s.start_time), '[]'::json)
            FROM shift_break_slots s WHERE s.shift_pattern_id = p.id) AS breaks,
         (SELECT count(*)::int FROM telecallers t
           WHERE t.status = 'active'
             AND (SELECT a.shift_pattern_id FROM telecaller_shift_assignments a
                   WHERE a.telecaller_id = t.id AND a.effective_from <= current_date
                   ORDER BY a.effective_from DESC LIMIT 1) = p.id) AS assigned_count
    FROM shift_patterns p`;

interface PatternRow {
  id: string;
  name: string;
  work_days: number[];
  start_time: string;
  end_time: string;
  grace_minutes: number;
  break_allowance_minutes: number;
  silence_threshold_minutes: number;
  prompt_timeout_minutes: number;
  breaks: { label: string; startTime: string; durationMinutes: number }[];
  assigned_count: number;
}

const patternView = (p: PatternRow) => ({
  id: p.id,
  name: p.name,
  workDays: p.work_days,
  startTime: p.start_time,
  endTime: p.end_time,
  graceMinutes: p.grace_minutes,
  breakAllowanceMinutes: p.break_allowance_minutes,
  silenceThresholdMinutes: p.silence_threshold_minutes,
  promptTimeoutMinutes: p.prompt_timeout_minutes,
  breaks: p.breaks ?? [],
  assignedCount: p.assigned_count ?? 0,
});

const truthy = (v: string | undefined) => v === "1" || v === "true";

/**
 * The console's attendance surface (doc 33 §7, §9; migration 0140).
 *
 * Same five guards, same order, as TelecallerProductivityController, mounted
 * on the class so a route added later is scoped and feature-gated by default.
 *
 * ── WHO MAY DO WHAT ─────────────────────────────────────────────────────────
 *
 * Configuration - settings, patterns, people, exceptions, recording leave on
 * somebody's behalf, the review queue - is owner and manager. Reading a day
 * (today, timesheets, one day, the request list) is every persona, SCOPED:
 * a telecaller with a console login sees their own rows and nobody else's
 * (OwnerScopeGuard, the productivity rule). Deciding a request is narrower
 * than either: the request's assigned manager or any owner, and never the
 * person whose request it is (`canDecideRequest`). Only an owner may touch the
 * WhatsApp alert toggle, because it is consent to message people.
 *
 * Every write is audit-logged with auditActor(req). None of these routes
 * returns call content, so none carries @CallContent().
 */
@Controller("owner/attendance")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OwnerScopeGuard, OrgFeatureGuard)
@RequireFeature("attendance")
export class OwnerAttendanceController {
  constructor(
    private readonly db: DbService,
    private readonly attendance: AttendanceService,
  ) {}

  // ── Settings ──────────────────────────────────────────────────────────────

  @Get("settings")
  @RequireOwnerRole("owner", "manager")
  async getSettings(@OrgId() orgId: string, @OwnerScope() scope: OwnerRecordScope) {
    return this.db.withOrg(orgId, (client) => this.readSettings(client, orgId, scope));
  }

  /**
   * The workspace switch, the escalation window and the WhatsApp toggle.
   *
   * A manager may change the first two. The toggle and its channel are the
   * workspace's consent to message its own staff, so only an OWNER may change
   * them; a manager's PUT that CHANGES either is refused, while one that
   * echoes the stored values back (a form sending the whole object) is not.
   */
  @Put("settings")
  @RequireOwnerRole("owner", "manager")
  async putSettings(
    @OrgId() orgId: string,
    @Body() body: unknown,
    @OwnerScope() scope: OwnerRecordScope,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = AttendanceSettingsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    const out = await this.db.withOrg(orgId, async (client) => {
      const before = await this.orgRow(client, orgId);
      const alerts = input.whatsappAlerts ?? before.attendance_whatsapp_alerts;
      const channelId =
        input.whatsappChannelId !== undefined ? input.whatsappChannelId : before.attendance_whatsapp_channel_id;
      const waChanged =
        alerts !== before.attendance_whatsapp_alerts || channelId !== before.attendance_whatsapp_channel_id;
      if (waChanged && scope.role !== "owner") {
        throw new ForbiddenException({
          code: "owner_only",
          message: "Only an owner can change WhatsApp alerts - they message your staff from your business number.",
        });
      }

      if (waChanged && channelId) {
        const {
          rows: [ch],
        } = await client.query<{ provider: string; template_ok: boolean }>(
          `SELECT c.provider,
                  EXISTS (SELECT 1 FROM message_templates mt
                           WHERE mt.channel_id = c.id AND mt.name = $2 AND mt.status = 'approved'
                             AND jsonb_array_length(COALESCE(mt.variables, '[]'::jsonb)) = $3) AS template_ok
             FROM messaging_channels c
            WHERE c.id = $1 AND c.channel = 'whatsapp' AND c.provider IN ('waba', 'wasi')
              AND c.owner_user_id IS NULL AND c.status = 'active'`,
          [channelId, ATTENDANCE_WABA_TEMPLATE, ATTENDANCE_WABA_TEMPLATE_PARAMS],
        );
        if (!ch) {
          throw new ConflictException({
            code: "channel_not_allowed",
            message: "Alerts can only be sent from this workspace's own active WhatsApp Business number.",
          });
        }
        if (alerts && ch.provider === "waba" && !ch.template_ok) {
          throw new ConflictException({
            code: "template_not_approved",
            message:
              `Meta only lets a business start a WhatsApp conversation with an approved template. Create a Utility ` +
              `template named "${ATTENDANCE_WABA_TEMPLATE}" with ${ATTENDANCE_WABA_TEMPLATE_PARAMS} variables ` +
              `(name, request, link) in Meta, then sync templates in Conversations.`,
          });
        }
      }
      if (alerts && !channelId) {
        throw new ConflictException({
          code: "channel_required",
          message: "Choose which WhatsApp Business number the alerts are sent from.",
        });
      }

      try {
        await client.query(
          `UPDATE organizations
              SET attendance_enabled = COALESCE($2, attendance_enabled),
                  leave_escalation_hours = COALESCE($3, leave_escalation_hours),
                  attendance_whatsapp_alerts = $4,
                  attendance_whatsapp_channel_id = $5::uuid
            WHERE id = $1`,
          [orgId, input.enabled ?? null, input.leaveEscalationHours ?? null, alerts, channelId],
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23514") {
          throw new ConflictException({ code: "channel_not_allowed", message: (err as Error).message });
        }
        throw err;
      }

      const enabledChanged = input.enabled !== undefined && input.enabled !== before.attendance_enabled;
      await this.audit(client, orgId, req, "attendance.settings_update", "organization", orgId, {
        before: {
          enabled: before.attendance_enabled,
          leaveEscalationHours: before.leave_escalation_hours,
          whatsappAlerts: before.attendance_whatsapp_alerts,
          whatsappChannelId: before.attendance_whatsapp_channel_id,
        },
        after: input,
      });
      const tokens = enabledChanged ? await this.attendance.deviceTokens(client, { all: true }) : [];
      return { settings: await this.readSettings(client, orgId, scope), tokens };
    });
    this.attendance.pushConfigRefresh(out.tokens);
    return out.settings;
  }

  // ── Shift patterns ────────────────────────────────────────────────────────

  @Get("patterns")
  @RequireOwnerRole("owner", "manager")
  async listPatterns(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<PatternRow>(
        `${PATTERN_SELECT} WHERE p.archived_at IS NULL ORDER BY lower(p.name)`,
      );
      return { patterns: rows.map(patternView) };
    });
  }

  @Post("patterns")
  @RequireOwnerRole("owner", "manager")
  async createPattern(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const input = this.parse(ShiftPatternInput, body);
    return this.db.withOrg(orgId, async (client) => {
      let id: string;
      try {
        const {
          rows: [row],
        } = await client.query<{ id: string }>(
          `INSERT INTO shift_patterns
             (org_id, name, work_days, start_time, end_time, grace_minutes, break_allowance_minutes,
              silence_threshold_minutes, prompt_timeout_minutes, created_by)
           VALUES ($1, $2, $3::smallint[], $4::time, $5::time, $6, $7, $8, $9, $10::uuid)
           RETURNING id`,
          [
            orgId,
            input.name,
            input.workDays,
            input.startTime,
            input.endTime,
            input.graceMinutes,
            input.breakAllowanceMinutes,
            input.silenceThresholdMinutes,
            input.promptTimeoutMinutes,
            this.userUuid(req),
          ],
        );
        id = row!.id;
      } catch (err) {
        throw this.nameTaken(err);
      }
      await this.writeBreaks(client, orgId, id, input.breaks);
      await this.audit(client, orgId, req, "attendance.pattern_create", "shift_pattern", id, { name: input.name });
      return { pattern: await this.patternById(client, id) };
    });
  }

  /** A full replacement - the break slots are rewritten wholesale. */
  @Patch("patterns/:id")
  @RequireOwnerRole("owner", "manager")
  async updatePattern(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const input = this.parse(ShiftPatternInput, body);
    const out = await this.db.withOrg(orgId, async (client) => {
      let found: { id: string } | undefined;
      try {
        ({
          rows: [found],
        } = await client.query<{ id: string }>(
          `UPDATE shift_patterns
              SET name = $2, work_days = $3::smallint[], start_time = $4::time, end_time = $5::time,
                  grace_minutes = $6, break_allowance_minutes = $7, silence_threshold_minutes = $8,
                  prompt_timeout_minutes = $9
            WHERE id = $1 AND archived_at IS NULL
            RETURNING id`,
          [
            id,
            input.name,
            input.workDays,
            input.startTime,
            input.endTime,
            input.graceMinutes,
            input.breakAllowanceMinutes,
            input.silenceThresholdMinutes,
            input.promptTimeoutMinutes,
          ],
        ));
      } catch (err) {
        throw this.nameTaken(err);
      }
      if (!found) throw new NotFoundException("shift pattern not found");
      await client.query(`DELETE FROM shift_break_slots WHERE shift_pattern_id = $1`, [id]);
      await this.writeBreaks(client, orgId, id, input.breaks);
      const affected = await this.telecallersOnPattern(client, id);
      await this.markToday(client, orgId, affected);
      await this.audit(client, orgId, req, "attendance.pattern_update", "shift_pattern", id, { name: input.name });
      const tokens = await this.attendance.deviceTokens(client, { telecallerIds: affected });
      return { pattern: await this.patternById(client, id), tokens };
    });
    this.attendance.pushConfigRefresh(out.tokens);
    return { pattern: out.pattern };
  }

  /**
   * Archive, never delete: assignments and past days still name it. Anyone on
   * it today is unassigned from today, and future assignments to it are
   * cleared, so an archived pattern stops producing shifts at once rather than
   * silently continuing for the people nobody moved.
   */
  @Delete("patterns/:id")
  @RequireOwnerRole("owner", "manager")
  async archivePattern(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: PrincipalRequest) {
    const out = await this.db.withOrg(orgId, async (client) => {
      const affected = await this.telecallersOnPattern(client, id);
      const {
        rows: [row],
      } = await client.query<{ id: string }>(
        `UPDATE shift_patterns SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id`,
        [id],
      );
      if (!row) throw new NotFoundException("shift pattern not found");
      await client.query(
        `UPDATE telecaller_shift_assignments SET shift_pattern_id = NULL
          WHERE shift_pattern_id = $1 AND effective_from > current_date`,
        [id],
      );
      if (affected.length > 0) {
        await client.query(
          `INSERT INTO telecaller_shift_assignments (org_id, telecaller_id, shift_pattern_id, effective_from, created_by)
           SELECT $1, t, NULL, current_date, $3::uuid FROM unnest($2::uuid[]) AS t
           ON CONFLICT (telecaller_id, effective_from) DO UPDATE SET shift_pattern_id = NULL`,
          [orgId, affected, this.userUuid(req)],
        );
      }
      await this.markToday(client, orgId, affected);
      await this.audit(client, orgId, req, "attendance.pattern_archive", "shift_pattern", id, { unassigned: affected.length });
      return { tokens: await this.attendance.deviceTokens(client, { telecallerIds: affected }) };
    });
    this.attendance.pushConfigRefresh(out.tokens);
    return { ok: true };
  }

  // ── People ────────────────────────────────────────────────────────────────

  @Get("people")
  @RequireOwnerRole("owner", "manager")
  async people(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{ people: Record<string, unknown>[] | null; approvers: Record<string, unknown>[] | null }>(
        `SELECT
           (SELECT json_agg(x ORDER BY lower(x.name)) FROM (
              SELECT t.id AS "telecallerId", t.display_name AS name,
                     cur.shift_pattern_id AS "shiftPatternId", p.name AS "shiftPatternName",
                     p.silence_threshold_minutes AS "patternSilence",
                     t.reports_to_membership_id AS "reportsToMembershipId",
                     CASE WHEN rm.id IS NULL THEN NULL
                          ELSE COALESCE(NULLIF(btrim(ru.name), ''), ru.email) END AS "reportsToName",
                     t.app_leave_requests AS "appLeaveRequests", t.app_break_booking AS "appBreakBooking",
                     d.id AS "deviceId", d.label AS "deviceLabel", d.app_version AS "appVersion",
                     d.last_seen_at AS "lastSeenAt",
                     g.p90 AS "p90Gap"
                FROM telecallers t
                LEFT JOIN LATERAL (
                  SELECT a.shift_pattern_id FROM telecaller_shift_assignments a
                   WHERE a.telecaller_id = t.id AND a.effective_from <= current_date
                   ORDER BY a.effective_from DESC LIMIT 1) cur ON true
                LEFT JOIN shift_patterns p ON p.id = cur.shift_pattern_id
                LEFT JOIN memberships rm ON rm.id = t.reports_to_membership_id
                LEFT JOIN users ru ON ru.id = rm.user_id
                LEFT JOIN LATERAL (
                  SELECT dv.id, dv.label, dv.app_version, dv.last_seen_at FROM devices dv
                   WHERE dv.telecaller_id = t.id AND dv.removed_at IS NULL
                   ORDER BY (dv.status = 'active') DESC, dv.last_seen_at DESC NULLS LAST LIMIT 1) d ON true
                LEFT JOIN LATERAL (
                  -- The median day's p90 gap between calls, over two weeks: a
                  -- typical day's long tail, not the single worst afternoon.
                  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s.p90_gap_seconds) AS p90
                    FROM telecaller_daily_stats s
                   WHERE s.telecaller_id = t.id AND s.day > current_date - 14
                     AND s.p90_gap_seconds IS NOT NULL) g ON true
               WHERE t.status = 'active') x) AS people,
           (SELECT json_agg(a ORDER BY lower(a.name)) FROM (
              SELECT DISTINCT ON (m.user_id)
                     m.id AS "membershipId", COALESCE(NULLIF(btrim(u.name), ''), u.email) AS name,
                     m.owner_role AS "ownerRole",
                     (m.whatsapp_number IS NOT NULL AND btrim(m.whatsapp_number) <> '') AS "hasWhatsapp"
                FROM memberships m JOIN users u ON u.id = m.user_id
               WHERE m.status = 'active' AND u.status = 'active' AND m.owner_role IN ('owner', 'manager')
               ORDER BY m.user_id, (m.scope_type = 'org') DESC, m.id) a) AS approvers`,
      );
      const people = (row?.people ?? []).map((p) => {
        const code = versionCodeOf(p.appVersion as string | null);
        const hasDevice = Boolean(p.deviceId);
        const p90 = p.p90Gap === null || p.p90Gap === undefined ? null : Number(p.p90Gap);
        return {
          telecallerId: p.telecallerId,
          name: p.name,
          shiftPatternId: p.shiftPatternId ?? null,
          shiftPatternName: p.shiftPatternName ?? null,
          reportsToMembershipId: p.reportsToMembershipId ?? null,
          reportsToName: p.reportsToName ?? null,
          appLeaveRequests: p.appLeaveRequests === true,
          appBreakBooking: p.appBreakBooking === true,
          device: hasDevice
            ? {
                id: p.deviceId,
                label: p.deviceLabel ?? null,
                appVersionCode: code,
                lastSeenAt: isoOrNull(p.lastSeenAt as string | null),
              }
            : null,
          needsAppUpdate: handsetNeedsUpdate(hasDevice, code),
          suggestedSilenceMinutes:
            p90 === null || !Number.isFinite(p90)
              ? null
              : suggestSilenceThreshold(p90, Number(p.patternSilence ?? DEFAULT_SHIFT.silenceThresholdMinutes)),
        };
      });
      return { people, approvers: row?.approvers ?? [] };
    });
  }

  /** Bulk edit: pattern (from a date), reports-to, and the two app switches. */
  @Put("people")
  @RequireOwnerRole("owner", "manager")
  async updatePeople(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const input = this.parse(PeopleUpdateInput, body);
    const ids = [...new Set(input.telecallerIds)];
    const out = await this.db.withOrg(orgId, async (client) => {
      const { rows: found } = await client.query<{ id: string }>(
        `SELECT id FROM telecallers WHERE id = ANY($1::uuid[]) AND status = 'active'`,
        [ids],
      );
      if (found.length !== ids.length) throw new NotFoundException("one or more telecallers were not found");

      const {
        rows: [clock],
      } = await client.query<{ today: string }>(`SELECT current_date::text AS today`);
      const today = clock!.today;
      const effectiveFrom = input.effectiveFrom ?? today;

      if (input.shiftPatternId !== undefined) {
        if (input.shiftPatternId !== null) {
          const {
            rows: [p],
          } = await client.query(`SELECT 1 FROM shift_patterns WHERE id = $1 AND archived_at IS NULL`, [
            input.shiftPatternId,
          ]);
          if (!p) throw new NotFoundException("shift pattern not found");
        }
        await client.query(
          `INSERT INTO telecaller_shift_assignments (org_id, telecaller_id, shift_pattern_id, effective_from, created_by)
           SELECT $1, t, $3::uuid, $4::date, $5::uuid FROM unnest($2::uuid[]) AS t
           ON CONFLICT (telecaller_id, effective_from) DO UPDATE SET shift_pattern_id = EXCLUDED.shift_pattern_id`,
          [orgId, ids, input.shiftPatternId, effectiveFrom, this.userUuid(req)],
        );
      }
      if (input.reportsToMembershipId !== undefined && input.reportsToMembershipId !== null) {
        const {
          rows: [m],
        } = await client.query(
          `SELECT 1 FROM memberships WHERE id = $1 AND status = 'active' AND owner_role IN ('owner', 'manager')`,
          [input.reportsToMembershipId],
        );
        if (!m) throw new BadRequestException("a telecaller can only report to an active owner or manager");
      }
      const { rowCount } = await client.query(
        `UPDATE telecallers
            SET reports_to_membership_id = CASE WHEN $2 THEN $3::uuid ELSE reports_to_membership_id END,
                app_leave_requests = COALESCE($4, app_leave_requests),
                app_break_booking = COALESCE($5, app_break_booking)
          WHERE id = ANY($1::uuid[])`,
        [
          ids,
          input.reportsToMembershipId !== undefined,
          input.reportsToMembershipId ?? null,
          input.appLeaveRequests ?? null,
          input.appBreakBooking ?? null,
        ],
      );

      // A pattern change back-dated into the past rebuilds those days too (a
      // month at most); a forward-dated one only matters when it arrives.
      const floor = shiftDateKey(today, -31);
      const from = effectiveFrom < floor ? floor : effectiveFrom;
      const dates = input.shiftPatternId !== undefined && from <= today ? datesBetween(from, today) : [today];
      await this.attendance.markDirty(
        client,
        orgId,
        ids.flatMap((telecallerId) => dates.map((date) => ({ telecallerId, date }))),
      );
      await this.audit(client, orgId, req, "attendance.people_update", "telecaller", ids.join(",").slice(0, 500), {
        count: ids.length,
        shiftPatternId: input.shiftPatternId,
        effectiveFrom: input.shiftPatternId !== undefined ? effectiveFrom : undefined,
        reportsToMembershipId: input.reportsToMembershipId,
        appLeaveRequests: input.appLeaveRequests,
        appBreakBooking: input.appBreakBooking,
      });
      return { updated: rowCount ?? 0, tokens: await this.attendance.deviceTokens(client, { telecallerIds: ids }) };
    });
    this.attendance.pushConfigRefresh(out.tokens);
    return { updated: out.updated };
  }

  // ── Exceptions (holidays, days off, custom hours) ─────────────────────────

  @Get("exceptions")
  @RequireOwnerRole("owner", "manager")
  async listExceptions(@OrgId() orgId: string, @Query() query: unknown) {
    const q = this.parse(RangeQuery, query);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [clock],
      } = await client.query<{ today: string }>(`SELECT current_date::text AS today`);
      const from = q.from ?? shiftDateKey(clock!.today, -30);
      const to = q.to ?? shiftDateKey(clock!.today, 90);
      if (from > to || rangeDays(from, to) > 400) throw new BadRequestException("choose a range of at most 400 days");
      const { rows } = await client.query(
        `SELECT e.id, e.telecaller_id AS "telecallerId", t.display_name AS "telecallerName",
                e.on_date::text AS "onDate", e.kind, e.label,
                to_char(e.start_time, 'HH24:MI') AS "startTime", to_char(e.end_time, 'HH24:MI') AS "endTime"
           FROM attendance_exceptions e
           LEFT JOIN telecallers t ON t.id = e.telecaller_id
          WHERE e.on_date BETWEEN $1::date AND $2::date
          ORDER BY e.on_date, t.display_name NULLS FIRST`,
        [from, to],
      );
      return { exceptions: rows };
    });
  }

  @Post("exceptions")
  @RequireOwnerRole("owner", "manager")
  async createException(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const input = this.parse(ExceptionInput, body);
    const out = await this.db.withOrg(orgId, async (client) => {
      if (input.telecallerId) {
        const {
          rows: [t],
        } = await client.query(`SELECT 1 FROM telecallers WHERE id = $1`, [input.telecallerId]);
        if (!t) throw new NotFoundException("telecaller not found");
      }
      let row: Record<string, unknown> | undefined;
      try {
        ({
          rows: [row],
        } = await client.query(
          `INSERT INTO attendance_exceptions (org_id, telecaller_id, on_date, kind, label, start_time, end_time, created_by)
           VALUES ($1, $2::uuid, $3::date, $4, $5, $6::time, $7::time, $8::uuid)
           RETURNING id, telecaller_id AS "telecallerId", on_date::text AS "onDate", kind, label,
                     to_char(start_time, 'HH24:MI') AS "startTime", to_char(end_time, 'HH24:MI') AS "endTime"`,
          [
            orgId,
            input.telecallerId,
            input.onDate,
            input.kind,
            input.label ?? null,
            input.startTime ?? null,
            input.endTime ?? null,
            this.userUuid(req),
          ],
        ));
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException({
            code: "exception_exists",
            message: "There is already a holiday or exception on that date for that person.",
          });
        }
        throw err;
      }
      const effect = await this.exceptionSideEffects(client, orgId, input.telecallerId, input.onDate);
      await this.audit(client, orgId, req, "attendance.exception_create", "attendance_exception", String(row!.id), {
        kind: input.kind,
        onDate: input.onDate,
        telecallerId: input.telecallerId,
      });
      const {
        rows: [named],
      } = await client.query<{ name: string | null }>(`SELECT display_name AS name FROM telecallers WHERE id = $1::uuid`, [
        input.telecallerId,
      ]);
      return { exception: { ...row!, telecallerName: named?.name ?? null }, tokens: effect };
    });
    this.attendance.pushConfigRefresh(out.tokens);
    return { exception: out.exception };
  }

  @Delete("exceptions/:id")
  @RequireOwnerRole("owner", "manager")
  async deleteException(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: PrincipalRequest) {
    const out = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{ telecaller_id: string | null; on_date: string }>(
        `DELETE FROM attendance_exceptions WHERE id = $1 RETURNING telecaller_id, on_date::text AS on_date`,
        [id],
      );
      if (!row) throw new NotFoundException("exception not found");
      const tokens = await this.exceptionSideEffects(client, orgId, row.telecaller_id, row.on_date);
      await this.audit(client, orgId, req, "attendance.exception_delete", "attendance_exception", id, row);
      return { tokens };
    });
    this.attendance.pushConfigRefresh(out.tokens);
    return { ok: true };
  }

  // ── Reads, scoped per persona ─────────────────────────────────────────────

  /** The live board: one row per telecaller, now. */
  @Get("today")
  async today(@OrgId() orgId: string, @OwnerScope() scope: OwnerRecordScope) {
    const only = ownTelecallerOnly(scope);
    const now = Date.now();
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [base],
      } = await client.query<{
        zone: string;
        today: string;
        telecallers: { id: string; name: string }[] | null;
        live: {
          telecallerId: string;
          state: HandsetState;
          stateSince: string;
          lastReceivedAt: string;
          batteryPct: number | null;
          networkOk: boolean | null;
        }[] | null;
        handsets: string[] | null;
        days: Record<string, unknown>[] | null;
        pending: { telecallerId: string; n: number }[] | null;
        unassigned: number;
      }>(
        `WITH tc AS (
           SELECT t.id, t.display_name AS name FROM telecallers t
            WHERE t.status = 'active' AND ($1::uuid IS NULL OR t.id = $1::uuid))
         SELECT o.reporting_timezone AS zone, current_date::text AS today,
                (SELECT json_agg(json_build_object('id', tc.id, 'name', tc.name) ORDER BY lower(tc.name)) FROM tc) AS telecallers,
                (SELECT json_agg(json_build_object(
                          'telecallerId', l.telecaller_id, 'state', l.state, 'stateSince', l.state_since,
                          'lastReceivedAt', l.last_received_at, 'batteryPct', l.battery_pct, 'networkOk', l.network_ok))
                   FROM attendance_live_state l WHERE l.telecaller_id IN (SELECT id FROM tc)) AS live,
                (SELECT array_agg(DISTINCT d.telecaller_id) FROM devices d
                  WHERE d.removed_at IS NULL AND d.status = 'active' AND d.telecaller_id IN (SELECT id FROM tc)) AS handsets,
                (SELECT json_agg(json_build_object(
                          'telecallerId', a.telecaller_id, 'workDate', a.work_date::text,
                          'workedSeconds', a.worked_seconds, 'breakSeconds', a.break_seconds,
                          'technicalSeconds', a.technical_seconds, 'awaySeconds', a.away_seconds, 'flags', a.flags))
                   FROM attendance_days a
                  WHERE a.telecaller_id IN (SELECT id FROM tc) AND a.work_date >= current_date - 1) AS days,
                (SELECT json_agg(json_build_object('telecallerId', r.telecaller_id, 'n', r.n)) FROM (
                   SELECT telecaller_id, count(*)::int AS n FROM attendance_requests
                    WHERE status = 'pending' AND telecaller_id IN (SELECT id FROM tc) GROUP BY 1) r) AS pending,
                CASE WHEN $1::uuid IS NULL
                     THEN (SELECT count(*)::int FROM devices d
                            WHERE d.removed_at IS NULL AND d.status = 'active' AND d.telecaller_id IS NULL)
                     ELSE 0 END AS unassigned
           FROM organizations o WHERE o.id = $2`,
        [only, orgId],
      );
      const zone = resolveTimeZone(base?.zone);
      const today = base?.today ?? todayIn(zone, now);
      const telecallers = base?.telecallers ?? [];
      const book = await loadScheduleBook(client, telecallers.map((t) => t.id), shiftDateKey(today, -1), today, zone);
      const live = new Map((base?.live ?? []).map((l) => [l.telecallerId, l]));
      const handsets = new Set(base?.handsets ?? []);
      const days = new Map((base?.days ?? []).map((d) => [`${d.telecallerId}:${d.workDate}`, d]));
      const pending = new Map((base?.pending ?? []).map((p) => [p.telecallerId, p.n]));

      const rows = telecallers.map((t) => {
        const { date, day } = workDayAt(book, t.id, now, today);
        const l = live.get(t.id) ?? null;
        const totals = days.get(`${t.id}:${date}`);
        return {
          telecallerId: t.id,
          name: t.name,
          liveState: liveBoardState({
            day,
            live: l ? { state: l.state, lastReceivedAt: new Date(l.lastReceivedAt).toISOString() } : null,
            hasHandset: handsets.has(t.id),
            now,
          }),
          stateSince: l ? new Date(l.stateSince).toISOString() : null,
          dayKind: day.kind,
          shiftStart: day.shiftStart ?? null,
          shiftEnd: day.shiftEnd ?? null,
          workedSeconds: Number(totals?.workedSeconds ?? 0),
          breakSeconds: Number(totals?.breakSeconds ?? 0),
          technicalSeconds: Number(totals?.technicalSeconds ?? 0),
          awaySeconds: Number(totals?.awaySeconds ?? 0),
          flags: (totals?.flags as string[] | undefined) ?? [],
          batteryPct: l?.batteryPct ?? null,
          networkOk: l?.networkOk ?? null,
          pendingRequests: pending.get(t.id) ?? 0,
        };
      });
      return { date: today, timeZone: zone, rows, unassignedHandsets: base?.unassigned ?? 0 };
    });
  }

  @Get("timesheets")
  async timesheets(@OrgId() orgId: string, @Query() query: unknown, @OwnerScope() scope: OwnerRecordScope) {
    const q = this.timesheetQuery(query);
    const rows = await this.db.withOrg(orgId, (client) => this.timesheetRows(client, q, scope));
    return {
      from: q.from,
      to: q.to,
      rows: rows.map((r) => ({
        telecallerId: r.telecaller_id,
        name: r.name,
        workDate: r.work_date,
        status: r.status,
        checkInAt: isoOrNull(r.check_in_at),
        checkOutAt: isoOrNull(r.check_out_at),
        workedSeconds: r.worked_seconds,
        breakSeconds: r.break_seconds,
        bookedBreakSeconds: r.booked_break_seconds,
        technicalSeconds: r.technical_seconds,
        awaySeconds: r.away_seconds,
        unknownSeconds: r.unknown_seconds,
        lateSeconds: r.late_seconds,
        overtimeSeconds: r.overtime_seconds,
        reviewCount: r.review_count,
        flags: r.flags ?? [],
      })),
    };
  }

  @Get("timesheets.csv")
  async timesheetsCsv(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
    @Res({ passthrough: true }) res: Response,
  ) {
    const q = this.timesheetQuery(query);
    const { rows, zone } = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [o],
      } = await client.query<{ zone: string }>(`SELECT reporting_timezone AS zone FROM organizations WHERE id = $1`, [orgId]);
      return { rows: await this.timesheetRows(client, q, scope), zone: resolveTimeZone(o?.zone) };
    });
    const clock = (v: Date | string | null) => {
      if (!v) return "";
      const p = zonedParts(v, zone);
      return p ? `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}` : "";
    };
    const minutes = (s: number) => Math.round((s ?? 0) / 60);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="attendance-${q.from}-to-${q.to}.csv"`);
    return toCsv(
      [
        "Telecaller",
        "Date",
        "Status",
        "Check in",
        "Check out",
        "Worked (min)",
        "Breaks (min)",
        "Booked breaks (min)",
        "Technical (min)",
        "Away (min)",
        "Unknown (min)",
        "Late (min)",
        "Overtime (min)",
        "Needs review",
        "Flags",
      ],
      rows.map((r) => [
        r.name,
        r.work_date,
        r.status,
        clock(r.check_in_at),
        clock(r.check_out_at),
        minutes(r.worked_seconds),
        minutes(r.break_seconds),
        minutes(r.booked_break_seconds),
        minutes(r.technical_seconds),
        minutes(r.away_seconds),
        minutes(r.unknown_seconds),
        minutes(r.late_seconds),
        minutes(r.overtime_seconds),
        r.review_count,
        r.flags ?? [],
      ]),
    );
  }

  /** One telecaller's day in full: the resolved schedule, the totals and every segment. */
  @Get("day")
  async day(@OrgId() orgId: string, @Query() query: unknown, @OwnerScope() scope: OwnerRecordScope) {
    const q = this.parse(DayQuery, query);
    const only = ownTelecallerOnly(scope);
    if (only !== null && only !== q.telecallerId) throw new NotFoundException("telecaller not found");
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{
        zone: string;
        found: boolean;
        summary: Record<string, unknown> | null;
        segments: Record<string, unknown>[] | null;
      }>(
        `SELECT o.reporting_timezone AS zone,
                EXISTS (SELECT 1 FROM telecallers WHERE id = $1) AS found,
                (SELECT row_to_json(d) FROM (
                   SELECT status, shift_start_at, shift_end_at, check_in_at, check_out_at, worked_seconds,
                          break_seconds, booked_break_seconds, technical_seconds, away_seconds, unknown_seconds,
                          late_seconds, overtime_seconds, review_count, flags, computed_at
                     FROM attendance_days WHERE telecaller_id = $1 AND work_date = $2::date) d) AS summary,
                (SELECT json_agg(json_build_object(
                          'id', s.id, 'startsAt', s.starts_at, 'endsAt', s.ends_at, 'class', s.class, 'rule', s.rule,
                          'needsReview', s.needs_review, 'evidence', s.evidence,
                          'overrideClass', s.override_class, 'overrideNote', ov.note) ORDER BY s.starts_at)
                   FROM attendance_segments s
                   LEFT JOIN attendance_overrides ov ON ov.id = s.override_id
                  WHERE s.telecaller_id = $1 AND s.work_date = $2::date) AS segments
           FROM organizations o WHERE o.id = $3`,
        [q.telecallerId, q.date, orgId],
      );
      if (!row?.found) throw new NotFoundException("telecaller not found");
      const zone = resolveTimeZone(row.zone);
      const book = await loadScheduleBook(client, [q.telecallerId], shiftDateKey(q.date, -1), shiftDateKey(q.date, 1), zone);
      return {
        day: book.resolve(q.telecallerId, q.date),
        summary: row.summary ? camelRow(row.summary) : null,
        segments: (row.segments ?? []).map((s) => ({
          ...s,
          startsAt: new Date(String(s.startsAt)).toISOString(),
          endsAt: new Date(String(s.endsAt)).toISOString(),
          ruleLabel: RULE_LABELS[Number(s.rule)] ?? null,
          overrideClass: s.overrideClass ?? null,
          overrideNote: s.overrideNote ?? null,
        })),
      };
    });
  }

  @Get("requests")
  async listRequests(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const q = this.parse(RequestsQuery, query);
    const mine = truthy(q.mine);
    const status = mine ? "pending" : (q.status ?? "pending");
    const only = ownTelecallerOnly(scope);
    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (status === "pending") where.push(`r.status = 'pending'`);
      if (status === "decided") where.push(`r.status <> 'pending'`);
      if (truthy(q.escalated)) where.push(`r.escalated_at IS NOT NULL`);
      if (only !== null) {
        params.push(only);
        where.push(`r.telecaller_id = $${params.length}::uuid`);
      }
      const { rows } = await client.query<RequestRow>(
        `${REQUEST_SELECT}
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY r.created_at DESC
          LIMIT 500`,
        params,
      );
      const actor = await this.attendance.actorFor(client, orgId, scope.userId);
      const { rows: outbox } = rows.length
        ? await client.query<{ request_id: string; status: string; last_error: string | null }>(
            `SELECT request_id, status, last_error FROM attendance_whatsapp_outbox WHERE request_id = ANY($1::uuid[])`,
            [rows.map((r) => r.id)],
          )
        : { rows: [] as { request_id: string; status: string; last_error: string | null }[] };
      const byRequest = new Map<string, { status: string; last_error: string | null }[]>();
      for (const o of outbox) byRequest.set(o.request_id, [...(byRequest.get(o.request_id) ?? []), o]);

      const views = rows
        .map((r) => {
          const canDecide =
            r.status === "pending" &&
            actor.membershipId !== null &&
            canDecideRequest(
              { approverMembershipId: r.approver_membership_id, telecallerId: r.telecaller_id },
              { membershipId: actor.membershipId, ownerRole: actor.ownerRole, telecallerIds: actor.telecallerIds },
            );
          return toOwnerRequestView(r, canDecide, summariseWhatsapp(byRequest.get(r.id) ?? []));
        })
        .filter((v) => !mine || v.canDecide);
      return { requests: views };
    });
  }

  /**
   * Record a leave, break or hours change for a telecaller - approved in the
   * same step (doc 33 §6.1). A person cannot record their OWN, for the same
   * reason nobody decides their own request.
   */
  @Post("requests")
  @RequireOwnerRole("owner", "manager")
  async recordOnBehalf(
    @OrgId() orgId: string,
    @Body() body: unknown,
    @OwnerScope() scope: OwnerRecordScope,
    @Req() req: PrincipalRequest,
  ) {
    const input = this.parse(OnBehalfRequestInput, body);
    const userId = this.requireUser(scope);
    const out = await this.db.withOrg(orgId, async (client) => {
      const actor = await this.attendance.actorFor(client, orgId, userId);
      if (actor.telecallerIds.includes(input.telecallerId)) {
        throw new ForbiddenException({
          code: "own_request",
          message: "You cannot record your own leave. Ask an owner.",
        });
      }
      const {
        rows: [tc],
      } = await client.query<{ zone: string }>(
        `SELECT o.reporting_timezone AS zone FROM telecallers t JOIN organizations o ON o.id = t.org_id
          WHERE t.id = $1 AND t.status = 'active'`,
        [input.telecallerId],
      );
      if (!tc) throw new NotFoundException("telecaller not found");
      const zone = resolveTimeZone(tc.zone);

      const {
        rows: [inserted],
      } = await client.query<{ id: string }>(
        `INSERT INTO attendance_requests
           (org_id, telecaller_id, kind, leave_type, start_date, end_date, half_day, starts_at, ends_at,
            reason, status, source, decided_by, decided_at, created_by)
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8::timestamptz, $9::timestamptz, $10,
                 'approved', 'on_behalf', $11::uuid, now(), $12::uuid)
         RETURNING id`,
        [
          orgId,
          input.telecallerId,
          input.kind,
          input.kind === "leave" ? input.leaveType : null,
          input.kind === "leave" ? input.startDate : null,
          input.kind === "leave" ? input.endDate : null,
          input.kind === "leave" ? (input.halfDay ?? null) : null,
          input.kind === "leave" ? null : input.startsAt,
          input.kind === "leave" ? null : input.endsAt,
          input.reason ?? null,
          userId,
          userId,
        ],
      );
      await this.markRequestDays(client, orgId, input.telecallerId, input, zone);
      await this.audit(client, orgId, req, "attendance.request_on_behalf", "attendance_request", inserted!.id, {
        telecallerId: input.telecallerId,
        kind: input.kind,
      });
      const row = await this.requestById(client, inserted!.id);
      return { row: row!, tokens: await this.attendance.deviceTokens(client, { telecallerIds: [input.telecallerId] }) };
    });
    this.attendance.pushConfigRefresh(out.tokens);
    return { request: toOwnerRequestView(out.row, false, null) };
  }

  /** Approve or reject - the assigned manager or any owner, never the requester. */
  @Post("requests/:id/decision")
  @HttpCode(200)
  @RequireOwnerRole("owner", "manager")
  async decide(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @OwnerScope() scope: OwnerRecordScope,
    @Req() req: PrincipalRequest,
  ) {
    const input = this.parse(RequestDecisionInput, body);
    const userId = this.requireUser(scope);
    const out = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [current],
      } = await client.query<{
        telecaller_id: string;
        status: string;
        approver_membership_id: string | null;
        kind: "leave" | "break" | "hours_change";
        start_date: string | null;
        end_date: string | null;
        starts_at: Date | null;
        zone: string;
      }>(
        `SELECT r.telecaller_id, r.status, r.approver_membership_id, r.kind,
                r.start_date::text AS start_date, r.end_date::text AS end_date, r.starts_at,
                o.reporting_timezone AS zone
           FROM attendance_requests r JOIN organizations o ON o.id = r.org_id
          WHERE r.id = $1
          FOR UPDATE OF r`,
        [id],
      );
      if (!current) throw new NotFoundException("request not found");
      if (current.status !== "pending") {
        throw new ConflictException({ code: "not_pending", message: "This request has already been decided or cancelled." });
      }
      const actor = await this.attendance.actorFor(client, orgId, userId);
      if (
        !actor.membershipId ||
        !canDecideRequest(
          { approverMembershipId: current.approver_membership_id, telecallerId: current.telecaller_id },
          { membershipId: actor.membershipId, ownerRole: actor.ownerRole, telecallerIds: actor.telecallerIds },
        )
      ) {
        throw new ForbiddenException({
          code: "not_your_decision",
          message: "Only this person's manager or an owner can decide this request, and never your own.",
        });
      }
      const status = input.decision === "approve" ? "approved" : "rejected";
      await client.query(
        `UPDATE attendance_requests
            SET status = $2, decided_by = $3::uuid, decided_at = now(), decision_note = $4
          WHERE id = $1`,
        [id, status, userId, input.note ?? null],
      );
      if (status === "approved") {
        await this.markRequestDays(
          client,
          orgId,
          current.telecaller_id,
          {
            kind: current.kind,
            startDate: current.start_date,
            endDate: current.end_date,
            startsAt: current.starts_at ? new Date(current.starts_at).toISOString() : null,
          },
          resolveTimeZone(current.zone),
        );
      }
      await this.audit(client, orgId, req, `attendance.request_${status === "approved" ? "approve" : "reject"}`, "attendance_request", id, {
        telecallerId: current.telecaller_id,
        note: input.note ?? null,
      });
      const row = await this.requestById(client, id);
      return { row: row!, tokens: await this.attendance.deviceTokens(client, { telecallerIds: [current.telecaller_id] }) };
    });
    this.attendance.pushConfigRefresh(out.tokens);
    return { request: toOwnerRequestView(out.row, false, null) };
  }

  // ── Review ────────────────────────────────────────────────────────────────

  @Get("review")
  @RequireOwnerRole("owner", "manager")
  async review(@OrgId() orgId: string, @Query() query: unknown) {
    const q = this.parse(RangeQuery, query);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [clock],
      } = await client.query<{ today: string }>(`SELECT current_date::text AS today`);
      const to = q.to ?? clock!.today;
      const from = q.from ?? shiftDateKey(to, -13);
      if (from > to || rangeDays(from, to) > MAX_TIMESHEET_DAYS) {
        throw new BadRequestException(`choose a range of at most ${MAX_TIMESHEET_DAYS} days`);
      }
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT s.id, s.telecaller_id AS "telecallerId", t.display_name AS "telecallerName",
                s.work_date::text AS "workDate", s.starts_at AS "startsAt", s.ends_at AS "endsAt",
                s.class, s.rule, s.evidence
           FROM attendance_segments s JOIN telecallers t ON t.id = s.telecaller_id
          WHERE s.needs_review AND s.override_class IS NULL
            AND s.work_date BETWEEN $1::date AND $2::date
          ORDER BY s.work_date DESC, s.starts_at
          LIMIT 1000`,
        [from, to],
      );
      return {
        segments: rows.map((s) => ({
          ...s,
          startsAt: isoOrNull(s.startsAt as Date),
          endsAt: isoOrNull(s.endsAt as Date),
          ruleLabel: RULE_LABELS[Number(s.rule)] ?? null,
        })),
      };
    });
  }

  /**
   * Excuse or unexcuse a stretch of time, with a note. Stored as an override
   * over the segment's time range, separate from the segment, so the worker's
   * next rebuild re-applies it whatever the new boundaries are.
   */
  @Post("segments/:id/override")
  @HttpCode(200)
  @RequireOwnerRole("owner", "manager")
  async override(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @OwnerScope() scope: OwnerRecordScope,
    @Req() req: PrincipalRequest,
  ) {
    const input = this.parse(SegmentOverrideInput, body);
    const userId = this.requireUser(scope);
    await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [seg],
      } = await client.query<{ telecaller_id: string; work_date: string; starts_at: Date; ends_at: Date }>(
        `SELECT telecaller_id, work_date::text AS work_date, starts_at, ends_at FROM attendance_segments WHERE id = $1`,
        [id],
      );
      if (!seg) throw new NotFoundException("segment not found");
      const actor = await this.attendance.actorFor(client, orgId, userId);
      if (actor.telecallerIds.includes(seg.telecaller_id)) {
        throw new ForbiddenException({ code: "own_record", message: "You cannot excuse your own time. Ask an owner." });
      }
      const {
        rows: [ov],
      } = await client.query<{ id: string }>(
        `INSERT INTO attendance_overrides
           (org_id, telecaller_id, work_date, starts_at, ends_at, override_class, note, decided_by)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8::uuid)
         RETURNING id`,
        [orgId, seg.telecaller_id, seg.work_date, seg.starts_at, seg.ends_at, input.overrideClass, input.note, userId],
      );
      await client.query(`UPDATE attendance_segments SET override_class = $2, override_id = $3 WHERE id = $1`, [
        id,
        input.overrideClass,
        ov!.id,
      ]);
      await this.attendance.markDirty(client, orgId, [{ telecallerId: seg.telecaller_id, date: seg.work_date }]);
      await this.audit(client, orgId, req, "attendance.segment_override", "attendance_segment", id, {
        overrideClass: input.overrideClass,
        note: input.note,
        telecallerId: seg.telecaller_id,
        workDate: seg.work_date,
      });
    });
    return { ok: true };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return parsed.data;
  }

  private userUuid(req: PrincipalRequest): string | null {
    const id = z.string().uuid().safeParse(req.principal?.userId);
    return id.success ? id.data : null;
  }

  private requireUser(scope: OwnerRecordScope): string {
    if (!scope.userId) {
      throw new ForbiddenException("deciding attendance needs a signed-in person - this caller has no seat");
    }
    return scope.userId;
  }

  private nameTaken(err: unknown): unknown {
    if ((err as { code?: string }).code === "23505") {
      return new ConflictException({ code: "name_taken", message: "Another shift pattern already has that name." });
    }
    return err;
  }

  private async audit(
    client: Queryable,
    orgId: string,
    req: PrincipalRequest,
    action: string,
    targetType: string,
    targetId: string,
    meta: unknown,
  ): Promise<void> {
    const actor = auditActor(req);
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [orgId, actor.type, actor.id, action, targetType, targetId, JSON.stringify(meta ?? {})],
    );
  }

  private async orgRow(client: Queryable, orgId: string) {
    const {
      rows: [row],
    } = await client.query<{
      attendance_enabled: boolean;
      leave_escalation_hours: number;
      attendance_whatsapp_alerts: boolean;
      attendance_whatsapp_channel_id: string | null;
      reporting_timezone: string | null;
    }>(
      `SELECT attendance_enabled, leave_escalation_hours, attendance_whatsapp_alerts,
              attendance_whatsapp_channel_id, reporting_timezone
         FROM organizations WHERE id = $1`,
      [orgId],
    );
    if (!row) throw new NotFoundException("organization not found");
    return row;
  }

  private async readSettings(client: Queryable, orgId: string, scope: OwnerRecordScope) {
    const {
      rows: [row],
    } = await client.query<{
      attendance_enabled: boolean;
      leave_escalation_hours: number;
      attendance_whatsapp_alerts: boolean;
      attendance_whatsapp_channel_id: string | null;
      reporting_timezone: string | null;
      channels: { id: string; label: string; provider: string; templateApproved: boolean | null }[] | null;
      no_whatsapp: { membershipId: string; name: string }[] | null;
    }>(
      `SELECT o.attendance_enabled, o.leave_escalation_hours, o.attendance_whatsapp_alerts,
              o.attendance_whatsapp_channel_id, o.reporting_timezone,
              (SELECT json_agg(json_build_object(
                        'id', c.id,
                        'label', COALESCE(NULLIF(btrim(c.display_name), ''), c.inbound_address, initcap(c.provider)),
                        'provider', c.provider,
                        'templateApproved', CASE WHEN c.provider = 'waba' THEN EXISTS (
                            SELECT 1 FROM message_templates mt
                             WHERE mt.channel_id = c.id AND mt.name = $2 AND mt.status = 'approved'
                               AND jsonb_array_length(COALESCE(mt.variables, '[]'::jsonb)) = $3) END)
                      ORDER BY c.created_at)
                 FROM messaging_channels c
                WHERE c.org_id = o.id AND c.channel = 'whatsapp' AND c.provider IN ('waba', 'wasi')
                  AND c.owner_user_id IS NULL AND c.status = 'active') AS channels,
              (SELECT json_agg(json_build_object('membershipId', a.id, 'name', a.name) ORDER BY lower(a.name)) FROM (
                 SELECT DISTINCT ON (m.user_id) m.id, COALESCE(NULLIF(btrim(u.name), ''), u.email) AS name,
                        (m.whatsapp_number IS NOT NULL AND btrim(m.whatsapp_number) <> '') AS has_number
                   FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.org_id = o.id AND m.status = 'active' AND u.status = 'active'
                    AND m.owner_role IN ('owner', 'manager')
                  ORDER BY m.user_id, (m.whatsapp_number IS NOT NULL AND btrim(m.whatsapp_number) <> '') DESC,
                           (m.scope_type = 'org') DESC, m.id) a
                WHERE NOT a.has_number) AS no_whatsapp
         FROM organizations o WHERE o.id = $1`,
      [orgId, ATTENDANCE_WABA_TEMPLATE, ATTENDANCE_WABA_TEMPLATE_PARAMS],
    );
    if (!row) throw new NotFoundException("organization not found");
    return {
      enabled: row.attendance_enabled,
      leaveEscalationHours: row.leave_escalation_hours,
      whatsappAlerts: row.attendance_whatsapp_alerts,
      whatsappChannelId: row.attendance_whatsapp_channel_id,
      timeZone: resolveTimeZone(row.reporting_timezone),
      canEditWhatsapp: scope.role === "owner",
      channels: row.channels ?? [],
      approversWithoutWhatsapp: row.no_whatsapp ?? [],
    };
  }

  private async patternById(client: Queryable, id: string) {
    const {
      rows: [row],
    } = await client.query<PatternRow>(`${PATTERN_SELECT} WHERE p.id = $1`, [id]);
    return row ? patternView(row) : null;
  }

  private async writeBreaks(client: Queryable, orgId: string, patternId: string, breaks: ShiftPatternInput["breaks"]) {
    if (breaks.length === 0) return;
    await client.query(
      `INSERT INTO shift_break_slots (org_id, shift_pattern_id, label, start_time, duration_minutes)
       SELECT $1, $2, b.label, b.start_time::time, b.duration_minutes
         FROM jsonb_to_recordset($3::jsonb) AS b(label text, start_time text, duration_minutes smallint)`,
      [
        orgId,
        patternId,
        JSON.stringify(breaks.map((b) => ({ label: b.label, start_time: b.startTime, duration_minutes: b.durationMinutes }))),
      ],
    );
  }

  /** Telecallers on a pattern today, or assigned to it from a future date. */
  private async telecallersOnPattern(client: Queryable, patternId: string): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT t.id FROM telecallers t
        WHERE t.status = 'active'
          AND ((SELECT a.shift_pattern_id FROM telecaller_shift_assignments a
                 WHERE a.telecaller_id = t.id AND a.effective_from <= current_date
                 ORDER BY a.effective_from DESC LIMIT 1) = $1
               OR EXISTS (SELECT 1 FROM telecaller_shift_assignments a
                           WHERE a.telecaller_id = t.id AND a.effective_from > current_date
                             AND a.shift_pattern_id = $1))`,
      [patternId],
    );
    return rows.map((r) => r.id);
  }

  private async markToday(client: Queryable, orgId: string, telecallerIds: string[]) {
    if (telecallerIds.length === 0) return;
    const {
      rows: [clock],
    } = await client.query<{ today: string }>(`SELECT current_date::text AS today`);
    await this.attendance.markDirty(
      client,
      orgId,
      telecallerIds.map((telecallerId) => ({ telecallerId, date: clock!.today })),
    );
  }

  /** Rebuild the date, and wake the phones whose next two days it touches. */
  private async exceptionSideEffects(
    client: Queryable,
    orgId: string,
    telecallerId: string | null,
    onDate: string,
  ): Promise<string[]> {
    if (telecallerId) await this.attendance.markDirty(client, orgId, [{ telecallerId, date: onDate }]);
    else await this.attendance.markDirtyEveryone(client, orgId, [onDate]);
    const {
      rows: [clock],
    } = await client.query<{ today: string }>(`SELECT current_date::text AS today`);
    const today = clock!.today;
    if (onDate < shiftDateKey(today, -1) || onDate > shiftDateKey(today, 1)) return [];
    return this.attendance.deviceTokens(client, telecallerId ? { telecallerIds: [telecallerId] } : { all: true });
  }

  /** The days a request's approval changes, marked for the classifier. */
  private async markRequestDays(
    client: Queryable,
    orgId: string,
    telecallerId: string,
    r: { kind: string; startDate?: string | null; endDate?: string | null; startsAt?: string | null },
    zone: string,
  ) {
    let dates: string[] = [];
    if (r.kind === "leave" && r.startDate && r.endDate) dates = leaveDates(r.startDate, r.endDate);
    else if (r.startsAt) {
      const d = dayKeyIn(r.startsAt, zone);
      if (d) dates = [shiftDateKey(d, -1), d];
    }
    await this.attendance.markDirty(client, orgId, dates.map((date) => ({ telecallerId, date })));
  }

  private async requestById(client: Queryable, id: string) {
    const {
      rows: [row],
    } = await client.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
    return row ?? null;
  }

  private timesheetQuery(query: unknown) {
    const q = this.parse(TimesheetQuery, query);
    if (q.from > q.to) throw new BadRequestException("from must not be after to");
    if (rangeDays(q.from, q.to) > MAX_TIMESHEET_DAYS) {
      throw new BadRequestException(`choose a range of at most ${MAX_TIMESHEET_DAYS} days`);
    }
    return q;
  }

  private async timesheetRows(
    client: Queryable,
    q: { from: string; to: string; telecallerId?: string },
    scope: OwnerRecordScope,
  ) {
    const only = ownTelecallerOnly(scope);
    const { rows } = await client.query<{
      telecaller_id: string;
      name: string;
      work_date: string;
      status: string;
      check_in_at: Date | null;
      check_out_at: Date | null;
      worked_seconds: number;
      break_seconds: number;
      booked_break_seconds: number;
      technical_seconds: number;
      away_seconds: number;
      unknown_seconds: number;
      late_seconds: number;
      overtime_seconds: number;
      review_count: number;
      flags: string[];
    }>(
      `SELECT d.telecaller_id, t.display_name AS name, d.work_date::text AS work_date, d.status,
              d.check_in_at, d.check_out_at, d.worked_seconds, d.break_seconds, d.booked_break_seconds,
              d.technical_seconds, d.away_seconds, d.unknown_seconds, d.late_seconds, d.overtime_seconds,
              d.review_count, d.flags
         FROM attendance_days d JOIN telecallers t ON t.id = d.telecaller_id
        WHERE d.work_date BETWEEN $1::date AND $2::date
          AND ($3::uuid IS NULL OR d.telecaller_id = $3::uuid)
          AND ($4::uuid IS NULL OR d.telecaller_id = $4::uuid)
        ORDER BY d.work_date DESC, lower(t.display_name)
        LIMIT 20000`,
      [q.from, q.to, q.telecallerId ?? null, only],
    );
    return rows;
  }
}
