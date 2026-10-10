import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  CALLBACK_RULES_VERSION,
  CallbackPolicy,
  CallbackPolicyInput,
  CallbackSection,
  DEFAULT_CALLBACK_POLICY,
  type CallbackStatus,
  callbackMetrics,
  callbackSection,
  callbackToTask,
  canTransition,
  classifyCallback,
  escalationLadder,
  isCallingDay,
  placeInCallingHours,
  priorityScore,
  reminderSchedule,
  resolveTimeZone,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import {
  RecordScope,
  scopeClause,
  scopeFilter,
  type CrmRecordScope,
} from "../../common/crm-scope";
import { FeatureGateGuard, RequireCapability, RequireGatedFeature } from "../../common/feature-gate.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { CallbacksService } from "./callbacks.service";

/**
 * §10A.9's API - the to-call list and everything a person does to it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  FOUR GUARDS, AND EACH ANSWERS A DIFFERENT QUESTION
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   AdminKeyGuard        who is calling
 *   TenantGuard          which workspace
 *   FeatureGateGuard     §3A: is the assistant on for this person, with the
 *                        `callbacks` capability
 *   CrmPermissionsGuard  §10A.9: "all endpoints enforce the feature gate AND
 *                        role permissions; telecallers see only their own list"
 *
 * The last two are NOT redundant and the distinction matters. The gate is "has
 * this business bought and switched on the call-back list"; the grid is "may
 * THIS person see somebody else's". An owner who switched the feature on for
 * their whole floor has not thereby given every telecaller the floor's list,
 * and a manager with `callback:view` at `all` scope still sees nothing if the
 * feature is off.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  NOTHING HERE SENDS, AND NOTHING HERE DIALS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "Call now" in the console does not place a call from the server - it hands
 * the telecaller a number to ring, through the vault's own
 * `contact_number:view` route, which is gated separately and audited. This
 * controller writes rows: a snooze, a reschedule, an attempt, a completion, a
 * reassignment. The reminders are rows too; the sweep that turns one into a
 * popup lives in the worker.
 */

const Timestamp = z.string().datetime({ offset: true }).or(z.string().datetime());

const MyListQuery = z.object({
  section: CallbackSection.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const TeamQuery = z.object({
  assignedUserId: z.string().uuid().optional(),
  telecallerId: z.string().uuid().optional(),
  status: z.string().max(40).optional(),
  /** "1" / "true" - never `z.coerce.boolean()`, which makes "false" truthy. */
  overdue: z.enum(["1", "true"]).optional(),
  committed: z.enum(["1", "true", "0", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const SnoozeBody = z.object({
  /** §10A.3's quick actions: 5/15/30 or custom. Bounded, not free. */
  minutes: z.number().int().min(1).max(24 * 60),
  reason: z.string().trim().max(300).nullish(),
});

const RescheduleBody = z.object({
  dueAt: Timestamp,
  reason: z.string().trim().max(300).nullish(),
});

const CompleteBody = z.object({
  /** §10A.3: "Done (with disposition)". */
  outcome: z.string().trim().min(1).max(80),
  notes: z.string().trim().max(2000).nullish(),
});

const AttemptBody = z.object({
  /** §10A.3's "Can't reach" - increments attempts, does NOT mark it missed. */
  connected: z.boolean(),
  durationSeconds: z.number().int().min(0).max(86_400).nullish(),
  notes: z.string().trim().max(2000).nullish(),
});

const ReassignBody = z.object({
  assignedUserId: z.string().uuid().nullish(),
  assignedTelecallerId: z.string().uuid().nullish(),
  reason: z.string().trim().min(1).max(300),
});

const CreateBody = z.object({
  leadId: z.string().uuid(),
  contactId: z.string().uuid().nullish(),
  dueAt: Timestamp,
  /** Did the CUSTOMER give this time? Drives escalation (§10A.5). */
  committed: z.boolean(),
  requestedText: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  assignedUserId: z.string().uuid().nullish(),
  assignedTelecallerId: z.string().uuid().nullish(),
});

const SimulateBody = z.object({
  /** §10A.6 step 9: "a dry run on sample transcripts". */
  phrases: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  /** The instant to resolve against - the call's end in a real run. */
  reference: Timestamp.optional(),
  /** The policy to try, so the wizard can preview a change before saving it. */
  policy: CallbackPolicy.optional(),
});

const MetricsQuery = z.object({
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  assignedUserId: z.string().uuid().optional(),
});

const CALLBACK_COLUMNS = `cb.id, cb.lead_id, cb.contact_id, cb.contact_name,
  cb.contact_phone_last3, cb.contact_number_id, cb.preferred_language,
  cb.source_call_id, cb.source_run_id, cb.assigned_user_id, cb.assigned_telecaller_id,
  cb.original_user_id, cb.assignment_reason, cb.type, cb.committed, cb.requested_text,
  cb.evidence, cb.condition_text, cb.due_at, cb.window_start, cb.window_end,
  cb.requested_due_at, cb.moved_reason, cb.needs_confirmation, cb.priority_score,
  cb.priority_reason, cb.status, cb.attempts, cb.max_attempts, cb.last_attempt_at,
  cb.next_attempt_at, cb.completed_at, cb.outcome, cb.auto_completed, cb.notes,
  cb.superseded_by, cb.converted_task_id, cb.created_at, cb.updated_at`;

@Controller("callbacks")
@UseGuards(AdminKeyGuard, TenantGuard, FeatureGateGuard, CrmPermissionsGuard)
@RequireGatedFeature("transcript_agent")
@RequireCapability("callbacks")
export class CallbacksController {
  constructor(
    private readonly db: DbService,
    private readonly callbacks: CallbacksService,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * `GET /callbacks/my-list` - §10A.3's sectioned to-call list.
   *
   * ── SECTIONED HERE AND NOT IN SQL ──────────────────────────────────────
   *
   * §10A.3's four sections (Overdue, Due now, Upcoming today, Later) are
   * boundaries against `now` and the org's grace period, and `callbackSection`
   * in @aura/shared is the one definition of them. Expressing them as four SQL
   * predicates would be a second definition that drifts - and the console shows
   * the same sections, from the same function, which is how the list on screen
   * and the list the sweep acts on stay the same list.
   */
  @Get("my-list")
  @RequireCrmPermission("callback", "view")
  async myList(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Query() query: unknown) {
    const { section, limit } = MyListQuery.parse(query);
    const userId = req.principal?.userId;
    if (!userId) throw new BadRequestException("no signed-in person to list for");

    return this.db.withOrg(orgId, async (client) => {
      const { timeZone, policy } = await this.callbacks.context(client);
      const { rows } = await client.query(
        `SELECT ${CALLBACK_COLUMNS},
                COALESCE(l.contact_name, l.title) AS lead_name, l.temperature, l.stage
           FROM callbacks cb
           LEFT JOIN leads l ON l.id = cb.lead_id
          WHERE cb.status IN ('scheduled','due','reminded','in_progress','missed','escalated')
            AND (cb.assigned_user_id = $1
              OR cb.assigned_telecaller_id IN (SELECT id FROM telecallers WHERE user_id = $1))
          ORDER BY cb.priority_score DESC, cb.due_at
          LIMIT $2`,
        [userId, limit],
      );

      const now = new Date();
      const items = rows.map((row) => ({
        ...row,
        section: callbackSection({ dueAt: new Date(row.due_at as string) }, now, timeZone, policy),
      }));

      return {
        timeZone,
        sections: {
          overdue: items.filter((i) => i.section === "overdue"),
          due_now: items.filter((i) => i.section === "due_now"),
          today: items.filter((i) => i.section === "today"),
          later: items.filter((i) => i.section === "later"),
        },
        items: section ? items.filter((i) => i.section === section) : items,
        // The telecaller's own snooze choices, so the popup and the list offer
        // the same ones the owner configured.
        snoozeOptionsMinutes: policy.snoozeOptionsMinutes,
      };
    });
  }

  /** `GET /callbacks/team` - §10A.3's manager view. */
  @Get("team")
  @RequireCrmPermission("callback", "view")
  async team(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const q = TeamQuery.parse(query);

    return this.db.withOrg(orgId, async (client) => {
      const { timeZone, policy } = await this.callbacks.context(client);
      // §10A.9: "telecallers see only their own list." The scope clause is the
      // enforcement, and it is the SAME helper every other scoped object uses -
      // a hand-written `assigned_user_id = $n` here would be a second
      // implementation of the rule and the one that gets forgotten.
      const owned = scopeFilter("callback", recordScope, "cb");

      const params: unknown[] = [];
      const where: string[] = [];
      const bind = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };

      if (owned) where.push(owned.sql.replace(/\$\?/g, () => bind(owned.value)));
      if (q.assignedUserId) where.push(`cb.assigned_user_id = ${bind(q.assignedUserId)}`);
      if (q.telecallerId) where.push(`cb.assigned_telecaller_id = ${bind(q.telecallerId)}`);
      if (q.status) where.push(`cb.status = ${bind(q.status)}`);
      if (q.overdue) {
        where.push(
          `cb.status IN ('scheduled','due','reminded','missed','escalated')
             AND cb.due_at < now() - (${bind(policy.graceMinutes)} || ' minutes')::interval`,
        );
      }
      if (q.committed === "1" || q.committed === "true") where.push("cb.committed");
      if (q.committed === "0" || q.committed === "false") where.push("NOT cb.committed");

      const { rows } = await client.query(
        `SELECT ${CALLBACK_COLUMNS},
                COALESCE(l.contact_name, l.title) AS lead_name, l.temperature,
                COALESCE(u.name, u.email) AS assignee_name,
                t.display_name AS telecaller_name
           FROM callbacks cb
           LEFT JOIN leads l ON l.id = cb.lead_id
           LEFT JOIN users u ON u.id = cb.assigned_user_id
           LEFT JOIN telecallers t ON t.id = cb.assigned_telecaller_id
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY cb.due_at DESC
          LIMIT ${bind(q.limit)} OFFSET ${bind(q.offset)}`,
        params,
      );

      const now = new Date();
      return {
        timeZone,
        items: rows.map((row) => ({
          ...row,
          section: callbackSection({ dueAt: new Date(row.due_at as string) }, now, timeZone, policy),
        })),
      };
    });
  }

  @Get(":id")
  @RequireCrmPermission("callback", "view")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // `scopeClause` returns the predicate with `$2` already substituted, and
      // `scopeFilter` carries the VALUE for it. Two calls because the pair is
      // what the helper offers - a hand-written `assigned_user_id = $2` here
      // would be a second implementation of §10A.9's "telecallers see only
      // their own list", and the one that gets forgotten.
      const predicate = scopeClause("callback", recordScope, 2, "cb");
      const filter = scopeFilter("callback", recordScope, "cb");
      const { rows } = await client.query(
        `SELECT ${CALLBACK_COLUMNS}, COALESCE(l.contact_name, l.title) AS lead_name
           FROM callbacks cb
           LEFT JOIN leads l ON l.id = cb.lead_id
          WHERE cb.id = $1 ${predicate ? `AND ${predicate}` : ""}`,
        filter ? [id, filter.value] : [id],
      );
      const callback = rows[0];
      if (!callback) throw new NotFoundException("callback not found");

      const { rows: reminders } = await client.query(
        `SELECT id, kind, channel, scheduled_at, delivered_at, acted_at, state, held_reason
           FROM callback_reminders WHERE callback_id = $1 ORDER BY scheduled_at`,
        [id],
      );
      const { rows: escalations } = await client.query(
        `SELECT e.id, e.level, e.recipient_kind, e.recipient_user_id, e.channel, e.action,
                e.scheduled_at, e.sent_at, e.acknowledged_at, e.outcome, e.outcome_reason,
                COALESCE(u.name, u.email) AS recipient_name
           FROM callback_escalations e
           LEFT JOIN users u ON u.id = e.recipient_user_id
          WHERE e.callback_id = $1 ORDER BY e.level`,
        [id],
      );

      return { callback, reminders, escalations };
    });
  }

  // ── actions (§10A.9) ─────────────────────────────────────────────────────

  @Post(":id/snooze")
  @RequireCrmPermission("callback", "edit")
  async snooze(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const input = SnoozeBody.parse(body);
    return this.db.withOrg(orgId, async (client) => {
      const current = await this.callbacks.claim(client, id, recordScope);
      const { timeZone, policy } = await this.callbacks.context(client);

      // A snooze is a NEW due time, so it obeys calling hours like any other.
      // Snoozing a 20:50 callback by 30 minutes must not put it at 21:20.
      const naive = new Date(Date.now() + input.minutes * 60_000);
      const placed = placeInCallingHours(naive, policy, timeZone);

      await this.callbacks.reschedule(client, orgId, req, {
        id,
        current,
        dueAt: placed.dueAt,
        movedReason: placed.moved ? placed.reason : null,
        event: "snoozed",
        reason: input.reason ?? `snoozed ${input.minutes} minutes`,
        policy,
        timeZone,
      });

      return { dueAt: placed.dueAt, moved: placed.moved, movedReason: placed.reason };
    });
  }

  @Post(":id/reschedule")
  @RequireCrmPermission("callback", "edit")
  async reschedule(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const input = RescheduleBody.parse(body);
    return this.db.withOrg(orgId, async (client) => {
      const current = await this.callbacks.claim(client, id, recordScope);
      const { timeZone, policy } = await this.callbacks.context(client);
      const placed = placeInCallingHours(new Date(input.dueAt), policy, timeZone);

      await this.callbacks.reschedule(client, orgId, req, {
        id,
        current,
        dueAt: placed.dueAt,
        movedReason: placed.moved ? placed.reason : null,
        event: "rescheduled",
        reason: input.reason ?? null,
        policy,
        timeZone,
      });

      return { dueAt: placed.dueAt, moved: placed.moved, movedReason: placed.reason };
    });
  }

  @Post(":id/complete")
  @RequireCrmPermission("callback", "edit")
  async complete(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const input = CompleteBody.parse(body);
    return this.db.withOrg(orgId, async (client) => {
      const current = await this.callbacks.claim(client, id, recordScope);
      if (!canTransition(current.status as CallbackStatus, "completed")) {
        throw new ConflictException(`a ${current.status} callback cannot be completed`);
      }

      await client.query(
        `UPDATE callbacks
            SET status = 'completed', completed_at = now(), outcome = $2,
                notes = COALESCE($3, notes), auto_completed = false, updated_at = now()
          WHERE id = $1`,
        [id, input.outcome, input.notes ?? null],
      );
      // §10A.4: a reminder for a callback that is done is noise. Cancelled
      // rather than deleted, so the delivery history survives the completion.
      await this.callbacks.cancelPending(client, id, "the callback was completed");
      await this.callbacks.audit(client, orgId, req, id, "completed", current, {
        outcome: input.outcome,
      });
      return { ok: true };
    });
  }

  /**
   * §10A.3's "Can't reach", and §10A.5's retry rules.
   *
   * ── AN ATTEMPT IS NOT A MISS ───────────────────────────────────────────
   *
   * §10A.5: "an unanswered attempt is NOT 'missed'; it counts as an attempt and
   * follows the retry rules." So this records the attempt, schedules the next
   * one, and leaves the status alone. A telecaller who rang and got no answer
   * did their job; escalating them to their manager for it is how a floor
   * learns the system is wrong about them.
   */
  @Post(":id/attempt")
  @RequireCrmPermission("callback", "edit")
  async attempt(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const input = AttemptBody.parse(body);
    return this.db.withOrg(orgId, async (client) => {
      const current = await this.callbacks.claim(client, id, recordScope);
      const { timeZone, policy } = await this.callbacks.context(client);
      return this.callbacks.recordAttempt(client, orgId, req, {
        id,
        current,
        connected: input.connected,
        durationSeconds: input.durationSeconds ?? null,
        notes: input.notes ?? null,
        policy,
        timeZone,
      });
    });
  }

  /**
   * §10A.3's Reassign, and §10A.5's level-3 action.
   *
   * ── `all` SCOPE ONLY, ENFORCED INLINE ──────────────────────────────────
   *
   * Handing work to another person is a decision about somebody else's day, so
   * it is not the same cell as editing your own callback. There is no
   * `callback:reassign` action - the grid has three verbs and a fourth for one
   * route would be a cell nobody understands - so it is checked here, against
   * the SCOPE the grid already resolved.
   *
   * Inline means `grep` for a decorator does not find it. That is the trap
   * 0141's assign-up check fell into, so it is stated here and asserted in
   * `callbacks.controller.spec.ts`.
   */
  @Post(":id/reassign")
  @RequireCrmPermission("callback", "edit")
  async reassign(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const input = ReassignBody.parse(body);
    if (recordScope.scope !== "all") {
      throw new ForbiddenException(
        "Only somebody who can see the whole team's call-backs may hand one to another person.",
      );
    }
    if (!input.assignedUserId && !input.assignedTelecallerId) {
      throw new BadRequestException("say who it goes to");
    }

    return this.db.withOrg(orgId, async (client) => {
      const current = await this.callbacks.claim(client, id, recordScope);
      return this.callbacks.reassign(client, orgId, req, {
        id,
        current,
        assignedUserId: input.assignedUserId ?? null,
        assignedTelecallerId: input.assignedTelecallerId ?? null,
        reason: input.reason,
      });
    });
  }

  /**
   * A callback made BY HAND, from the console.
   *
   * Not every callback comes from a transcript: a telecaller on a call the
   * assistant did not read still needs to write down what they promised.
   * `source_run_id` is null for these, which is how the §13 accuracy numbers
   * stay about the assistant rather than about the floor.
   */
  @Post()
  @RequireCrmPermission("callback", "create")
  async create(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const input = CreateBody.parse(body);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { timeZone, policy } = await this.callbacks.context(client);
      const placed = placeInCallingHours(new Date(input.dueAt), policy, timeZone);

      const assignedUserId = input.assignedUserId ?? actorUserId(actor);
      if (!assignedUserId && !input.assignedTelecallerId) {
        throw new BadRequestException("say who this call-back belongs to");
      }

      return this.callbacks.create(client, orgId, req, {
        leadId: input.leadId,
        contactId: input.contactId ?? null,
        dueAt: placed.dueAt,
        requestedDueAt: new Date(input.dueAt),
        movedReason: placed.moved ? placed.reason : null,
        committed: input.committed,
        type: input.committed ? "exact" : "vague",
        requestedText: input.requestedText ?? null,
        notes: input.notes ?? null,
        assignedUserId,
        assignedTelecallerId: input.assignedTelecallerId ?? null,
        policy,
        timeZone,
        gateDecisionRunId: null,
        sourceCallId: null,
        sourceRunId: null,
        sourceIntentId: null,
        evidence: [],
        needsConfirmation: !input.committed,
        conditionText: null,
      });
    });
  }

  // ── the owner's policy (§10A.6) ──────────────────────────────────────────

  @Get("policy/current")
  @RequireCrmPermission("callback", "view")
  async policy(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { timeZone, policy, isDefault } = await this.callbacks.context(client);
      return { policy, timeZone, isDefault, rulesVersion: CALLBACK_RULES_VERSION };
    });
  }

  /**
   * `PUT /callbacks/policy` - the setup wizard's save (§10A.6 step 10).
   *
   * ── EFFECTIVE-DATED, AND THE OLD ROW IS KEPT ───────────────────────────
   *
   * "Settings are effective-dated and audited; changes apply to new callbacks,
   * with an option to re-apply to open ones."
   *
   * So a save CLOSES the open row and inserts a new one rather than updating in
   * place. A callback created in March escalated by March's ladder, and an
   * owner who tightens the grace period in June has not retroactively made
   * February's callbacks late.
   */
  @Put("policy")
  @RequireCrmPermission("callback", "edit")
  async setPolicy(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const input = CallbackPolicyInput.parse(body);
    if (!input.ladder.some((level) => level.level === 0)) {
      throw new BadRequestException("the ladder needs a level 0 - somebody has to be told first");
    }

    const { reason, reapplyToOpen, ...policy } = input;

    return this.db.withOrg(orgId, async (client) => {
      const before = await this.callbacks.openPolicyRow(client);
      await client.query(
        `UPDATE callback_policies SET effective_to = now()
          WHERE effective_to IS NULL`,
      );
      const { rows } = await client.query(
        `INSERT INTO callback_policies (org_id, params, rules_version, set_by, reason)
         VALUES ($1, $2::jsonb, $3, $4, $5)
         RETURNING id, params, effective_from, rules_version`,
        [
          orgId,
          JSON.stringify(policy),
          CALLBACK_RULES_VERSION,
          actorUserId(auditActor(req)),
          reason ?? null,
        ],
      );

      let reapplied = 0;
      if (reapplyToOpen) {
        // §10A.6 step 10's option. Re-places every OPEN callback inside the new
        // calling hours and re-plans its reminders. Deliberately NOT a mass
        // re-resolution of the original phrases: those were resolved against
        // the policy in force at the time, and re-reading them now would move
        // commitments the customer was told about.
        reapplied = await this.callbacks.reapplyPolicy(client, orgId, policy);
      }

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'callbacks.policy_updated', 'callback_policy', $4, $5::jsonb)`,
        [
          orgId,
          auditActor(req).type,
          auditActor(req).id,
          rows[0]!.id,
          JSON.stringify({ reapplied, had_previous: before !== null, reason: reason ?? null }),
        ],
      );

      return { policy: rows[0], reapplied };
    });
  }

  /**
   * `POST /callbacks/simulate` - §10A.6 step 9's dry run.
   *
   * "A dry run on sample transcripts showing what would be scheduled, when
   * reminders fire, and who would be escalated, WITH NOTHING SENT."
   *
   * ── IT WRITES NOTHING AT ALL, NOT EVEN A ROW ───────────────────────────
   *
   * Every function it calls is pure (`classifyCallback`, `placeInCallingHours`,
   * `reminderSchedule`, `escalationLadder`, `priorityScore`). There is no
   * transaction to roll back and no outbox row to forget to clean up, which is
   * the only way a "simulate" button is trustworthy: a dry run implemented as
   * "do it and undo it" is one failed rollback away from being a real run.
   */
  @Post("simulate")
  @RequireCrmPermission("callback", "view")
  async simulate(@OrgId() orgId: string, @Body() body: unknown) {
    const input = SimulateBody.parse(body);

    const { timeZone, policy: stored } = await this.db.withOrg(orgId, (client) =>
      this.callbacks.context(client),
    );
    const policy = input.policy ?? stored;
    const reference = input.reference ? new Date(input.reference) : new Date();

    return {
      timeZone,
      reference: reference.toISOString(),
      results: input.phrases.map((phrase) => {
        const classified = classifyCallback(phrase, {
          reference,
          timeZone,
          dayEndMinute: policy.callingEndMinute,
          dayStartMinute: policy.callingStartMinute,
          workingWeekdays: policy.callingWeekdays,
          holidays: policy.holidays,
          policy,
        });

        if (classified.isStopRequest) {
          return {
            phrase,
            outcome: "not_a_callback" as const,
            explanation:
              "This is a request to stop calling, so it becomes a do-not-contact rather than a call-back.",
          };
        }
        if (!classified.dueAt) {
          return {
            phrase,
            outcome: "needs_a_person" as const,
            explanation: classified.reason,
          };
        }

        const placed = placeInCallingHours(classified.dueAt, policy, timeZone);
        const priority = priorityScore({
          committed: classified.committed,
          type: classified.type,
          overdueMinutes: 0,
          attempts: 0,
          leadValueMinor: null,
          moneyAtRiskMinor: null,
          temperature: null,
          lateStage: false,
        });

        return {
          phrase,
          outcome: "scheduled" as const,
          type: classified.type,
          committed: classified.committed,
          needsConfirmation: classified.needsConfirmation,
          explanation: classified.reason,
          requestedDueAt: classified.dueAt.toISOString(),
          dueAt: placed.dueAt.toISOString(),
          moved: placed.moved,
          movedReason: placed.reason,
          onACallingDay: isCallingDay(placed.dueAt.toISOString().slice(0, 10), policy),
          priority,
          reminders: reminderSchedule(placed.dueAt, policy, reference).map((r) => ({
            kind: r.kind,
            at: r.at.toISOString(),
            channels: r.channels,
          })),
          // §10A.5: escalation only for committed callbacks by default, so the
          // simulation shows an empty ladder for a vague one - which is the
          // thing an owner most needs to see before they trust it.
          escalations: classified.committed || !policy.escalateCommittedOnly
            ? escalationLadder(placed.dueAt, policy).map((level) => ({
                level: level.level,
                at: level.at.toISOString(),
                recipients: level.recipients,
                channels: level.channels,
                action: level.action,
              }))
            : [],
        };
      }),
    };
  }

  /** `GET /callbacks/metrics` - §10A.8. */
  @Get("metrics/summary")
  @RequireCrmPermission("callback", "view")
  async metrics(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const q = MetricsQuery.parse(query);

    return this.db.withOrg(orgId, async (client) => {
      const { policy } = await this.callbacks.context(client);
      const owned = scopeFilter("callback", recordScope, "cb");
      const params: unknown[] = [
        q.from ?? null,
        q.to ?? null,
        q.assignedUserId ?? null,
        policy.graceMinutes,
      ];
      const ownedSql = owned ? ` AND ${owned.sql.replace(/\$\?/g, () => `$${params.push(owned.value)}`)}` : "";

      const { rows } = await client.query<Record<string, string>>(
        `SELECT
           count(*) FILTER (WHERE cb.committed) AS committed_total,
           count(*) FILTER (
             WHERE cb.committed AND cb.status = 'completed'
               AND cb.completed_at <= cb.due_at + ($4 || ' minutes')::interval
           ) AS committed_on_time,
           count(*) FILTER (WHERE cb.status = 'completed') AS completed_total,
           count(*) FILTER (WHERE cb.status IN ('missed','escalated')) AS missed_total,
           COALESCE(sum(
             GREATEST(0, EXTRACT(EPOCH FROM (cb.completed_at - cb.due_at)) / 60)
           ) FILTER (WHERE cb.status = 'completed'), 0) AS total_delay_minutes,
           count(*) FILTER (WHERE cb.status = 'completed' AND cb.completed_at IS NOT NULL) AS delay_samples,
           COALESCE(sum(cb.attempts), 0) AS retries,
           count(*) FILTER (WHERE cb.attempts > 1) AS retried_total,
           count(*) FILTER (WHERE cb.attempts > 1 AND cb.status = 'completed') AS retried_completed,
           (SELECT count(*) FROM callback_escalations e
             WHERE e.sent_at IS NOT NULL
               AND e.callback_id IN (SELECT id FROM callbacks)) AS escalations,
           count(*) FILTER (
             WHERE cb.status = 'completed'
               AND EXISTS (SELECT 1 FROM leads l WHERE l.id = cb.lead_id AND l.status = 'converted')
           ) AS converted_after_callback
         FROM callbacks cb
        WHERE ($1::timestamptz IS NULL OR cb.due_at >= $1)
          AND ($2::timestamptz IS NULL OR cb.due_at < $2)
          AND ($3::uuid IS NULL OR cb.assigned_user_id = $3)
          ${ownedSql}`,
        params,
      );

      const row = rows[0] ?? {};
      const n = (key: string) => Number(row[key] ?? 0);
      return {
        metrics: callbackMetrics({
          committedTotal: n("committed_total"),
          committedOnTime: n("committed_on_time"),
          completedTotal: n("completed_total"),
          missedTotal: n("missed_total"),
          totalDelayMinutes: n("total_delay_minutes"),
          delaySamples: n("delay_samples"),
          escalations: n("escalations"),
          retries: n("retries"),
          retriedTotal: n("retried_total"),
          retriedCompleted: n("retried_completed"),
          convertedAfterCallback: n("converted_after_callback"),
        }),
        graceMinutes: policy.graceMinutes,
      };
    });
  }
}

/** Re-exported so the module file and the spec share one name for the default. */
export { DEFAULT_CALLBACK_POLICY, callbackToTask, resolveTimeZone };
