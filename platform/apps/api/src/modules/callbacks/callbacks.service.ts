import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  type CallbackPolicy,
  type CallbackStatus,
  type CallbackType,
  DEFAULT_CALLBACK_POLICY,
  DEFAULT_TIME_ZONE,
  canTransition,
  nextCallbackRetryAt,
  placeInCallingHours,
  priorityScore,
  reminderSchedule,
  resolveTimeZone,
} from "@aura/shared";
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { scopeClause, scopeFilter, type CrmRecordScope } from "../../common/crm-scope";

/**
 * Everything more than one route does to a callback, in one place.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY A SERVICE WHEN THE RESOURCE MODULE HAS NONE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The same reason `AppointmentRemindersService` exists: several routes write
 * the same rules, and the rules are easy to get subtly wrong in a way nothing
 * fails loudly about.
 *
 * Six routes change a callback's due time (snooze, reschedule, attempt,
 * reassign, the policy re-apply, and the worker's retry), and every one of them
 * has to do the SAME four things: clamp into calling hours, cancel the
 * reminders that are now wrong, plan the ones that are now right, and
 * re-compute the priority. A route that does three of the four leaves a
 * telecaller with a popup for a time that has moved - which looks like the
 * system being wrong about them, which is how a floor stops trusting the list.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  EVERY METHOD TAKES THE CLIENT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Never a pool of its own. A reminder plan must ride the same transaction as
 * the due time it is planned from, or a crash between them leaves a commitment
 * with no reminders owed - or reminders owed for a time that was rolled back.
 * `AppointmentRemindersService` makes the same choice for the same reason.
 */

interface DbClient {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface CallbackRow {
  id: string;
  lead_id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_phone_hash: string | null;
  contact_phone_last3: string | null;
  number_key: string | null;
  requested_text: string | null;
  notes: string | null;
  status: string;
  type: string;
  committed: boolean;
  due_at: string;
  window_start: string | null;
  window_end: string | null;
  attempts: number;
  max_attempts: number;
  last_attempt_at: string | null;
  assigned_user_id: string | null;
  assigned_telecaller_id: string | null;
  original_user_id: string | null;
  original_telecaller_id: string | null;
}

export interface CallbackContext {
  timeZone: string;
  policy: CallbackPolicy;
  isDefault: boolean;
}

export interface CreateCallbackInput {
  leadId: string | null;
  contactId: string | null;
  dueAt: Date;
  requestedDueAt: Date | null;
  movedReason: string | null;
  committed: boolean;
  type: CallbackType;
  requestedText: string | null;
  notes: string | null;
  assignedUserId: string | null;
  assignedTelecallerId: string | null;
  policy: CallbackPolicy;
  timeZone: string;
  gateDecisionRunId: string | null;
  sourceCallId: string | null;
  sourceRunId: string | null;
  sourceIntentId: string | null;
  evidence: readonly unknown[];
  needsConfirmation: boolean;
  conditionText: string | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  contactName?: string | null;
  contactPhoneHash?: string | null;
  contactPhoneLast3?: string | null;
  numberKey?: string | null;
  contactNumberId?: string | null;
  preferredLanguage?: string | null;
}

@Injectable()
export class CallbacksService {
  /**
   * The org's timezone and its effective callback policy.
   *
   * ── THE DEFAULT IS RETURNED, NOT WRITTEN ────────────────────────────────
   *
   * An org with no `callback_policies` row gets `DEFAULT_CALLBACK_POLICY` and
   * no row is created. Two reasons, and the second is the one that matters:
   * a row means "this business made a decision" (0101's argument for sparse
   * overrides), and a default that the product later changes its mind about
   * then reaches every tenant who never expressed a preference - instead of
   * only the ones provisioned after the change.
   *
   * `isDefault` travels with it so the wizard can say "these are our
   * suggestions" rather than presenting them as the owner's own settings.
   */
  async context(client: DbClient): Promise<CallbackContext> {
    const { rows } = await client.query<{
      params: Record<string, unknown> | null;
      reporting_timezone: string | null;
    }>(
      `SELECT (SELECT p.params FROM callback_policies p
                WHERE p.effective_to IS NULL
                ORDER BY p.effective_from DESC LIMIT 1) AS params,
              o.reporting_timezone
         FROM organizations o LIMIT 1`,
    );
    const row = rows[0];
    const timeZone = resolveTimeZone(row?.reporting_timezone ?? DEFAULT_TIME_ZONE);

    if (!row?.params) return { timeZone, policy: DEFAULT_CALLBACK_POLICY, isDefault: true };

    // ── MERGED OVER THE DEFAULT, NOT PARSED STRICTLY ────────────────────────
    //
    // A stored policy written before a field existed is missing it, and a
    // strict parse would throw - taking the to-call list down for an org whose
    // only mistake was configuring the feature early. Merging over the default
    // means a new field arrives with its documented default and everything the
    // owner chose survives.
    //
    // The validation that matters happens at the WRITE
    // (`CallbackPolicyInput`), where a person can still fix it.
    return {
      timeZone,
      policy: { ...DEFAULT_CALLBACK_POLICY, ...(row.params as Partial<CallbackPolicy>) },
      isDefault: false,
    };
  }

  async openPolicyRow(client: DbClient) {
    const { rows } = await client.query(
      `SELECT id, params, effective_from FROM callback_policies
        WHERE effective_to IS NULL ORDER BY effective_from DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  /**
   * Read a callback FOR UPDATE, inside the caller's scope.
   *
   * ── `FOR UPDATE` AS ITS OWN STATEMENT, NOT INSIDE A CTE ─────────────────
   *
   * Two things could change a callback in the same second: a telecaller
   * pressing Done and the sweep marking it missed. The lock has to be taken
   * before the decision is made, and it has to be taken by a statement of its
   * own.
   *
   * A `WITH locked AS (SELECT … FOR UPDATE) UPDATE …` does NOT reliably do
   * that: `WITH` is not an execution barrier for locking, the planner is free
   * to pull rows only as the outer node demands them, and both halves share one
   * snapshot - so the rows the UPDATE modifies are not the rows the FOR UPDATE
   * locked. `resource-hold-sweep.ts` documents the same trap at length, and the
   * lead stage ledger work established it the hard way.
   */
  async claim(
    client: DbClient,
    id: string,
    recordScope: CrmRecordScope,
  ): Promise<CallbackRow> {
    const predicate = scopeClause("callback", recordScope, 2, "callbacks");
    const filter = scopeFilter("callback", recordScope, "callbacks");
    const { rows } = await client.query<CallbackRow>(
      `SELECT id, lead_id, contact_id, contact_name, contact_phone_hash, contact_phone_last3,
              number_key, requested_text, notes, status, type, committed, due_at,
              window_start, window_end, attempts, max_attempts, last_attempt_at,
              assigned_user_id, assigned_telecaller_id, original_user_id, original_telecaller_id
         FROM callbacks
        WHERE id = $1 ${predicate ? `AND ${predicate}` : ""}
        FOR UPDATE`,
      filter ? [id, filter.value] : [id],
    );
    const row = rows[0];
    // A 404 and not a 403 when the scope excluded it. The caller learns nothing
    // about a callback they may not see - the same choice every other scoped
    // read in this codebase makes.
    if (!row) throw new NotFoundException("callback not found");
    return row;
  }

  /** Create one, with its reminders and its priority. */
  async create(
    client: DbClient,
    orgId: string,
    req: PrincipalRequest | null,
    input: CreateCallbackInput,
  ) {
    const actor = req ? auditActor(req) : { type: "system" as const, id: "worker" };

    const priority = await this.priorityFor(client, {
      leadId: input.leadId,
      committed: input.committed,
      type: input.type,
      attempts: 0,
      dueAt: input.dueAt,
    });

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO callbacks
         (org_id, lead_id, contact_id, contact_name, contact_phone_hash, contact_phone_last3,
          number_key, contact_number_id, preferred_language,
          source_call_id, source_run_id, source_intent_id,
          assigned_user_id, assigned_telecaller_id, original_user_id, original_telecaller_id,
          assignment_reason, type, committed, requested_text, evidence, condition_text,
          due_at, window_start, window_end, requested_due_at, moved_reason,
          needs_confirmation, priority_score, priority_reason, status, max_attempts,
          notes, gate_decision_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $13, $14,
               $15, $16, $17, $18, $19::jsonb, $20, $21, $22, $23, $24, $25, $26, $27,
               $28::jsonb, 'scheduled', $29, $30, $31, $32)
       -- §10A.2's one-active-callback rule, enforced by 0186's partial unique
       -- index. DO NOTHING rather than an error: a redelivered transcript, a
       -- reprocess and a second call in the same minute all land here, and
       -- "there is already a live call-back for this person" is the CORRECT
       -- outcome of every one of them. §17 M5a's acceptance criterion is
       -- exactly this - "a repeated or duplicate transcript creates no second
       -- callback" - and it is held by the database rather than by a check.
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        orgId,
        input.leadId,
        input.contactId,
        input.contactName ?? null,
        input.contactPhoneHash ?? null,
        input.contactPhoneLast3 ?? null,
        input.numberKey ?? null,
        input.contactNumberId ?? null,
        input.preferredLanguage ?? null,
        input.sourceCallId,
        input.sourceRunId,
        input.sourceIntentId,
        input.assignedUserId,
        input.assignedTelecallerId,
        input.movedReason ? "moved into calling hours" : "the person who took the call",
        input.type,
        input.committed,
        input.requestedText,
        JSON.stringify(input.evidence ?? []),
        input.conditionText,
        input.dueAt,
        input.windowStart ?? null,
        input.windowEnd ?? null,
        input.requestedDueAt,
        input.movedReason,
        input.needsConfirmation,
        priority.score,
        JSON.stringify(priority.reasons),
        input.policy.maxAttempts,
        input.notes,
        input.gateDecisionRunId,
        actorUserId(actor),
      ],
    );

    const id = rows[0]?.id ?? null;
    if (!id) {
      // Suppressed by the unique index: there is already a live callback for
      // this lead and contact. Return the existing one so the caller can say so
      // rather than reporting a failure.
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM callbacks
          WHERE lead_id = $1
            AND COALESCE(contact_phone_hash, '') = COALESCE($2, '')
            AND status IN ('scheduled','due','reminded','in_progress','missed','escalated')
          LIMIT 1`,
        [input.leadId, input.contactPhoneHash ?? null],
      );
      return { id: existing[0]?.id ?? null, created: false, priority };
    }

    await this.planReminders(client, orgId, id, input.dueAt, input.policy);
    await this.logAudit(client, orgId, actor, id, "created", null, {
      dueAt: input.dueAt,
      committed: input.committed,
      type: input.type,
    });

    return { id, created: true, priority };
  }

  /** Move a callback's due time, and keep everything that depends on it in step. */
  async reschedule(
    client: DbClient,
    orgId: string,
    req: PrincipalRequest | null,
    input: {
      id: string;
      current: CallbackRow;
      dueAt: Date;
      movedReason: string | null;
      event: string;
      reason: string | null;
      policy: CallbackPolicy;
      timeZone: string;
    },
  ) {
    const actor = req ? auditActor(req) : { type: "system" as const, id: "worker" };
    if (!canTransition(input.current.status as CallbackStatus, "rescheduled")) {
      throw new ConflictException(`a ${input.current.status} callback cannot be moved`);
    }

    const priority = await this.priorityFor(client, {
      leadId: input.current.lead_id,
      committed: input.current.committed,
      type: input.current.type as CallbackType,
      attempts: input.current.attempts,
      dueAt: input.dueAt,
    });

    await client.query(
      `UPDATE callbacks
          SET due_at = $2,
              moved_reason = $3,
              -- Back to 'scheduled', not left at 'reminded'. A callback that
              -- was reminded about at its old time has to be remindable again
              -- at its new one, and the reminder rows below are keyed on
              -- (callback, kind, channel) - so without this the list would
              -- show an item that never pops up again.
              status = 'scheduled',
              priority_score = $4,
              priority_reason = $5::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [input.id, input.dueAt, input.movedReason, priority.score, JSON.stringify(priority.reasons)],
    );

    // The old reminders are for a time that no longer exists.
    await this.cancelPending(client, input.id, "the call-back was moved");
    await this.planReminders(client, orgId, input.id, input.dueAt, input.policy);
    // And so are the escalations. An unsent level scheduled off the old due
    // time would fire at the wrong moment; a SENT one is history and stays.
    await client.query(
      `DELETE FROM callback_escalations WHERE callback_id = $1 AND sent_at IS NULL`,
      [input.id],
    );

    await this.logAudit(client, orgId, actor, input.id, input.event, input.current, {
      dueAt: input.dueAt,
      movedReason: input.movedReason,
      reason: input.reason,
    });

    return { dueAt: input.dueAt, priority };
  }

  /**
   * §10A.5's attempt-and-retry.
   *
   * Returns what happened, because the three outcomes read differently to the
   * telecaller: it completed, it will be tried again at a stated time, or the
   * budget is spent and a person has to decide.
   */
  async recordAttempt(
    client: DbClient,
    orgId: string,
    req: PrincipalRequest | null,
    input: {
      id: string;
      current: CallbackRow;
      connected: boolean;
      durationSeconds: number | null;
      notes: string | null;
      policy: CallbackPolicy;
      timeZone: string;
    },
  ) {
    const actor = req ? auditActor(req) : { type: "system" as const, id: "worker" };
    const attempts = input.current.attempts + 1;
    const now = new Date();

    // A CONNECTED call of at least the threshold completes it - the same rule
    // the worker's auto-complete applies, so pressing "reached them" and the
    // sweep noticing produce the same state.
    const completes =
      input.connected &&
      (input.durationSeconds ?? 0) >= input.policy.autoCompleteSeconds;

    if (completes) {
      await client.query(
        `UPDATE callbacks
            SET status = 'completed', completed_at = now(), attempts = $2,
                last_attempt_at = now(), notes = COALESCE($3, notes), updated_at = now()
          WHERE id = $1`,
        [input.id, attempts, input.notes],
      );
      await this.cancelPending(client, input.id, "the customer was reached");
      await this.logAudit(client, orgId, actor, input.id, "completed_by_attempt", input.current, {
        attempts,
      });
      return { outcome: "completed" as const, attempts, nextAttemptAt: null };
    }

    const nextAt = nextCallbackRetryAt(attempts, now, input.policy, input.timeZone);

    if (!nextAt) {
      // §10A.5: "after the last attempt: notify the manager and set
      // `closed_unreachable`." The notification is the worker's - this records
      // the state, and the sweep that tells somebody reads it.
      await client.query(
        `UPDATE callbacks
            SET status = 'closed_unreachable', attempts = $2, last_attempt_at = now(),
                next_attempt_at = NULL, notes = COALESCE($3, notes), updated_at = now()
          WHERE id = $1`,
        [input.id, attempts, input.notes],
      );
      await this.cancelPending(client, input.id, "no attempts left");
      await this.logAudit(client, orgId, actor, input.id, "closed_unreachable", input.current, {
        attempts,
      });
      return { outcome: "unreachable" as const, attempts, nextAttemptAt: null };
    }

    const priority = await this.priorityFor(client, {
      leadId: input.current.lead_id,
      committed: input.current.committed,
      type: input.current.type as CallbackType,
      attempts,
      dueAt: nextAt,
    });

    await client.query(
      `UPDATE callbacks
          SET status = 'scheduled', attempts = $2, last_attempt_at = now(),
              next_attempt_at = $3, due_at = $3,
              priority_score = $4, priority_reason = $5::jsonb,
              notes = COALESCE($6, notes), updated_at = now()
        WHERE id = $1`,
      [input.id, attempts, nextAt, priority.score, JSON.stringify(priority.reasons), input.notes],
    );
    await this.cancelPending(client, input.id, "the call-back moved to its next attempt");
    await this.planReminders(client, orgId, input.id, nextAt, input.policy);
    await this.logAudit(client, orgId, actor, input.id, "attempted", input.current, {
      attempts,
      connected: input.connected,
      nextAttemptAt: nextAt,
    });

    return { outcome: "retrying" as const, attempts, nextAttemptAt: nextAt };
  }

  /** §10A.3's reassign. Notifies BOTH people - that is the worker's job. */
  async reassign(
    client: DbClient,
    orgId: string,
    req: PrincipalRequest | null,
    input: {
      id: string;
      current: CallbackRow;
      assignedUserId: string | null;
      assignedTelecallerId: string | null;
      reason: string;
    },
  ) {
    const actor = req ? auditActor(req) : { type: "system" as const, id: "worker" };

    await client.query(
      `UPDATE callbacks
          SET assigned_user_id = $2,
              assigned_telecaller_id = $3,
              -- The original assignee columns are NOT touched. §10A.3 reassigns on absence, and
              -- without the original the trail of a commitment made by a person
              -- on leave simply ends - which is the thing §20 forbids.
              assignment_reason = $4,
              assigned_at = now(),
              status = 'scheduled',
              updated_at = now()
        WHERE id = $1`,
      [input.id, input.assignedUserId, input.assignedTelecallerId, input.reason],
    );

    // The pending reminders were addressed to the previous person. Cancelled
    // and re-planned, so the new assignee is the one who gets the popup.
    await this.cancelPending(client, input.id, "the call-back was handed to somebody else");
    const { policy } = await this.context(client);
    const { rows } = await client.query<{ due_at: string }>(
      `SELECT due_at FROM callbacks WHERE id = $1`,
      [input.id],
    );
    if (rows[0]) {
      await this.planReminders(client, orgId, input.id, new Date(rows[0].due_at), policy);
    }

    await this.logAudit(client, orgId, actor, input.id, "reassigned", input.current, {
      to: input.assignedUserId ?? input.assignedTelecallerId,
      from: input.current.assigned_user_id ?? input.current.assigned_telecaller_id,
      reason: input.reason,
    });

    return { ok: true };
  }

  /**
   * §10A.4's plan, as rows.
   *
   * ── IDEMPOTENT BY CONSTRAINT, NOT BY CHECK ──────────────────────────────
   *
   * `ON CONFLICT (callback_id, kind, channel) DO UPDATE` rather than a read
   * first. §10A.4 asks for reminders that "are idempotent", and a
   * read-then-write is not: two workers draining the same tick both read
   * nothing and both insert. The constraint is in 0186 and this is the write
   * that relies on it.
   *
   * A reminder whose row already exists is UPDATED to the new instant rather
   * than skipped, because this is also the path a reschedule takes.
   */
  async planReminders(
    client: DbClient,
    orgId: string,
    callbackId: string,
    dueAt: Date,
    policy: CallbackPolicy,
  ): Promise<number> {
    const planned = reminderSchedule(dueAt, policy, new Date());
    let written = 0;
    for (const reminder of planned) {
      for (const channel of reminder.channels) {
        const { rowCount } = await client.query(
          `INSERT INTO callback_reminders
             (org_id, callback_id, kind, channel, scheduled_at, state)
           VALUES ($1, $2, $3, $4, $5, 'scheduled')
           ON CONFLICT (callback_id, kind, channel) DO UPDATE
             SET scheduled_at = EXCLUDED.scheduled_at,
                 state = 'scheduled',
                 delivered_at = NULL,
                 acted_at = NULL,
                 held_reason = NULL,
                 attempts = 0,
                 updated_at = now()`,
          [orgId, callbackId, reminder.kind, channel, reminder.at],
        );
        written += rowCount ?? 0;
      }
    }
    return written;
  }

  /** Stop the reminders that have not fired. The delivered ones are history. */
  async cancelPending(client: DbClient, callbackId: string, reason: string): Promise<void> {
    await client.query(
      `UPDATE callback_reminders
          SET state = 'cancelled', held_reason = $2, updated_at = now()
        WHERE callback_id = $1 AND state IN ('scheduled', 'held')`,
      [callbackId, reason],
    );
  }

  /**
   * §10A.6 step 10's "re-apply to open ones".
   *
   * ── IT RE-PLACES, IT DOES NOT RE-RESOLVE ────────────────────────────────
   *
   * The original phrases were resolved against the policy in force at the time,
   * and the customer was told the answer. Re-reading "kal shaam 5 baje" under a
   * new daypart table would MOVE a commitment somebody already made - which is
   * the one thing this module exists not to do.
   *
   * So what is re-applied is the policy's PLACEMENT rules: a callback now
   * outside the new calling hours moves into them and is flagged, and its
   * reminders are re-planned. Nothing else changes.
   */
  async reapplyPolicy(
    client: DbClient,
    orgId: string,
    policy: CallbackPolicy,
  ): Promise<number> {
    const { timeZone } = await this.context(client);
    const { rows } = await client.query<{ id: string; due_at: string }>(
      `SELECT id, due_at FROM callbacks
        WHERE status IN ('scheduled', 'due', 'reminded', 'missed')
        ORDER BY due_at
        LIMIT 2000`,
    );

    let moved = 0;
    for (const row of rows) {
      const placed = placeInCallingHours(new Date(row.due_at), policy, timeZone);
      // Only the ones that actually move. A policy change that happens not to
      // affect a callback should not rewrite its row, bump its `updated_at`,
      // or re-fire a reminder it has already had.
      if (!placed.moved) continue;
      await client.query(
        `UPDATE callbacks
            SET due_at = $2, moved_reason = $3, status = 'scheduled', updated_at = now()
          WHERE id = $1`,
        [row.id, placed.dueAt, placed.reason],
      );
      await this.cancelPending(client, row.id, "your call-back settings changed");
      await this.planReminders(client, orgId, row.id, placed.dueAt, policy);
      moved += 1;
    }
    return moved;
  }

  /**
   * §10A.3's priority, with the lead's own numbers filled in.
   *
   * The money and the temperature come from the lead and from Finance, which is
   * why this is a method and not a call to `priorityScore` at each site: the
   * query that finds "is there a payment promise riding on this call" is one
   * join nobody should write twice.
   */
  async priorityFor(
    client: DbClient,
    input: {
      leadId: string | null;
      committed: boolean;
      type: CallbackType;
      attempts: number;
      dueAt: Date;
    },
  ) {
    let leadValueMinor: number | null = null;
    let moneyAtRiskMinor: number | null = null;
    let temperature: "hot" | "medium" | "cold" | null = null;
    let lateStage = false;

    if (input.leadId) {
      const { rows } = await client.query<{
        value: string | null;
        temperature: string | null;
        stage: string | null;
        at_risk: string | null;
      }>(
        `SELECT l.value_num::text AS value, l.temperature, l.stage,
                -- §10A.8: "a callback linked to a payment promise or due
                -- inherits priority and shows the amount at risk." Read from
                -- the deal's own schedule rather than from the promise record,
                -- because an overdue instalment is the amount that is actually
                -- at risk.
                (SELECT sum(ps.amount)::text
                   FROM deals d
                   JOIN payment_schedules ps ON ps.deal_id = d.id
                  WHERE d.source_lead_id = l.id
                    AND ps.status <> 'paid'
                    AND ps.due_date <= current_date) AS at_risk
           FROM leads l WHERE l.id = $1`,
        [input.leadId],
      );
      const row = rows[0];
      if (row) {
        leadValueMinor = row.value ? Math.round(Number(row.value) * 100) : null;
        moneyAtRiskMinor = row.at_risk ? Math.round(Number(row.at_risk) * 100) : null;
        temperature =
          row.temperature === "hot" || row.temperature === "medium" || row.temperature === "cold"
            ? row.temperature
            : null;
        lateStage = ["negotiation", "proposal", "closing", "won"].includes(
          (row.stage ?? "").toLowerCase(),
        );
      }
    }

    const overdueMinutes = Math.round((Date.now() - input.dueAt.getTime()) / 60_000);
    return priorityScore({
      committed: input.committed,
      type: input.type,
      overdueMinutes,
      attempts: input.attempts,
      leadValueMinor,
      moneyAtRiskMinor,
      temperature,
      lateStage,
    });
  }

  /** One audit shape, for the console's history panel and the org's trail. */
  async audit(
    client: DbClient,
    orgId: string,
    req: PrincipalRequest,
    callbackId: string,
    event: string,
    before: unknown,
    after: unknown,
  ) {
    await this.logAudit(client, orgId, auditActor(req), callbackId, event, before, after);
  }

  private async logAudit(
    client: DbClient,
    orgId: string,
    actor: { type: string; id: string },
    callbackId: string,
    event: string,
    before: unknown,
    after: unknown,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1, $2, $3, $4, 'callback', $5, $6::jsonb)`,
      [
        orgId,
        actor.type,
        actor.id,
        `callbacks.${event}`,
        callbackId,
        JSON.stringify({ before: before ?? null, after: after ?? null }),
      ],
    );
  }
}

/** Shared with the worker's conversion path - §10A.7's "never silently lost". */
export function guardOpenCallback(status: string): void {
  if (!canTransition(status as CallbackStatus, "cancelled")) {
    throw new ForbiddenException(`a ${status} callback is already finished`);
  }
}
