import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
/**
 * A DEEP IMPORT, not `from "@aura/shared"`. `packages/shared/src/index.ts` is
 * owned by another process in this wave, so `appointments.ts` is not in the
 * barrel yet - the same workaround the dialer module and console-phone.ts
 * already use. Collapse it once the export lands.
 */
import {
  AppointmentManualStatus,
  AppointmentStatus,
  AppointmentTypeKey,
} from "@aura/shared/dist/appointments";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import {
  RecordScope,
  scopeClause,
  scopeFilter,
  type CrmRecordScope,
} from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { AppointmentRemindersService } from "./appointment-reminders.service";

/**
 * The `appointments` primitive (migration 0166, Build docs/39 §25).
 *
 * A port of the funnel's booking lifecycle into tenant scope - see 0166's
 * header for what came across and what did not. This controller is the half
 * that was NOT in the funnel: the funnel's bookings are made by strangers on a
 * public site, a tenant's are made by the person on the phone.
 *
 * ── THE ONE SCOPED OBJECT IN THIS WAVE ─────────────────────────────────────
 *
 * `appointment` is deliberately NOT in `ALL_SCOPE_ONLY_OBJECTS`: it carries
 * `assigned_user_id`, and a telecaller scoped to `owned` should see their own
 * diary and not the whole clinic's. `crm-scope.ts` already points at that
 * column, so every statement here that can return or touch somebody else's
 * booking passes through `scopeFilter` / `scopeClause`. A route that forgets
 * is not a compile error - it is a silent leak - which is why there is exactly
 * one way to build the predicate and it is greppable.
 *
 * An UNASSIGNED appointment is invisible to an `owned`-scoped role. That is
 * the intended reading, the same one `conversation` takes: a booking nobody
 * has been given belongs to whoever can see all of them.
 *
 * ── NOTHING HERE SENDS ─────────────────────────────────────────────────────
 *
 * Booking, moving and recording attendance all WRITE OUTBOX ROWS and nothing
 * more. See appointment-reminders.service.ts for the four gates that stand
 * between a row and a message, and 0166 for the owner switch that is off by
 * default.
 */

/**
 * An absolute instant, offset-bearing or Z. Same shape `call-access.ts` uses,
 * and a timestamptz column is what it lands in - 0023's comment on why a naive
 * wall-clock time breaks the first time the team travels applies here too.
 */
const Timestamp = z.string().datetime({ offset: true }).or(z.string().datetime());

const CreateAppointmentBody = z
  .object({
    appointmentType: AppointmentTypeKey,
    startsAt: Timestamp,
    endsAt: Timestamp,
    leadId: z.string().uuid().nullable().optional(),
    contactId: z.string().uuid().nullable().optional(),
    resourceId: z.string().uuid().nullable().optional(),
    assignedUserId: z.string().uuid().nullable().optional(),
    workspaceId: z.string().uuid().nullable().optional(),
    location: z.string().trim().max(500).nullable().optional(),
    meetingUrl: z.string().trim().url().max(1000).nullable().optional(),
    /**
     * `confirmed` on create is the customer saying yes on the call, which is
     * the ordinary case for a telecaller booking a site visit. Default
     * `scheduled` - the quieter of the two, since nobody has said yes yet.
     */
    status: z.enum(["scheduled", "confirmed"]).default("scheduled"),
  })
  .refine((b) => new Date(b.endsAt) > new Date(b.startsAt), {
    message: "it has to end after it starts",
    path: ["endsAt"],
  })
  /**
   * An appointment with no customer on it is a diary entry nobody can act on,
   * and - more to the point - one that no reminder can ever reach, since every
   * address the outbox resolves comes from the lead or the contact. Refusing
   * it here beats discovering it when the reminder dead-letters.
   */
  .refine((b) => Boolean(b.leadId || b.contactId), {
    message: "say who this is with - a lead or a contact",
    path: ["leadId"],
  });

/**
 * HAND-BUILT, not `CreateAppointmentBody.partial()`.
 *
 * `.partial()` keeps `.default()`, and `CreateAppointmentBody` HAS one -
 * `status` defaults to "scheduled". A `.partial()` here would therefore reset
 * a confirmed appointment to scheduled on any PATCH that did not mention
 * status, silently, which is the live bug doc 39 flags in outreach cadences
 * and warns about again for every PATCH in the plan. This is the file where
 * that shortcut would actually have fired.
 *
 * `rescheduled`, `completed` and `no_show` are not settable here either: the
 * first is produced by moving the times and the other two by the attendance
 * route. Asserting one without doing the thing it describes is how the no-show
 * report stops agreeing with the diary.
 */
const UpdateAppointmentBody = z
  .object({
    appointmentType: AppointmentTypeKey.optional(),
    startsAt: Timestamp.optional(),
    endsAt: Timestamp.optional(),
    assignedUserId: z.string().uuid().nullable().optional(),
    resourceId: z.string().uuid().nullable().optional(),
    location: z.string().trim().max(500).nullable().optional(),
    meetingUrl: z.string().trim().url().max(1000).nullable().optional(),
    outcome: z.string().trim().max(2000).nullable().optional(),
    feedback: z.record(z.string(), z.unknown()).optional(),
    status: AppointmentManualStatus.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "nothing to update")
  /**
   * Both ends or neither. Moving only `startsAt` on a 30-minute consultation
   * either inverts the window (which `appointments_ends_after_starts` refuses
   * as a 23514 nobody can read) or silently changes its length. The console
   * sends both; so must anything else.
   */
  .refine((b) => (b.startsAt === undefined) === (b.endsAt === undefined), {
    message: "move both ends or neither",
    path: ["endsAt"],
  });

const AttendanceBody = z.object({
  /** The whole question: did it happen. Separate from status - see 0166. */
  attended: z.boolean(),
  outcome: z.string().trim().max(2000).nullable().optional(),
  feedback: z.record(z.string(), z.unknown()).optional(),
});

const ListQuery = z.object({
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  status: AppointmentStatus.optional(),
  appointmentType: AppointmentTypeKey.optional(),
  assignedUserId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  resourceId: z.string().uuid().optional(),
  /** "1" / "true" - never `z.coerce.boolean()`, which makes "false" truthy. */
  unassigned: z.enum(["1", "true"]).optional(),
  attended: z.enum(["1", "true", "0", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const APPOINTMENT_COLUMNS = `a.id, a.org_id, a.workspace_id, a.appointment_type, a.lead_id,
  a.contact_id, a.resource_id, a.assigned_user_id, a.starts_at, a.ends_at, a.location,
  a.meeting_url, a.status, a.attended, a.attended_at, a.attended_by, a.outcome, a.feedback,
  a.reminder_sequence, a.calendar_event_id, a.calendar_error, a.created_at, a.updated_at`;

export const APPOINTMENT_AUDIT_SQL = `INSERT INTO audit_log
     (org_id, actor_type, actor_id, action, target_type, target_id, meta)
   VALUES ($1, $2, $3, $4, 'appointment', $5, $6::jsonb)`;

interface AppointmentRow {
  id: string;
  org_id: string;
  workspace_id: string | null;
  appointment_type: string;
  lead_id: string | null;
  contact_id: string | null;
  resource_id: string | null;
  assigned_user_id: string | null;
  starts_at: Date;
  ends_at: Date;
  location: string | null;
  meeting_url: string | null;
  status: string;
  attended: boolean | null;
  attended_at: Date | null;
  attended_by: string | null;
  outcome: string | null;
  feedback: Record<string, unknown>;
  reminder_sequence: number;
  calendar_event_id: string | null;
  calendar_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function present(row: AppointmentRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    appointmentType: row.appointment_type,
    leadId: row.lead_id,
    contactId: row.contact_id,
    resourceId: row.resource_id,
    assignedUserId: row.assigned_user_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    meetingUrl: row.meeting_url,
    status: row.status,
    attended: row.attended,
    attendedAt: row.attended_at,
    attendedBy: row.attended_by,
    outcome: row.outcome,
    feedback: row.feedback,
    reminderSequence: Number(row.reminder_sequence),
    calendarEventId: row.calendar_event_id,
    calendarError: row.calendar_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Controller("appointments")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class AppointmentsController {
  constructor(
    private readonly db: DbService,
    private readonly reminders: AppointmentRemindersService,
  ) {}

  @Get()
  @RequireCrmPermission("appointment", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace(/\$\?/g, `$${params.length}`));
      };

      if (q.from) add("a.starts_at >= $?::timestamptz", q.from);
      if (q.to) add("a.starts_at < $?::timestamptz", q.to);
      if (q.status) add("a.status = $?", q.status);
      if (q.appointmentType) add("a.appointment_type = $?", q.appointmentType);
      if (q.leadId) add("a.lead_id = $?", q.leadId);
      if (q.contactId) add("a.contact_id = $?", q.contactId);
      if (q.resourceId) add("a.resource_id = $?", q.resourceId);
      if (q.unassigned) where.push("a.assigned_user_id IS NULL");
      else if (q.assignedUserId) add("a.assigned_user_id = $?", q.assignedUserId);
      if (q.attended === "1" || q.attended === "true") where.push("a.attended IS TRUE");
      if (q.attended === "0" || q.attended === "false") where.push("a.attended IS FALSE");

      // The `owned` half of the permission grid. For an appointment that is
      // `assigned_user_id` - see common/crm-scope.ts.
      const owned = scopeFilter("appointment", recordScope, "a");
      if (owned) add(owned.sql, owned.value);

      params.push(q.limit, q.offset);
      const { rows } = await client.query<AppointmentRow & { total: string }>(
        `SELECT ${APPOINTMENT_COLUMNS}, count(*) OVER() AS total
           FROM appointments a
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY a.starts_at
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        appointments: rows.map(({ total: _total, ...row }) => present(row as AppointmentRow)),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  @Get(":id")
  @RequireCrmPermission("appointment", "view")
  async one(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // The scope predicate is on the READ as well as the list: a 404 for
      // somebody else's appointment is the right answer for an owned-scoped
      // role, and a 200 would leak a customer's name through a guessed id.
      const scoped = scopeClause("appointment", recordScope, 2, "a");
      const { rows } = await client.query<AppointmentRow>(
        `SELECT ${APPOINTMENT_COLUMNS} FROM appointments a
          WHERE a.id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!rows[0]) throw new NotFoundException("appointment not found");
      return { appointment: present(rows[0]) };
    });
  }

  @Post()
  @RequireCrmPermission("appointment", "create")
  async create(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CreateAppointmentBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<AppointmentRow>(
        `INSERT INTO appointments
           (org_id, workspace_id, appointment_type, lead_id, contact_id, resource_id,
            assigned_user_id, starts_at, ends_at, location, meeting_url, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13)
         RETURNING ${APPOINTMENT_COLUMNS.replace(/a\./g, "")}`,
        [
          orgId,
          input.workspaceId ?? null,
          input.appointmentType,
          input.leadId ?? null,
          input.contactId ?? null,
          input.resourceId ?? null,
          // Unassigned by default rather than assigned to whoever typed it: an
          // `owned`-scoped creator silently assigning themselves would make a
          // front desk's bookings invisible to the clinician they are for.
          input.assignedUserId ?? null,
          input.startsAt,
          input.endsAt,
          input.location ?? null,
          input.meetingUrl ?? null,
          input.status,
          actor.type === "user" ? actor.id : null,
        ],
      );

      // Sequence 1, in the same transaction as the booking. The funnel needed
      // a sweep for this because the public marketing role holds no grant on
      // its outbox; here the grant is already in hand, so there is no window
      // in which an appointment exists with no reminders owed.
      const queued = await this.reminders.scheduleReminders(client, {
        orgId,
        appointmentId: row.id,
        sequence: 1,
        startsAt: new Date(input.startsAt),
      });
      if (input.status === "confirmed") {
        await this.reminders.scheduleConfirmation(client, {
          orgId,
          appointmentId: row.id,
          sequence: 1,
        });
      }

      await client.query(APPOINTMENT_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "appointment.created",
        row.id,
        JSON.stringify({
          appointmentType: input.appointmentType,
          startsAt: input.startsAt,
          leadId: input.leadId ?? null,
          resourceId: input.resourceId ?? null,
          remindersQueued: queued,
        }),
      ]);

      return { appointment: present(row), remindersQueued: queued };
    });
  }

  /**
   * Change one - including moving it, which is the interesting case.
   *
   * ── A RESCHEDULE NEEDS A FRESH REMINDER SEQUENCE ───────────────────────────
   *
   * 0053's finding, and the reason its outbox is keyed on the BOOKING rather
   * than on the person: somebody who moves their Tuesday appointment to Friday
   * needs a SECOND 24h/1h/5m ladder, and under a per-person key the second one
   * would ON CONFLICT DO NOTHING into oblivion - the worst kind of bug,
   * because it looks like the feature working.
   *
   * The funnel got that for free, because rescheduling there RELEASED one slot
   * and BOOKED another, so the booking identity changed. An appointment moves
   * IN PLACE, so the sequence is explicit: bump `reminder_sequence`, kill what
   * is still pending on the old one with a reason, and queue a fresh ladder.
   * All three in one transaction, or a crash between them leaves somebody
   * being reminded about a time they moved away from.
   */
  @Patch(":id")
  @RequireCrmPermission("appointment", "edit")
  async update(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = UpdateAppointmentBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const before = await this.lockScoped(client, id, recordScope);

      if (before.attended !== null && (input.startsAt || input.status)) {
        // Attendance has been recorded, so this appointment is history.
        // Moving it would re-queue reminders for something that happened, and
        // re-opening it would make "did it happen" unanswerable for the one
        // record where it had already been answered.
        throw new ConflictException({
          code: "attendance_recorded",
          message: "Attendance is already recorded. Book a new appointment instead.",
        });
      }

      // An explicit `cancelled` dominates: somebody who moves an appointment
      // AND cancels it in one request has cancelled it, and bumping the
      // sequence to queue a fresh ladder for a booking that is not happening
      // would be the worst reading of that request.
      const cancelling = input.status === "cancelled";
      const moving = !cancelling && input.startsAt !== undefined && input.endsAt !== undefined;
      const nextSequence = moving ? Number(before.reminder_sequence) + 1 : undefined;

      const {
        rows: [row],
      } = await client.query<AppointmentRow>(
        `UPDATE appointments
            SET appointment_type = COALESCE($2, appointment_type),
                starts_at        = COALESCE($3::timestamptz, starts_at),
                ends_at          = COALESCE($4::timestamptz, ends_at),
                -- An explicit status wins over the one a move implies; a move
                -- with no status writes 'rescheduled'. Both are COALESCEd so
                -- an absent key is genuinely absent (see UpdateAppointmentBody).
                status           = COALESCE($5, $6, status),
                feedback         = COALESCE($7::jsonb, feedback),
                reminder_sequence = COALESCE($8, reminder_sequence),
                assigned_user_id = CASE WHEN $9  THEN $10 ELSE assigned_user_id END,
                resource_id      = CASE WHEN $11 THEN $12 ELSE resource_id      END,
                location         = CASE WHEN $13 THEN $14 ELSE location         END,
                meeting_url      = CASE WHEN $15 THEN $16 ELSE meeting_url      END,
                outcome          = CASE WHEN $17 THEN $18 ELSE outcome          END
          WHERE id = $1
          RETURNING ${APPOINTMENT_COLUMNS.replace(/a\./g, "")}`,
        [
          id,
          input.appointmentType ?? null,
          input.startsAt ?? null,
          input.endsAt ?? null,
          input.status ?? null,
          moving ? "rescheduled" : null,
          input.feedback ? JSON.stringify(input.feedback) : null,
          nextSequence ?? null,
          input.assignedUserId !== undefined,
          input.assignedUserId ?? null,
          input.resourceId !== undefined,
          input.resourceId ?? null,
          input.location !== undefined,
          input.location ?? null,
          input.meetingUrl !== undefined,
          input.meetingUrl ?? null,
          input.outcome !== undefined,
          input.outcome ?? null,
        ],
      );
      if (!row) throw new NotFoundException("appointment not found");

      let requeued = 0;
      if (moving) {
        await this.reminders.cancelPending(
          client,
          id,
          Number(before.reminder_sequence),
          "the appointment was moved",
        );
        requeued = await this.reminders.scheduleReminders(client, {
          orgId,
          appointmentId: id,
          sequence: Number(row.reminder_sequence),
          startsAt: row.starts_at,
        });
      } else if (cancelling) {
        // Nothing queued for an appointment that is not happening. `dead` with
        // a reason rather than deleted, for 0032's reason: the outbox is what
        // an operator consults, and a message deliberately not sent is a fact.
        await this.reminders.cancelPending(
          client,
          id,
          Number(before.reminder_sequence),
          "the appointment was cancelled",
        );
      } else if (input.status === "confirmed" && before.status !== "confirmed") {
        await this.reminders.scheduleConfirmation(client, {
          orgId,
          appointmentId: id,
          sequence: Number(row.reminder_sequence),
        });
      }

      await client.query(APPOINTMENT_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        moving ? "appointment.rescheduled" : "appointment.updated",
        id,
        JSON.stringify({
          ...input,
          previousStatus: before.status,
          previousStartsAt: moving ? before.starts_at : undefined,
          sequence: Number(row.reminder_sequence),
          remindersQueued: requeued,
        }),
      ]);

      return { appointment: present(row), remindersQueued: requeued };
    });
  }

  /**
   * Did it happen?
   *
   * ── A ROUTE OF ITS OWN, BECAUSE IT IS A DIFFERENT QUESTION ────────────────
   *
   * 0053 learned that "did it happen" is not "what state is the booking in",
   * and conflating them makes no-show reporting unanswerable: a cancelled
   * appointment is not a no-show, a completed one nobody turned up to is, and
   * an appointment can sit in any status with attendance still unknown. So
   * `attended` is its own column, written by its own route, with its own
   * provenance - and `status` follows FROM the verdict rather than standing in
   * for it.
   *
   * The no-show number is the pitch (§25): a clinic's no-show is a dead chair
   * nobody can resell, a coaching demo no-show is a lost admission worth a
   * term's fees. It is only a number anybody can quote if this route is the
   * only way it is written.
   */
  @Post(":id/attendance")
  @RequireCrmPermission("appointment", "edit")
  async attendance(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = AttendanceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const before = await this.lockScoped(client, id, recordScope);
      if (before.status === "cancelled") {
        // Nobody attended something that was called off, and recording a
        // no-show against it would inflate the one number this primitive
        // exists to produce.
        throw new ConflictException({
          code: "appointment_cancelled",
          message: "This was cancelled - there is no attendance to record.",
        });
      }

      const recordedAt = new Date();
      const {
        rows: [row],
      } = await client.query<AppointmentRow>(
        `UPDATE appointments
            SET attended    = $2,
                attended_at = $3::timestamptz,
                attended_by = $4,
                status      = CASE WHEN $2 THEN 'completed' ELSE 'no_show' END,
                outcome     = CASE WHEN $5 THEN $6 ELSE outcome END,
                feedback    = COALESCE($7::jsonb, feedback)
          WHERE id = $1
          RETURNING ${APPOINTMENT_COLUMNS.replace(/a\./g, "")}`,
        [
          id,
          input.attended,
          recordedAt.toISOString(),
          // Nullable even beside a non-null attended_at, unlike 0111's
          // release-has-actor pair: the admin-key path has no `users` row and
          // the FK would refuse "admin-key". The audit row names the actor.
          actor.type === "user" ? actor.id : null,
          input.outcome !== undefined,
          input.outcome ?? null,
          input.feedback ? JSON.stringify(input.feedback) : null,
        ],
      );
      if (!row) throw new NotFoundException("appointment not found");

      const sequence = Number(row.reminder_sequence);
      // Whatever is still queued describes an appointment that has now
      // happened (or not). "Your appointment is in an hour" after the fact is
      // worse than silence.
      await this.reminders.cancelPending(client, id, sequence, "the appointment is over");

      const queued = input.attended
        ? await this.reminders.scheduleAttendedNote(client, {
            orgId,
            appointmentId: id,
            sequence,
            recordedAt,
          })
        : await this.reminders.scheduleNoShowDrip(client, {
            orgId,
            appointmentId: id,
            sequence,
            recordedAt,
          });

      await client.query(APPOINTMENT_AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        input.attended ? "appointment.attended" : "appointment.no_show",
        id,
        JSON.stringify({
          attended: input.attended,
          previousStatus: before.status,
          messagesQueued: queued,
        }),
      ]);

      return { appointment: present(row), messagesQueued: queued };
    });
  }

  /**
   * Lock the row, honouring the caller's record scope.
   *
   * `FOR UPDATE` in a statement of its own and OUTSIDE any CTE - the same rule
   * the hold sweep follows: two people moving one appointment at once is
   * ordinary, and a lazy CTE does not lock what you think it locks. The lock
   * is granted only after any concurrent writer commits, so `before` is the
   * latest committed version rather than the snapshot's - which is what makes
   * the "attendance already recorded" check above mean anything.
   *
   * The scope predicate is INSIDE the locking read, so an `owned`-scoped role
   * gets a 404 for somebody else's booking rather than locking it and then
   * being refused.
   */
  private async lockScoped(
    client: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
    id: string,
    recordScope: CrmRecordScope,
  ): Promise<AppointmentRow> {
    const scoped = scopeClause("appointment", recordScope, 2, "a");
    const { rows } = await client.query<AppointmentRow>(
      `SELECT ${APPOINTMENT_COLUMNS} FROM appointments a
        WHERE a.id = $1 ${scoped ? `AND ${scoped}` : ""}
        FOR UPDATE`,
      scoped ? [id, recordScope.userId] : [id],
    );
    if (!rows[0]) throw new NotFoundException("appointment not found");
    return rows[0];
  }
}
