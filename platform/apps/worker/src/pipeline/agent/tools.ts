import { createHash } from "node:crypto";
import {
  type PoolClient,
  contactNumberMatchKey,
  gateFor,
  inheritCallsForLeadSafely,
} from "@aura/db";
import {
  type AgentCapability,
  type AgentToolName,
  type CallbackPolicy,
  type GateDecision,
  type GateSubject,
  classifyCallback,
  gateAllows,
  phoneDigits,
  placeInCallingHours,
  priorityScore,
  reminderSchedule,
  toolSpec,
} from "@aura/shared";
import type { PolicySideContext } from "./context";

/**
 * §10 - THE EXECUTOR, AND THE ONLY COMPONENT ALLOWED TO ACT
 * (Build docs/transcript-agent-build-plan §10).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  §3A.4's HARDEST LINE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "Executor and tools: RE-CHECK BEFORE EVERY TOOL CALL. The executor refuses
 * any action lacking a valid `gate_decision_id`."
 *
 * Three mechanisms, and only the first is a check somebody could forget:
 *
 *   1. `assertGate(gate, capability)` at the top of every tool body. Named and
 *      greppable, which is what `agent-gate-coverage.spec.ts` asserts per tool.
 *   2. `gate: GateDecision` is a REQUIRED field on `ToolContext`. A tool
 *      cannot be invoked without a decision existing - there is no optional
 *      parameter for somebody to omit.
 *   3. `agent_actions.gate_decision_id` is written from the run, and
 *      `executeAction` refuses an action whose run has none. The refusal is
 *      visible in the ROW rather than only in a log.
 *
 * The re-check matters because an owner can switch the feature off while a
 * plan is mid-flight. §3A.5: "running runs stop BEFORE THEIR NEXT TOOL CALL."
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  IDEMPOTENT BY CONSTRAINT, NOT BY CHECK
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §10: "retries are safe: re-running the same plan produces no duplicates."
 *
 * Every write here is `ON CONFLICT DO NOTHING` or `DO UPDATE` against a real
 * unique index, and the ACTION's own `idempotency_key` is unique across the
 * table (0185). A read-then-write would lose the race it exists to win: two
 * workers handling a redelivered message both read nothing and both insert.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  NOTHING HERE SENDS A MESSAGE TO A CUSTOMER
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `send_message` and `send_information` write an OUTBOX ROW and nothing more -
 * the same shape `AppointmentRemindersService` has, and for the same reason
 * this platform's standing rule gives: nothing automated reaches a customer
 * without a person saying yes. The drain that turns a row into a message is
 * elsewhere and has its own gates.
 */

export interface ToolContext {
  orgId: string;
  callId: string;
  runId: string;
  transcriptId: string;
  /**
   * §3A.4. REQUIRED, not optional - see the header. A tool cannot be invoked
   * without a gate decision existing.
   */
  gate: GateDecision;
  /** Whose gate it is, for the re-resolution before a customer-visible tool. */
  subject: GateSubject;
  policy: PolicySideContext;
  /** The action row this is executing, so the result lands on it. */
  actionId: string;
  idempotencyKey: string;
}

export class GateClosedError extends Error {
  constructor(
    readonly capability: AgentCapability,
    readonly reason: string,
  ) {
    super(`the "${capability}" half of the assistant is no longer switched on (${reason})`);
    this.name = "GateClosedError";
  }
}

/**
 * THE gate re-check. Named so it is greppable, and called first in every tool.
 *
 * Throws rather than returning false, because every caller's only correct
 * response is to stop - and a boolean is a boolean somebody forgets to read.
 * `executeAction` catches it and marks the action `blocked_by_gate`, which
 * §3A.4 asks for by name.
 */
export function assertGate(gate: GateDecision, capability: AgentCapability): void {
  if (!gateAllows(gate, capability)) {
    throw new GateClosedError(capability, gate.reason);
  }
}

export interface ToolResult {
  /** What the tool touched, so the console can link to it (§3A.5's list). */
  targetType: string | null;
  targetId: string | null;
  response: Record<string, unknown>;
}

type ToolFn = (
  client: PoolClient,
  ctx: ToolContext,
  params: Record<string, unknown>,
) => Promise<ToolResult>;

// ════════════════════════════════════════════════════════════════════════════
//  The entry point
// ════════════════════════════════════════════════════════════════════════════

/**
 * Execute ONE action.
 *
 * ── THE GATE IS RE-RESOLVED, NOT RE-READ, FOR A CUSTOMER-VISIBLE TOOL ─────
 *
 * For a T0/T1 internal write the plan's own decision is used: it was resolved
 * minutes ago, the work is reversible and local, and a fresh database read per
 * action would add ~125ms to each of a plan's eight steps.
 *
 * For a CUSTOMER-VISIBLE tool the decision is re-resolved from the database
 * first. The asymmetry is the point: a summary written after an owner switched
 * the feature off is a row in their own workspace, and a WhatsApp message sent
 * after they switched it off has left the building. §3A.4's "re-check before
 * every tool call" is honoured for everything; the expensive form of the
 * re-check is spent where being wrong cannot be undone.
 */
export async function executeAction(
  client: PoolClient,
  ctx: ToolContext,
  tool: AgentToolName,
  params: Record<string, unknown>,
): Promise<{ ok: true; result: ToolResult } | { ok: false; code: string; error: string }> {
  const spec = toolSpec(tool);
  const startedAt = Date.now();

  // §3A.4: "the executor refuses any action lacking a valid
  // `gate_decision_id`." Checked against the ROW rather than the argument, so
  // an action inserted by anything other than the planner is refused too.
  const { rows: guard } = await client.query<{ gate_decision_id: string | null }>(
    `SELECT gate_decision_id FROM agent_actions WHERE id = $1`,
    [ctx.actionId],
  );
  if (!guard[0] || guard[0].gate_decision_id === null) {
    return {
      ok: false,
      code: "blocked_by_gate",
      error: "this action has no recorded permission behind it, so it was refused",
    };
  }

  // §10: the owner's panic button and the per-tool switches. Read per action
  // rather than per run: "instantly" in §10 means the action after the one
  // that is already running.
  if (ctx.policy.paused) {
    return { ok: false, code: "blocked_by_gate", error: "the assistant is paused" };
  }
  if (ctx.policy.disabledTools.includes(tool)) {
    return { ok: false, code: "blocked_by_gate", error: `"${tool}" is switched off` };
  }

  let gate = ctx.gate;
  if (spec.customerVisible) {
    gate = await gateFor(client, "transcript_agent", ctx.subject);
  }

  const fn = TOOLS[tool];
  if (!fn) {
    return { ok: false, code: "not_implemented", error: `no implementation for "${tool}"` };
  }

  try {
    const result = await fn(client, { ...ctx, gate }, params);
    await client.query(
      `UPDATE agent_actions
          SET state = 'done', executed_at = now(), duration_ms = $2,
              response = $3::jsonb, target_type = $4, target_id = $5,
              error = NULL, updated_at = now()
        WHERE id = $1`,
      [
        ctx.actionId,
        Date.now() - startedAt,
        JSON.stringify(result.response),
        result.targetType,
        result.targetId,
      ],
    );
    return { ok: true, result };
  } catch (error) {
    const closed = error instanceof GateClosedError;
    await client.query(
      `UPDATE agent_actions
          SET state = $2, policy_code = $3, error = $4, duration_ms = $5, updated_at = now()
        WHERE id = $1`,
      [
        ctx.actionId,
        closed ? "blocked_by_gate" : "failed",
        closed ? "blocked_by_gate" : null,
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        Date.now() - startedAt,
      ],
    );
    return {
      ok: false,
      code: closed ? "blocked_by_gate" : "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  §10's table, implemented
// ════════════════════════════════════════════════════════════════════════════

const TOOLS: Partial<Record<AgentToolName, ToolFn>> = {
  // ── T0: record ───────────────────────────────────────────────────────────

  set_disposition: async (client, ctx, params) => {
    assertGate(ctx.gate, "record");
    const disposition = String(params.disposition ?? "").trim();
    if (!disposition) throw new Error("no disposition to set");

    // Validated against the org's OWN list, not against a constant. A model
    // that invents "very_interested" must not write it: the lead board filters
    // on these, and an unrecognised value is a lead that appears in no filter.
    const { rowCount } = await client.query(
      `SELECT 1 FROM call_dispositions WHERE key = $1 AND is_active`,
      [disposition],
    );
    if ((rowCount ?? 0) === 0) {
      throw new Error(`"${disposition}" is not one of this workspace's call outcomes`);
    }

    // `disposition_key`, with `disposition_at` and `disposition_by` beside it
    // (0144). `disposition_by` is left NULL: the column references `users`, and
    // the assistant is not a user. The `agent_actions` row is what attributes
    // it, which is the same split 0166 makes for `attended_by` when the
    // admin-key path has no `users` row to point at.
    await client.query(
      `UPDATE calls
          SET disposition_key = $2, disposition_at = now(), updated_at = now()
        WHERE id = $1`,
      [ctx.callId, disposition],
    );
    return {
      targetType: "call",
      targetId: ctx.callId,
      response: { disposition },
    };
  },

  write_call_summary: async (client, ctx, params) => {
    assertGate(ctx.gate, "record");
    const summary = String(params.summary ?? "").trim();
    if (!summary) throw new Error("no summary to write");

    // Written onto the AGENT's own run output rather than over the
    // conversation-intelligence summary `enrich.ts` produces. Two readers
    // write a summary for this call and overwriting theirs would make "which
    // component said this" unanswerable - which §20's reproducibility
    // requirement forbids.
    await client.query(
      `UPDATE agent_runs
          SET output = COALESCE(output, '{}'::jsonb) || jsonb_build_object('summary', $2::text),
              updated_at = now()
        WHERE id = $1`,
      [ctx.runId, summary.slice(0, 4000)],
    );
    return { targetType: "agent_run", targetId: ctx.runId, response: { chars: summary.length } };
  },

  record_quality_signals: async (client, ctx, params) => {
    assertGate(ctx.gate, "record");
    const signals = (params.signals ?? {}) as Record<string, unknown>;
    await client.query(
      `UPDATE agent_runs
          SET output = COALESCE(output, '{}'::jsonb)
                     || jsonb_build_object('quality_signals', $2::jsonb),
              updated_at = now()
        WHERE id = $1`,
      [ctx.runId, JSON.stringify(signals)],
    );
    return { targetType: "agent_run", targetId: ctx.runId, response: signals };
  },

  // ── T1: internal ─────────────────────────────────────────────────────────

  /**
   * §10's `mark_do_not_contact` - T1, "execute immediately; legally
   * sensitive".
   *
   * ── GATED ON `record`, NOT ON `messaging` ──────────────────────────────
   *
   * Suppression only ever STOPS a send. Gating it on the messaging capability
   * would mean an owner who switched messaging OFF could not record that a
   * customer asked to be left alone - which inverts the policy completely. The
   * `record` capability is on in every mode above `off`.
   */
  mark_do_not_contact: async (client, ctx, params) => {
    assertGate(ctx.gate, "record");
    const channel = String(params.channel ?? "call");
    const peerAddress = String(params.peerAddress ?? "").trim();
    if (!peerAddress) throw new Error("no number or address to suppress");

    // `level = 'certain'`, and only reached for an UNAMBIGUOUS opt-out: the
    // planner routes `isProbableOptOut` to review instead. `opt-out.ts`'s
    // header is explicit that letting the ambiguous half silence somebody on
    // its own would invert the policy - "the power to stop talking to a
    // customer for good belongs to a person".
    await client.query(
      `INSERT INTO messaging_opt_outs (org_id, channel, peer_address, level)
       VALUES ($1, $2, $3, 'certain')
       ON CONFLICT DO NOTHING`,
      [ctx.orgId, channel, peerAddress],
    );
    return { targetType: "messaging_opt_out", targetId: null, response: { channel } };
  },

  create_followup: async (client, ctx, params) => {
    assertGate(ctx.gate, "tasks");
    const title = String(params.title ?? "").trim() || "Follow up on this call";
    const dueAt = params.dueAt ? new Date(String(params.dueAt)) : null;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tasks (org_id, title, notes, lead_id, assignee_user_id, due_at, priority, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
       RETURNING id`,
      [
        ctx.orgId,
        title.slice(0, 300),
        params.notes ? String(params.notes).slice(0, 10_000) : null,
        ctx.policy.leadId,
        params.assigneeUserId ? String(params.assigneeUserId) : ctx.subject.userId,
        dueAt,
        params.priority ? String(params.priority) : "normal",
      ],
    );
    return { targetType: "task", targetId: rows[0]!.id, response: { title, dueAt } };
  },

  update_contact: async (client, ctx, params) => {
    assertGate(ctx.gate, "tasks");
    const field = String(params.field ?? "");
    const value = String(params.value ?? "").trim();
    if (!value) throw new Error("nothing to update the contact with");

    // ── A NOTE, NOT AN OVERWRITE, AND THAT IS THE DECISION ────────────────
    //
    // §7.3: "STT errors on numbers and names are the costliest." A mis-heard
    // digit written over a lead's phone number makes them UNREACHABLE, and
    // nothing in the system would show that it had happened - the old number
    // is gone.
    //
    // So the agent appends to the lead's notes and raises the change for a
    // person, even at T1 and even at high confidence. The cross-check in the
    // resolvers lowers the score when the new number does not look like a
    // correction of the old one, but the structural protection is this: the
    // agent never destroys a way of reaching somebody.
    await client.query(
      `UPDATE leads
          SET notes = COALESCE(notes || E'\\n', '') || $2,
              last_activity_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [
        ctx.policy.leadId,
        `[assistant] the customer gave a new ${field} on this call: ${value}`.slice(0, 1000),
      ],
    );
    return {
      targetType: "lead",
      targetId: ctx.policy.leadId,
      response: { field, recordedAsNote: true, overwritten: false },
    };
  },

  /**
   * §10's `create_referral_lead`.
   *
   * ── THE KEYS ARE COMPUTED THE SAME WAY `lead-intake.ts` COMPUTES THEM ───
   *
   * `contact_number_hash` is `sha256(phoneDigits(raw))` and
   * `contact_number_key` is `contactNumberMatchKey(raw)` - the second being
   * the last-ten-digit match key 0146 added so a new lead inherits the calls
   * that already exist for that number.
   *
   * Both, through the same helpers the intake path uses, because the unique
   * index is on `(workspace_id, contact_number_hash)`: computing the hash any
   * other way means the ON CONFLICT never fires and a referral to somebody who
   * is already a lead creates a duplicate.
   *
   * That was worth checking rather than assuming - the first version of this
   * wrote `ON CONFLICT (org_id, contact_number_key)`, which is not an index
   * that exists and would have failed with a 42P10 on the first referral.
   */
  create_referral_lead: async (client, ctx, params) => {
    assertGate(ctx.gate, "tasks");
    const name = String(params.name ?? "").trim() || null;
    const rawPhone = String(params.phone ?? "").trim();
    if (!rawPhone) throw new Error("a referral needs a number to be reachable");

    const digits = phoneDigits(rawPhone);
    if (!digits) throw new Error("that does not look like a phone number");
    const hash = createHash("sha256").update(digits).digest("hex");
    const numberKey = contactNumberMatchKey(rawPhone);

    const { rows } = await client.query<{ id: string; workspace_id: string }>(
      `INSERT INTO leads
         (org_id, workspace_id, contact_name, contact_number_hash, contact_number_key,
          contact_number_prefix, contact_number_last3, title, stage, status,
          source_channel, source_ref, notes, call_count)
       SELECT c.org_id, c.workspace_id, $1, $2, $3, $4, $5,
              COALESCE($1, $5 || ' (referral)'), 'new', 'open',
              -- CAST ON BOTH USES. $6 is the call id, and it is used here as
              -- source_ref (text) and below as calls.id (uuid). Without the
              -- casts Postgres refuses the statement with "inconsistent types
              -- deduced for parameter $6" - one placeholder cannot be two
              -- types. Caught by preparing this against a real database;
              -- typecheck sees a perfectly ordinary string.
              'referral', $6::text, $7,
              -- A referral has had no calls. Starting at 0 rather than the
              -- column default of 1 keeps "calls" on the board honest - the
              -- same note lead-intake.ts carries for an ad lead.
              0
         FROM calls c WHERE c.id = $6::uuid
       -- A referral to somebody who is ALREADY a lead is not a new lead: the
       -- existing row's own history is worth more than a duplicate, and
       -- dedupe.ts would merge them later anyway. The predicate matches
       -- 0010's partial index exactly.
       ON CONFLICT (workspace_id, contact_number_hash) WHERE contact_number_hash IS NOT NULL
       DO NOTHING
       RETURNING id, workspace_id`,
      [
        // No `ctx.orgId`: the org and the workspace come FROM THE CALL, which
        // is what guarantees a referral lands in the same book of business as
        // the call that produced it. Binding it anyway made Postgres refuse the
        // statement - a parameter the SQL does not reference is a runtime
        // error, not dead code.
        name,
        hash,
        numberKey,
        digits.slice(0, 5),
        digits.slice(-3),
        ctx.callId,
        `[assistant] referred on a call${name ? ` by name: ${name}` : ""}.`,
      ],
    );

    const leadId = rows[0]?.id ?? null;
    if (leadId) {
      // 0146: a new lead inherits the calls that already exist for its number.
      // Without this a referral who had rung before starts with an empty
      // history - and the hash-format bug that made the old match miss every
      // intake lead is exactly why this goes through the shared helper rather
      // than a hand-written match.
      //
      // WORKSPACE, not org: 0094 is explicit that the contact hash is unique
      // per workspace and that matching org-wide would put another desk's
      // calls on this card.
      await inheritCallsForLeadSafely(client, ctx.orgId, {
        leadId,
        workspaceId: rows[0]!.workspace_id,
        contactNumberHash: hash,
        contactNumberKey: numberKey,
      });
    }

    return {
      targetType: "lead",
      targetId: leadId,
      response: { created: leadId !== null, alreadyExisted: leadId === null },
    };
  },

  log_payment_promise: async (client, ctx, params) => {
    assertGate(ctx.gate, "tasks");
    const amountMinor = Number(params.amountMinor ?? 0);
    const promisedOn = params.promisedOn ? String(params.promisedOn).slice(0, 10) : null;
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      throw new Error("a payment promise needs an amount");
    }
    if (!promisedOn) throw new Error("a payment promise needs a date");

    // ── `promised_on`, NOT `due_date` ──────────────────────────────────────
    //
    // 0173 has both, and the difference is the whole value of this tool to the
    // Advisor: `due_date` is what the CONTRACT says, `promised_on` is what the
    // customer said on the phone. The `slipped_promise` detector reads the
    // second, and writing a promise into the first would silently rewrite the
    // payment schedule a quotation created.
    //
    // Numeric, not paise - `TRANSCRIPT_AGENT_DECISIONS.md` §4.1.
    const { rows } = await client.query<{ id: string }>(
      `UPDATE payment_schedules ps
          SET promised_on = $2::date,
              memo = COALESCE(ps.memo || E'\\n', '') || $3,
              updated_at = now()
        WHERE ps.id = (
          SELECT ps2.id
            FROM payment_schedules ps2
            JOIN deals d ON d.id = ps2.deal_id
           WHERE d.source_lead_id = $1
             AND ps2.status IN ('open', 'partial')
           ORDER BY ps2.due_date
           LIMIT 1
        )
        RETURNING ps.id`,
      [
        ctx.policy.leadId,
        promisedOn,
        // The amount is in the MEMO and not a column of its own: 0173's
        // `payment_schedules.amount` is what the contract says, and a promise
        // to pay a different figure must not rewrite it. The Advisor reads
        // `promised_on`; a part payment shows up as `paid_amount` when it
        // lands.
        //
        // `amountMinor` is NOT bound as its own parameter. It was, and
        // Postgres refused the statement - "could not determine data type of
        // parameter $2" - because nothing in the SQL referenced it. A bound
        // parameter the statement does not use is a runtime error.
        `[assistant] promised ${(amountMinor / 100).toFixed(2)} by ${promisedOn} on a call`,
      ],
    );

    if (rows.length === 0) {
      // No instalment to attach it to. Recorded as a dated follow-up instead -
      // a promise nobody can see is worse than one in the wrong place, and
      // §16's "integrations are optional and fail-soft" is the rule here.
      const { rows: task } = await client.query<{ id: string }>(
        `INSERT INTO tasks (org_id, title, notes, lead_id, assignee_user_id, due_at, priority, status)
         VALUES ($1, $2, $3, $4, $5, $6::date, 'high', 'open')
         RETURNING id`,
        [
          ctx.orgId,
          `Collect ${(amountMinor / 100).toFixed(2)}`,
          "[assistant] the customer promised this on a call. There is no payment schedule on this lead to record it against.",
          ctx.policy.leadId,
          ctx.subject.userId,
          promisedOn,
        ],
      );
      return {
        targetType: "task",
        targetId: task[0]!.id,
        response: { amountMinor, promisedOn, attachedTo: "task" },
      };
    }

    return {
      targetType: "payment_schedule",
      targetId: rows[0]!.id,
      response: { amountMinor, promisedOn, attachedTo: "payment_schedule" },
    };
  },

  escalate_to_human: async (client, ctx, params) => {
    assertGate(ctx.gate, "record");
    const reason = String(params.reason ?? "the customer asked for a manager").slice(0, 500);

    // 0151's columns: `telecaller_id` for who raised it and `source` for how.
    // `source = 'agent'`... is NOT used: 0151's CHECK does not know the value,
    // and widening a constraint from a tool is how a 23514 reaches a live
    // escalation. The `note` says it instead, which is what a senior reads.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO call_escalations (org_id, call_id, telecaller_id, reason, note, status)
       VALUES ($1, $2, $3, $4, $5, 'open')
       -- One escalation per call. A redelivered plan must not put the same
       -- call in a senior's queue twice.
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        ctx.orgId,
        ctx.callId,
        ctx.subject.telecallerId,
        reason,
        "[assistant] raised from what was said on this call.",
      ],
    );
    return {
      targetType: "call_escalation",
      targetId: rows[0]?.id ?? null,
      response: { reason, created: rows.length > 0 },
    };
  },

  // ── T1: §10A's callbacks ─────────────────────────────────────────────────

  schedule_callback: async (client, ctx, params) => {
    assertGate(ctx.gate, "callbacks");
    return scheduleCallback(client, ctx, params);
  },

  update_callback: async (client, ctx, params) => {
    assertGate(ctx.gate, "callbacks");
    const callbackId = String(params.callbackId ?? "");
    const dueAt = params.dueAt ? new Date(String(params.dueAt)) : null;
    if (!callbackId || !dueAt) throw new Error("nothing to update the callback with");

    const placed = placeInCallingHours(dueAt, ctx.policy.callbackPolicy, ctx.policy.timeZone);
    await client.query(
      `UPDATE callbacks
          SET due_at = $2, moved_reason = $3, status = 'scheduled', updated_at = now()
        WHERE id = $1`,
      [callbackId, placed.dueAt, placed.moved ? placed.reason : null],
    );
    await replanReminders(client, ctx, callbackId, placed.dueAt);
    return {
      targetType: "callback",
      targetId: callbackId,
      response: { dueAt: placed.dueAt.toISOString(), moved: placed.moved },
    };
  },

  reassign_callback: async (client, ctx, params) => {
    assertGate(ctx.gate, "callbacks");
    const callbackId = String(params.callbackId ?? "");
    if (!callbackId) throw new Error("no callback to reassign");

    await client.query(
      `UPDATE callbacks
          SET assigned_user_id = $2, assigned_telecaller_id = $3,
              assignment_reason = $4, assigned_at = now(),
              status = 'scheduled', updated_at = now()
        WHERE id = $1`,
      [
        callbackId,
        params.assignedUserId ? String(params.assignedUserId) : null,
        params.assignedTelecallerId ? String(params.assignedTelecallerId) : null,
        String(params.reason ?? "reassigned by the assistant").slice(0, 300),
      ],
    );
    return { targetType: "callback", targetId: callbackId, response: {} };
  },

  // ── T2: the customer sees it ─────────────────────────────────────────────

  book_slot: async (client, ctx, params) => {
    assertGate(ctx.gate, "booking");
    const startsAt = new Date(String(params.startsAt));
    const endsAt = new Date(String(params.endsAt));
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
      throw new Error("a booking needs a start and an end");
    }

    // ── §11's RACE PROTECTION: the hold, then the re-check, then the write ──
    //
    // §17 M6's acceptance criterion is "concurrent transcripts cannot
    // double-book", and a longer transaction does not achieve it: two workers
    // both re-read free/busy, both see the slot free, and both insert.
    //
    // The partial unique index on `agent_slot_holds` is what makes the SECOND
    // one fail. The loser gets a 23505 and the planner proposes the next slot.
    const assignee = params.assignedUserId ? String(params.assignedUserId) : ctx.subject.userId;
    try {
      await client.query(
        `INSERT INTO agent_slot_holds
           (org_id, assignee_user_id, assignee_telecaller_id, start_at, end_at, expires_at, run_id)
         VALUES ($1, $2, $3, $4, $5, now() + interval '2 minutes', $6)`,
        [ctx.orgId, assignee, assignee ? null : ctx.subject.telecallerId, startsAt, endsAt, ctx.runId],
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        throw new Error("another call booked that slot a moment ago");
      }
      throw error;
    }

    // §11: "re-check free/busy AT WRITE TIME". The context's free/busy was
    // read before the model ran - minutes ago on a long call - and a booking
    // made from it is a booking made from a stale diary.
    const { rows: clash } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM appointments
        WHERE assigned_user_id = $1
          AND status NOT IN ('cancelled', 'no_show')
          AND tstzrange(starts_at - ($4 || ' minutes')::interval,
                        ends_at   + ($4 || ' minutes')::interval)
              && tstzrange($2, $3)`,
      [assignee, startsAt, endsAt, String(ctx.policy.bookingRules.bufferMinutes)],
    );
    if (Number(clash[0]?.n ?? 0) > 0) {
      throw new Error("that time stopped being free while this was being arranged");
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO appointments
         (org_id, workspace_id, appointment_type, lead_id, contact_id, assigned_user_id,
          starts_at, ends_at, location, status, created_by)
       -- The org and the workspace come FROM THE CALL, not from parameters:
       -- a booking must land in the same workspace as the call it came from,
       -- and reading it off the row is what guarantees that rather than
       -- trusting a caller to pass the right pair.
       --
       -- ctx.orgId is therefore not bound at all. It was, and Postgres
       -- refused the statement because nothing referenced it.
       SELECT c.org_id, c.workspace_id, $2, $3, $4, $5, $6, $7, $8, 'scheduled', NULL
         FROM calls c WHERE c.id = $1
       RETURNING id`,
      [
        ctx.callId,
        String(params.appointmentType ?? "consultation"),
        ctx.policy.leadId,
        ctx.policy.contactId,
        assignee,
        startsAt,
        endsAt,
        params.location ? String(params.location).slice(0, 500) : null,
      ],
    );

    const appointmentId = rows[0]?.id ?? null;
    // The hold becomes the booking. Not deleted: `consumed_at` is what stops
    // the sweep releasing it and what explains, later, which run took the slot.
    await client.query(
      `UPDATE agent_slot_holds
          SET consumed_at = now(), appointment_id = $2
        WHERE run_id = $1 AND start_at = $3 AND consumed_at IS NULL`,
      [ctx.runId, appointmentId, startsAt],
    );

    return {
      targetType: "appointment",
      targetId: appointmentId,
      response: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() },
    };
  },

  reschedule_slot: async (client, ctx, params) => {
    assertGate(ctx.gate, "booking");
    const appointmentId = String(params.appointmentId ?? "");
    const startsAt = new Date(String(params.startsAt));
    const endsAt = new Date(String(params.endsAt));
    if (!appointmentId) throw new Error("no appointment to move");

    const { rowCount } = await client.query(
      `UPDATE appointments
          SET starts_at = $2, ends_at = $3, status = 'rescheduled',
              -- §10A/0166: a moved appointment gets a FRESH reminder sequence.
              -- Without the bump its outbox rows keep the old sequence and the
              -- moved booking silently gets no reminders at all.
              reminder_sequence = reminder_sequence + 1,
              updated_at = now()
        WHERE id = $1 AND status NOT IN ('cancelled', 'completed', 'no_show')`,
      [appointmentId, startsAt, endsAt],
    );
    if ((rowCount ?? 0) === 0) throw new Error("that appointment can no longer be moved");

    return {
      targetType: "appointment",
      targetId: appointmentId,
      response: { startsAt: startsAt.toISOString() },
    };
  },

  cancel_slot: async (client, ctx, params) => {
    assertGate(ctx.gate, "booking");
    const appointmentId = String(params.appointmentId ?? "");
    if (!appointmentId) throw new Error("no appointment to cancel");

    const { rowCount } = await client.query(
      `UPDATE appointments
          SET status = 'cancelled',
              outcome = COALESCE(outcome || E'\\n', '') || $2,
              updated_at = now()
        WHERE id = $1 AND status NOT IN ('cancelled', 'completed')`,
      [appointmentId, "[assistant] the customer cancelled this on a call"],
    );
    if ((rowCount ?? 0) === 0) throw new Error("that appointment is already closed");
    return { targetType: "appointment", targetId: appointmentId, response: {} };
  },

  /**
   * §10's `send_message` - and it DOES NOT SEND, AND IT DOES NOT QUEUE EITHER.
   *
   * ══════════════════════════════════════════════════════════════════════
   *  WHY NOT AN OUTBOX ROW
   * ══════════════════════════════════════════════════════════════════════
   *
   * The obvious implementation is to queue into an outbox the way
   * `AppointmentRemindersService` does. It is wrong here for a specific,
   * checked reason: THERE IS NO DRAIN FOR A TENANT'S MESSAGE TO A LEAD.
   *
   * `marketing.booking_notifications` is Aura's OWN funnel outbox - the
   * marketing schema, written by us, drained for enquirers on our site - and
   * the marketing role's grants are not a tenant's. `appointment_notifications`
   * (0166) is tenant-scoped and keyed on an `appointment_id`, so it cannot
   * carry a message about a lead with no booking. Neither is this.
   *
   * Queuing into something nobody drains is a mistake this codebase has
   * already made and documented: `startFollowUpDrain` was imported and never
   * called, every rejection message the console reported as "queued" sat in
   * `marketing.funnel_followups` untouched, and the row's own error column
   * stayed empty - so there was no failure anywhere to notice. Repeating that
   * shape while a console said "sent" would be worse than not building it.
   *
   * So what this writes is a TASK: the template is validated, the recipient is
   * named, and a person presses send. That is also exactly what
   * `TRANSCRIPT_AGENT_DECISIONS.md` §4.6 commits to for §10A.5's "we tried to
   * reach you" fallback, and what this platform's standing rule requires -
   * nothing automated reaches a customer without a person saying yes.
   *
   * The template VALIDATION still happens here, and it is the valuable half:
   * §8.1's "pre-approved templates only, no free-form generation" is enforced
   * before a person is ever offered the send.
   */
  send_message: async (client, ctx, params) => {
    assertGate(ctx.gate, "messaging");
    const templateName = String(params.template ?? "").trim();
    const channel = String(params.channel ?? "whatsapp");
    if (!templateName) throw new Error("nothing to send - no template was named");

    const { rows: template } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM message_templates
        WHERE name = $1 AND channel = $2
        ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'local' THEN 1 ELSE 2 END
        LIMIT 1`,
      [templateName, channel],
    );
    const found = template[0];
    // §8.1: approved templates only. `local` is a canned reply on a personal
    // WhatsApp provider, which has no approval process - 0098's own comment.
    if (!found) throw new Error(`there is no "${templateName}" template on ${channel}`);
    if (found.status !== "approved" && found.status !== "local") {
      throw new Error(`the "${templateName}" template is ${found.status}, so it cannot be sent`);
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tasks
         (org_id, title, notes, lead_id, assignee_user_id, due_at, priority, status)
       VALUES ($1, $2, $3, $4, $5, now(), 'normal', 'open')
       RETURNING id`,
      [
        ctx.orgId,
        `Send the "${templateName}" message`,
        `[assistant] the customer asked for this on a call. The "${templateName}" template on ` +
          `${channel} is approved and ready - send it from the lead when you are happy with it. ` +
          `Nothing has been sent yet.`,
        ctx.policy.leadId,
        ctx.subject.userId,
      ],
    );
    return {
      targetType: "task",
      targetId: rows[0]!.id,
      // `sent: false`, stated rather than implied. A console that said "sent"
      // would be the lie the funnel's undrained outbox already taught this
      // codebase once.
      response: { sent: false, template: templateName, channel, handedToAPerson: true },
    };
  },

  send_information: async (client, ctx, params) => {
    assertGate(ctx.gate, "messaging");
    // Same path as `send_message`: a document share is a template send with a
    // document in it. One implementation, so the template and consent rules
    // cannot differ between them.
    return TOOLS.send_message!(client, ctx, {
      ...params,
      template: params.template ?? "custom_crm_info",
    });
  },

  register_complaint: async (client, ctx, params) => {
    assertGate(ctx.gate, "sensitive_flows");
    const summary = String(params.summary ?? "a complaint was raised on a call").slice(0, 2000);

    // A TASK, not a ticket table. This platform's support surface (0147) is
    // for problems a tenant reports to the VENDOR; a customer's complaint to
    // the tenant is the tenant's own work, and `tasks` is where their work
    // lives. High priority and unassigned-to-owner so somebody picks it up.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tasks (org_id, title, notes, lead_id, due_at, priority, status)
       VALUES ($1, 'Complaint raised on a call', $2, $3, now(), 'high', 'open')
       RETURNING id`,
      [ctx.orgId, summary, ctx.policy.leadId],
    );
    return { targetType: "task", targetId: rows[0]!.id, response: { summary } };
  },

  // ── T3: never automatic ──────────────────────────────────────────────────

  /**
   * §10's `request_refund_review` - T3.
   *
   * It is implemented, and it still never runs by itself: `mayAutoExecute`
   * refuses T3 in every mode, so the only path here is a person pressing
   * Approve. The tool exists so that approval has something to do; a T3 action
   * with no implementation would be a review queue whose Approve button fails.
   */
  request_refund_review: async (client, ctx, params) => {
    assertGate(ctx.gate, "sensitive_flows");
    const summary = String(params.summary ?? "a refund was asked for on a call").slice(0, 2000);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tasks (org_id, title, notes, lead_id, due_at, priority, status)
       VALUES ($1, 'Refund or cancellation asked for', $2, $3, now(), 'high', 'open')
       RETURNING id`,
      [
        ctx.orgId,
        `${summary}\n\n[assistant] This needs a decision from somebody who may approve a refund. Nothing has been promised to the customer.`,
        ctx.policy.leadId,
      ],
    );
    return { targetType: "task", targetId: rows[0]!.id, response: { summary } };
  },

  create_payment_link: async (client, ctx, params) => {
    assertGate(ctx.gate, "payments");
    // ── IT DOES NOT MINT A LINK ────────────────────────────────────────────
    //
    // §10 routes this "via Finance connectors", and `payment_request` is
    // `autoEligible: false` in the catalogue - so the only path here is a
    // person pressing Approve, and even then what this writes is a REQUEST for
    // the finance module's own connector path to fulfil.
    //
    // Minting a gateway link from a transcript read would put a number a model
    // produced in front of a customer's card, and `TRANSCRIPT_AGENT_DECISIONS`
    // §4.1 and the catalogue's own comment both say that is not something a
    // measured precision earns.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tasks (org_id, title, notes, lead_id, due_at, priority, status)
       VALUES ($1, 'Send a payment link', $2, $3, now(), 'high', 'open')
       RETURNING id`,
      [
        ctx.orgId,
        `[assistant] the customer asked how to pay on this call. Amount discussed: ${
          params.amountMinor ? (Number(params.amountMinor) / 100).toFixed(2) : "not stated"
        }. Create the link from the deal so it is attached to the right instalment.`,
        ctx.policy.leadId,
      ],
    );
    return { targetType: "task", targetId: rows[0]!.id, response: { mintedLink: false } };
  },
};

// ════════════════════════════════════════════════════════════════════════════
//  §10A's callback creation, shared by the tool and the API
// ════════════════════════════════════════════════════════════════════════════

/**
 * ── WHY THE WORKER HAS ITS OWN COPY OF THE CREATE ──────────────────────────
 *
 * `CallbacksService.create` in the API does the same thing, and two
 * implementations of "make a callback" is how one of them stops planning
 * reminders. The duplication is nonetheless deliberate and narrow: the worker
 * is a separate process with no Nest request scope, and importing a Nest
 * `@Injectable` into a plain pipeline function would drag the API's DI into the
 * worker.
 *
 * What is NOT duplicated is any RULE. The classification, the placement, the
 * priority and the reminder schedule all come from `@aura/shared` - the same
 * functions the API calls. What differs is only the SQL plumbing, and
 * `callbacks.test.ts` pins the rules both sides share.
 */
async function scheduleCallback(
  client: PoolClient,
  ctx: ToolContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const policy: CallbackPolicy = ctx.policy.callbackPolicy;
  const phrase = String(params.requestedText ?? "").trim();
  const reference = params.reference ? new Date(String(params.reference)) : new Date();

  // Re-classified here rather than trusting the planner's answer, so the row
  // and the reminders are built from one reading. The resolver is pure and
  // cheap; a second disagreement about what "kal shaam" meant is not.
  const classified = classifyCallback(phrase, {
    reference,
    timeZone: ctx.policy.timeZone,
    dayparts: ctx.policy.dayparts,
    dayStartMinute: policy.callingStartMinute,
    dayEndMinute: policy.callingEndMinute,
    workingWeekdays: policy.callingWeekdays,
    holidays: policy.holidays,
    policy,
  });

  if (classified.isStopRequest) {
    // §10A.1: "a request to stop calling is NOT a callback; it is
    // `do_not_contact` and always wins." Reaching here means the planner
    // mapped it wrongly, so the honest thing is to refuse rather than to
    // schedule a call to somebody who asked not to be called.
    throw new Error("that was a request to stop calling, not a request for a call back");
  }

  const dueAtRaw = classified.dueAt ?? (params.dueAt ? new Date(String(params.dueAt)) : null);
  if (!dueAtRaw) throw new Error("no time could be worked out for this call back");

  const placed = placeInCallingHours(dueAtRaw, policy, ctx.policy.timeZone);

  const priority = priorityScore({
    committed: classified.committed,
    type: classified.type,
    overdueMinutes: 0,
    attempts: 0,
    leadValueMinor: ctx.policy.amountTotalsMinor[ctx.policy.amountTotalsMinor.length - 1] ?? null,
    moneyAtRiskMinor: ctx.policy.amountTotalsMinor[0] ?? null,
    temperature: null,
    lateStage: false,
  });

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO callbacks
       (org_id, lead_id, contact_id, contact_name, contact_phone_hash, contact_phone_last3,
        number_key, preferred_language, source_call_id, source_run_id, source_intent_id,
        assigned_user_id, assigned_telecaller_id, original_user_id, original_telecaller_id,
        assignment_reason, type, committed, requested_text, evidence, condition_text,
        due_at, window_start, window_end, requested_due_at, moved_reason,
        needs_confirmation, priority_score, priority_reason, status, max_attempts,
        gate_decision_id)
     SELECT $1, $2, $3, l.contact_name, l.contact_number_hash, l.contact_number_last3,
            l.contact_number_key, $4, $5, $6, $7,
            $8, $9, $8, $9,
            'the person who took the call', $10, $11, $12, $13::jsonb, $14,
            $15, $16, $17, $18, $19, $20, $21, $22::jsonb, 'scheduled', $23, $6
       FROM leads l WHERE l.id = $2
     -- §10A.2's one-active-callback rule, held by 0186's partial unique index.
     -- DO NOTHING rather than an error: a redelivered transcript, a reprocess
     -- and a second call in the same minute all arrive here, and "there is
     -- already a live call-back for this person" is the correct outcome of
     -- every one of them. §17 M5a's acceptance criterion, enforced by the
     -- database rather than by a check.
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      ctx.orgId,
      ctx.policy.leadId,
      ctx.policy.contactId,
      params.preferredLanguage ? String(params.preferredLanguage) : null,
      ctx.callId,
      ctx.runId,
      params.intentId ? String(params.intentId) : null,
      ctx.subject.userId,
      ctx.subject.telecallerId,
      classified.type,
      classified.committed,
      phrase.slice(0, 500),
      JSON.stringify(params.evidence ?? []),
      classified.condition,
      placed.dueAt,
      classified.windowStart,
      classified.windowEnd,
      dueAtRaw,
      placed.moved ? placed.reason : null,
      classified.needsConfirmation,
      priority.score,
      JSON.stringify(priority.reasons),
      policy.maxAttempts,
    ],
  );

  const callbackId = rows[0]?.id ?? null;
  if (!callbackId) {
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM callbacks
        WHERE lead_id = $1
          AND status IN ('scheduled','due','reminded','in_progress','missed','escalated')
        LIMIT 1`,
      [ctx.policy.leadId],
    );
    return {
      targetType: "callback",
      targetId: existing[0]?.id ?? null,
      response: { created: false, reason: "there is already a live call-back for this person" },
    };
  }

  await replanReminders(client, ctx, callbackId, placed.dueAt);

  return {
    targetType: "callback",
    targetId: callbackId,
    response: {
      created: true,
      type: classified.type,
      committed: classified.committed,
      dueAt: placed.dueAt.toISOString(),
      moved: placed.moved,
      movedReason: placed.reason,
      needsConfirmation: classified.needsConfirmation,
      explanation: classified.reason,
    },
  };
}

/**
 * §10A.4's reminder rows, idempotent by constraint.
 *
 * `ON CONFLICT (callback_id, kind, channel) DO UPDATE` rather than a read
 * first: §10A.4 asks for reminders that "are idempotent", and a
 * read-then-write is not - two workers draining the same tick both read
 * nothing and both insert, and the telecaller gets two popups for one
 * commitment.
 */
async function replanReminders(
  client: PoolClient,
  ctx: ToolContext,
  callbackId: string,
  dueAt: Date,
): Promise<void> {
  // The old plan is for a time that no longer exists. Cancelled, not deleted,
  // so the delivery history survives the move.
  await client.query(
    `UPDATE callback_reminders
        SET state = 'cancelled', held_reason = 'the call-back moved', updated_at = now()
      WHERE callback_id = $1 AND state IN ('scheduled', 'held')`,
    [callbackId],
  );

  for (const reminder of reminderSchedule(dueAt, ctx.policy.callbackPolicy, new Date())) {
    for (const channel of reminder.channels) {
      await client.query(
        `INSERT INTO callback_reminders
           (org_id, callback_id, kind, channel, scheduled_at, state)
         VALUES ($1, $2, $3, $4, $5, 'scheduled')
         ON CONFLICT (callback_id, kind, channel) DO UPDATE
           SET scheduled_at = EXCLUDED.scheduled_at, state = 'scheduled',
               delivered_at = NULL, acted_at = NULL, held_reason = NULL,
               attempts = 0, updated_at = now()`,
        [ctx.orgId, callbackId, reminder.kind, channel, reminder.at],
      );
    }
  }
}

/** Which tools have an implementation. The planner refuses to plan the rest. */
export function isImplemented(tool: AgentToolName): boolean {
  return TOOLS[tool] !== undefined;
}
