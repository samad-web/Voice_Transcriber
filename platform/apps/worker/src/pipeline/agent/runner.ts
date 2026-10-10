import { type PoolClient, gateFor, meterGateUsage, withOrgContext } from "@aura/db";
import { understandTranscript } from "@aura/llm";
import {
  POLICY_VERSION,
  type GateDecision,
  type GateSubject,
  type PlannedAction,
  SCHEMA_VERSION,
  planActions,
  promptIntents,
  reviewSlaDeadline,
  toolSpec,
} from "@aura/shared";
import { announce } from "../realtime";
import { buildContext } from "./context";
import { RESOLVERS_VERSION, buildCandidates, resolveIntents } from "./resolvers";
import { executeAction, isImplemented } from "./tools";

/**
 * §3's PIPELINE, END TO END
 * (Build docs/transcript-agent-build-plan §3, §9, §17).
 *
 * ```
 *   transcript (already ingested and gated)
 *     -> claim the run              (optimistic, so a redelivery is a no-op)
 *     -> build context              (§5, one read)
 *     -> understand                 (§6, the only provider call)
 *     -> resolve                    (§7, deterministic)
 *     -> plan                       (§8, policy + tiers + ordering)
 *     -> persist intents and actions
 *     -> execute what may execute   (§10, gate re-checked per tool)
 *     -> meter, announce
 * ```
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE TRANSACTION BOUNDARIES ARE THE DESIGN
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `pipeline.ts`'s header makes this argument for the ASR stage and it applies
 * here unchanged: this deployment runs the worker in Mumbai against a database
 * in Seoul, and the provider call takes tens of seconds. So:
 *
 *   · phase 1 reads the context and COMMITS. Nothing is held open across the
 *     model call - a connection held for ninety seconds is a connection the
 *     console cannot have.
 *   · the model call happens with no transaction at all.
 *   · phase 2 writes the intents, the actions and the run in ONE transaction,
 *     so a crash leaves either a complete plan or none.
 *   · phase 3 executes, one transaction per action. Not one for the plan:
 *     §10 requires that "on partial failure, keep completed steps", and a
 *     single transaction would roll back the booking because the confirmation
 *     failed.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  A REDELIVERED MESSAGE MUST NOT PAY A PROVIDER TWICE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The claim is an optimistic `queued -> running` UPDATE, the same shape every
 * stage in `pipeline.ts` uses. A second delivery finds no row to claim and
 * returns - which is the only thing standing between a duplicate queue message
 * and a second understanding pass on the same call.
 */

const FEATURE = "transcript_agent" as const;

/** §9: "if the primary model or provider fails, retry with backoff." */
const MAX_RUN_ATTEMPTS = Number(process.env.AGENT_MAX_RUN_ATTEMPTS ?? 3);

/** 2m, 8m, 32m - `enrich.ts`'s shape, and for the same reason: nothing is waiting. */
function backoffSeconds(attempt: number): number {
  return Math.min(120 * 4 ** Math.max(0, attempt - 1), 3600);
}

export interface RunOutcome {
  runId: string | null;
  status: string;
  planned: number;
  executed: number;
  pendingReview: number;
  blocked: number;
  reason?: string;
}

/**
 * Run the agent over one already-ingested transcript.
 *
 * `transcriptId` and not `callId`: §4's versioning means a call can have more
 * than one transcript, and the run belongs to a VERSION. Keying on the call
 * would make a re-transcription either skip (because the call already has a
 * run) or duplicate.
 */
export async function runAgent(input: {
  orgId: string;
  transcriptId: string;
}): Promise<RunOutcome> {
  // ── phase 1: claim, and read everything ─────────────────────────────────
  const prepared = await withOrgContext(input.orgId, async (client) => {
    const { rows } = await client.query<TranscriptRow>(
      `SELECT t.id, t.call_id, t.lead_id, t.telecaller_id, t.caller_user_id,
              t.language, t.stt_confidence, t.roles_inferred, t.redacted_text,
              t.injection_signals, t.status, t.ended_at, t.duration_sec
         FROM agent_transcripts t WHERE t.id = $1`,
      [input.transcriptId],
    );
    const transcript = rows[0];
    if (!transcript) return { kind: "missing" as const };
    if (transcript.status !== "ready") {
      return { kind: "not_ready" as const, status: transcript.status };
    }
    if (!transcript.redacted_text) {
      return { kind: "not_ready" as const, status: "no redacted text to read" };
    }

    // §3A.4: re-check the gate WHEN THE JOB STARTS, "not only when it was
    // enqueued". An owner can switch the feature off in the minutes a message
    // sits in the queue, and §19 asserts that a stale queued job for a
    // disabled user is refused.
    const subject: GateSubject = {
      userId: transcript.caller_user_id,
      telecallerId: transcript.telecaller_id,
      teamId: null,
      ownerRole: null,
    };
    const resolvedSubject = await resolveSubject(client, subject);
    const gate = await gateFor(client, FEATURE, resolvedSubject);

    if (!gate.enabled) {
      // §3A.5: held, not failed. A run that the owner may switch back on must
      // be resumable, and `blocked_by_gate` is the state that says so.
      await client.query(
        `INSERT INTO agent_runs
           (org_id, transcript_id, call_id, status, error, gate_decision, effective_mode)
         VALUES ($1, $2, $3, 'blocked_by_gate', $4, $5::jsonb, 'off')
         ON CONFLICT (transcript_id) DO UPDATE
           SET status = 'blocked_by_gate', error = EXCLUDED.error,
               gate_decision = EXCLUDED.gate_decision, updated_at = now()`,
        [
          input.orgId,
          transcript.id,
          transcript.call_id,
          `the assistant is not switched on for this person (${gate.reason})`,
          JSON.stringify(gate),
        ],
      );
      return { kind: "gate_closed" as const, gate };
    }

    // The claim. `ON CONFLICT ... WHERE status IN (...)` rather than a read
    // first: two workers handling a double delivery both read nothing.
    const { rows: claimed } = await client.query<{ id: string; attempts: number }>(
      `INSERT INTO agent_runs
         (org_id, transcript_id, call_id, status, attempts, started_at,
          gate_decision, effective_mode, schema_version, policy_version, resolver_version)
       VALUES ($1, $2, $3, 'running', 1, now(), $4::jsonb, $5, $6, $7, $8)
       ON CONFLICT (transcript_id) DO UPDATE
         SET status = 'running',
             attempts = agent_runs.attempts + 1,
             started_at = now(),
             next_attempt_at = NULL,
             error = NULL,
             gate_decision = EXCLUDED.gate_decision,
             effective_mode = EXCLUDED.effective_mode,
             updated_at = now()
         WHERE agent_runs.status IN ('queued', 'failed', 'blocked_by_gate')
       RETURNING id, attempts`,
      [
        input.orgId,
        transcript.id,
        transcript.call_id,
        JSON.stringify(gate),
        gate.mode,
        SCHEMA_VERSION,
        POLICY_VERSION,
        RESOLVERS_VERSION,
      ],
    );
    const run = claimed[0];
    // Nothing claimed: another worker has it, or it is already finished. A
    // redelivery, and the correct response is to do nothing at all.
    if (!run) return { kind: "already_claimed" as const };

    if (run.attempts > MAX_RUN_ATTEMPTS) {
      await client.query(
        `UPDATE agent_runs SET status = 'failed',
                error = 'gave up after ' || $2 || ' attempts', updated_at = now()
          WHERE id = $1`,
        [run.id, MAX_RUN_ATTEMPTS],
      );
      return { kind: "exhausted" as const, runId: run.id };
    }

    const context = await buildContext(client, {
      orgId: input.orgId,
      callId: transcript.call_id,
      transcriptId: transcript.id,
      leadId: transcript.lead_id,
      telecallerId: transcript.telecaller_id,
      userId: transcript.caller_user_id,
      rolesKnown: !transcript.roles_inferred,
      language: transcript.language,
    });

    // §10's global pause, checked before the provider is called rather than
    // before each tool: a paused org should not be billed for a reading whose
    // every action would be refused.
    if (context.policy.paused) {
      await client.query(
        `UPDATE agent_runs SET status = 'blocked_by_gate',
                error = 'the assistant is paused for this workspace', updated_at = now()
          WHERE id = $1`,
        [run.id],
      );
      return { kind: "paused" as const, runId: run.id };
    }

    return {
      kind: "ready" as const,
      runId: run.id,
      transcript,
      gate,
      subject: resolvedSubject,
      context,
    };
  });

  switch (prepared.kind) {
    case "missing":
      return { runId: null, status: "missing", planned: 0, executed: 0, pendingReview: 0, blocked: 0 };
    case "not_ready":
      return {
        runId: null,
        status: "not_ready",
        reason: prepared.status,
        planned: 0,
        executed: 0,
        pendingReview: 0,
        blocked: 0,
      };
    case "gate_closed":
      return {
        runId: null,
        status: "blocked_by_gate",
        reason: prepared.gate.reason,
        planned: 0,
        executed: 0,
        pendingReview: 0,
        blocked: 0,
      };
    case "already_claimed":
      return { runId: null, status: "already_claimed", planned: 0, executed: 0, pendingReview: 0, blocked: 0 };
    case "exhausted":
      return { runId: prepared.runId, status: "failed", planned: 0, executed: 0, pendingReview: 0, blocked: 0 };
    case "paused":
      return { runId: prepared.runId, status: "blocked_by_gate", planned: 0, executed: 0, pendingReview: 0, blocked: 0 };
    default:
      break;
  }

  const { runId, transcript, gate, subject, context } = prepared;

  // ── the provider call, outside every transaction ────────────────────────
  let understanding: Awaited<ReturnType<typeof understandTranscript>>;
  try {
    understanding = await understandTranscript({
      transcript: transcript.redacted_text!,
      intents: context.prompt.intents,
      languages: context.prompt.languages,
      leadSummary: context.prompt.leadSummary,
      dispositions: context.prompt.dispositions,
      glossary: context.prompt.glossary,
      rolesKnown: context.prompt.rolesKnown,
      sttConfidence: transcript.stt_confidence,
      language: transcript.language,
    });
  } catch (error) {
    // §9: "never drop a transcript silently." The run is marked failed with a
    // next attempt, and the retry sweep picks it up.
    await withOrgContext(input.orgId, async (client) => {
      const { rows } = await client.query<{ attempts: number }>(
        `UPDATE agent_runs
            SET status = 'failed', error = $2,
                next_attempt_at = now() + ($3 || ' seconds')::interval,
                finished_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING attempts`,
        [
          runId,
          (error instanceof Error ? error.message : String(error)).slice(0, 500),
          String(backoffSeconds(1)),
        ],
      );
      void rows;
    });
    return { runId, status: "failed", planned: 0, executed: 0, pendingReview: 0, blocked: 0 };
  }

  // §6: "validate against a schema; retry once on failure, THEN ROUTE TO
  // REVIEW." The retry happened inside `understandTranscript`; this is the
  // route-to-review half, and it is deliberately not a failure: the run
  // exists, it cost money, and a person should see that the call could not be
  // read rather than it vanishing.
  if (!understanding.output) {
    await withOrgContext(input.orgId, async (client) => {
      await client.query(
        `UPDATE agent_runs
            SET status = 'review', error = $2, latency_ms = $3, cost_minor = $4,
                model = $5, prompt_version = $6, tokens_in = $7, tokens_out = $8,
                finished_at = now(), updated_at = now()
          WHERE id = $1`,
        [
          runId,
          `the call could not be read into a usable shape: ${understanding.validationErrors.join("; ")}`.slice(0, 500),
          understanding.latencyMs,
          estimateCostMinor(understanding.tokensIn, understanding.tokensOut),
          understanding.model,
          understanding.promptVersion,
          understanding.tokensIn,
          understanding.tokensOut,
        ],
      );
      await meterUsage(client, input.orgId, subject, transcript, understanding);
    });
    return { runId, status: "review", planned: 0, executed: 0, pendingReview: 0, blocked: 0 };
  }

  const output = understanding.output;

  // ── §7: resolve, deterministically ──────────────────────────────────────
  const reference = transcript.ended_at ? new Date(transcript.ended_at) : new Date();
  const injectionDetected = Array.isArray(transcript.injection_signals)
    ? transcript.injection_signals.length > 0
    : false;

  const { resolved, discarded } = resolveIntents({
    intents: output.intents,
    transcript: transcript.redacted_text!,
    reference,
    policy: context.policy,
    rolesInferred: transcript.roles_inferred,
    sttConfidence: transcript.stt_confidence,
    chunked: understanding.chunked,
    injectionDetected,
    modelTense: output.tense ?? null,
  });

  // ── phase 2: persist the plan, in one transaction ───────────────────────
  const persisted = await withOrgContext(input.orgId, async (client) => {
    // The intents first, so the actions can reference them.
    const intentIds = new Map<number, string>();
    for (const item of resolved) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO agent_intents
           (org_id, run_id, position, type, status, confidence, final_score,
            signals, slots, resolved, evidence, superseded)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12)
         ON CONFLICT (run_id, position) DO UPDATE
           SET final_score = EXCLUDED.final_score, signals = EXCLUDED.signals,
               resolved = EXCLUDED.resolved
         RETURNING id`,
        [
          input.orgId,
          runId,
          item.index,
          item.type,
          item.intent.status,
          item.intent.confidence,
          item.score,
          JSON.stringify(item.scoreComponents),
          JSON.stringify(item.intent.slots),
          JSON.stringify({
            time: item.time,
            amount: item.amount,
            slot: item.slot,
            crossChecksPassed: item.crossChecksPassed,
            crossCheckNotes: item.crossCheckNotes,
            clarification: item.clarification,
            resolverVersion: RESOLVERS_VERSION,
          }),
          JSON.stringify(item.intent.evidence),
          item.intent.superseded ?? false,
        ],
      );
      intentIds.set(item.index, rows[0]!.id);
    }

    // §6's discarded intents are stored too - at the END of the positions, so
    // the kept ones keep transcript order. §20 wants every decision
    // reproducible, and "we threw this away because the quote was invented" is
    // a decision.
    let position = resolved.length;
    for (const dropped of discarded) {
      await client.query(
        `INSERT INTO agent_intents
           (org_id, run_id, position, type, status, confidence, final_score,
            signals, slots, resolved, evidence, superseded)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, false)
         ON CONFLICT (run_id, position) DO NOTHING`,
        [
          input.orgId,
          runId,
          position,
          dropped.intent.type,
          dropped.intent.status,
          dropped.intent.confidence,
          JSON.stringify({ discarded: 1, evidence_ratio: dropped.ratio }),
          JSON.stringify(dropped.intent.slots),
          JSON.stringify({
            discarded: true,
            reason: "the quote behind this was not found in the transcript",
            quote: dropped.quote.slice(0, 200),
          }),
          JSON.stringify(dropped.intent.evidence),
        ],
      );
      position += 1;
    }

    // §8: the plan.
    const candidates = buildCandidates({
      callId: transcript.call_id,
      resolved,
      policy: context.policy,
      gate,
      identity: {
        userId: subject.userId,
        telecallerId: subject.telecallerId,
        grants: context.policy.grants,
        authorityLimitMinor: context.policy.authorityLimitMinor,
      },
      reference,
      disposition: output.disposition ?? null,
      summary: output.summary,
      qualitySignals: (output.quality_signals ?? null) as Record<string, unknown> | null,
      intentIds,
    });

    const thresholds: Record<string, { auto?: number; review?: number }> = {};
    for (const [type, cfg] of context.policy.intentConfig) {
      if (cfg.autoThreshold !== null || cfg.reviewThreshold !== null) {
        thresholds[type] = {
          auto: cfg.autoThreshold ?? undefined,
          review: cfg.reviewThreshold ?? undefined,
        };
      }
    }

    const plan = planActions({
      callId: transcript.call_id,
      gate,
      mode: gate.mode,
      candidates,
      existing: context.policy.existing,
      rolesInferred: transcript.roles_inferred,
      thresholds,
    });

    const slaDeadline = reviewSlaDeadline(new Date(), context.policy.reviewSlaHours, {
      workingWindows: context.policy.bookingRules.workingWindows,
      closedDays: context.policy.bookingRules.closedDays,
      timeZone: context.policy.timeZone,
    });

    const actionIds = new Map<string, string>();
    for (const action of plan.actions) {
      // §3A.2: shadow mode "analyze and log only, NO ACTIONS". A planned
      // action in shadow mode is recorded as what WOULD have happened, which
      // is what §13.4's shadow comparison reads.
      const state =
        gate.mode === "shadow" && action.state === "planned" ? "recorded" : action.state;

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO agent_actions
           (org_id, run_id, intent_id, call_id, tool, tier, capability, params,
            idempotency_key, state, policy_code, reason, final_score, band,
            run_order, depends_on, gate_decision_id, review_due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14,
                 $15, $16::text[], $2, $17)
         -- §10's MUST: "re-running the same plan produces no duplicates."
         -- Held by the unique index on the key rather than by a check.
         ON CONFLICT (idempotency_key) DO UPDATE
           SET reason = EXCLUDED.reason, final_score = EXCLUDED.final_score,
               updated_at = now()
         RETURNING id`,
        [
          input.orgId,
          runId,
          action.intentIndex === null ? null : (intentIds.get(action.intentIndex) ?? null),
          transcript.call_id,
          action.tool,
          action.tier,
          action.capability,
          JSON.stringify(action.params),
          action.idempotencyKey,
          state,
          action.code === "ok" ? null : action.code,
          action.reason || null,
          action.score,
          action.band,
          action.order,
          action.dependsOn,
          state === "pending_review" ? slaDeadline : null,
        ],
      );
      actionIds.set(action.idempotencyKey, rows[0]!.id);
    }

    const counts = countStates(plan.actions, gate.mode === "shadow");

    await client.query(
      `UPDATE agent_runs
          SET status = $2, effective_mode = $3, mode_cap_reason = $4,
              model = $5, prompt_version = $6, schema_version = $7,
              resolver_version = $8, policy_version = $9,
              output = $10::jsonb, latency_ms = $11, cost_minor = $12,
              tokens_in = $13, tokens_out = $14,
              escalated = $15, escalation_reason = $16, chunked = $17,
              finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [
        runId,
        gate.mode === "shadow" ? "shadow" : counts.planned > 0 ? "planned" : "review",
        plan.effectiveMode,
        plan.modeCapReason,
        understanding.model,
        understanding.promptVersion,
        understanding.schemaVersion,
        RESOLVERS_VERSION,
        POLICY_VERSION,
        JSON.stringify(output),
        understanding.latencyMs,
        estimateCostMinor(understanding.tokensIn, understanding.tokensOut),
        understanding.tokensIn,
        understanding.tokensOut,
        understanding.escalated,
        understanding.escalationReason,
        understanding.chunked,
      ],
    );

    // §3A.7's metering. Here and not at the top: §19's no-cost proof asserts
    // ZERO metered usage for a disabled user, and the only way to hold that is
    // to meter after the spend rather than before it.
    await meterUsage(client, input.orgId, subject, transcript, understanding);

    return { plan: plan.actions, actionIds, counts };
  });

  // ── phase 3: execute, one transaction per action ────────────────────────
  //
  // §10: "on partial failure, keep completed steps, mark failed ones, create a
  // review task, and never leave a customer-visible half-done state." One
  // transaction for the plan would roll back the booking because the
  // confirmation failed.
  let executed = 0;
  const failedKeys: string[] = [];

  for (const action of persisted.plan) {
    if (action.state !== "planned") continue;
    if (gate.mode === "shadow") continue;
    if (!isImplemented(action.tool)) continue;
    // §10's dependency order: an action whose prerequisite failed must be
    // SKIPPED, not attempted. `cascadeSkips` computes the closure below; this
    // is the per-action guard that stops the attempt.
    if (action.dependsOn.some((key) => failedKeys.includes(key))) continue;

    const actionId = persisted.actionIds.get(action.idempotencyKey);
    if (!actionId) continue;

    const result = await withOrgContext(input.orgId, (client) =>
      executeAction(
        client,
        {
          orgId: input.orgId,
          callId: transcript.call_id,
          runId: runId!,
          transcriptId: transcript.id,
          gate,
          subject,
          policy: context.policy,
          actionId,
          idempotencyKey: action.idempotencyKey,
        },
        action.tool,
        action.params as Record<string, unknown>,
      ),
    );

    if (result.ok) executed += 1;
    else failedKeys.push(action.idempotencyKey);
  }

  // The skip closure, written so the console shows "not attempted" rather
  // than leaving a planned action looking stuck for ever.
  if (failedKeys.length > 0) {
    await withOrgContext(input.orgId, async (client) => {
      const skipped = persisted.plan
        .filter(
          (action) =>
            action.state === "planned" &&
            !failedKeys.includes(action.idempotencyKey) &&
            action.dependsOn.some((key) => failedKeys.includes(key)),
        )
        .map((action) => persisted.actionIds.get(action.idempotencyKey))
        .filter((id): id is string => Boolean(id));

      if (skipped.length > 0) {
        await client.query(
          `UPDATE agent_actions
              SET state = 'skipped',
                  reason = 'something this depended on did not happen, so it was not attempted',
                  updated_at = now()
            WHERE id = ANY($1::uuid[])`,
          [skipped],
        );
      }
      await client.query(
        `UPDATE agent_runs SET status = 'executed', updated_at = now() WHERE id = $1`,
        [runId],
      );
    });
  } else if (executed > 0) {
    await withOrgContext(input.orgId, async (client) => {
      await client.query(
        `UPDATE agent_runs SET status = 'executed', updated_at = now() WHERE id = $1`,
        [runId],
      );
    });
  }

  // The console's live update. Last, and outside every transaction: the plan
  // is committed by now, so a broker that is down costs a refresh rather than
  // the run.
  try {
    announce(input.orgId, "call", "updated", transcript.call_id);
    if (persisted.counts.pendingReview > 0) announce(input.orgId, "lead", "updated", transcript.call_id);
  } catch (error) {
    console.error(`agent run ${runId}: announce failed (non-blocking):`, error);
  }

  return {
    runId,
    status: failedKeys.length > 0 || executed > 0 ? "executed" : "planned",
    planned: persisted.counts.planned,
    executed,
    pendingReview: persisted.counts.pendingReview,
    blocked: persisted.counts.blocked,
  };
}

function countStates(actions: readonly PlannedAction[], shadow: boolean) {
  return {
    planned: shadow ? 0 : actions.filter((a) => a.state === "planned").length,
    pendingReview: actions.filter((a) => a.state === "pending_review").length,
    blocked: actions.filter((a) => a.state === "blocked").length,
    recorded: actions.filter((a) => a.state === "recorded").length,
  };
}

/**
 * The subject, with the team and the persona filled in.
 *
 * `gateSubjectForCall` in `@aura/db` does this from a CALL; here the
 * transcript already carries the two identities, so only the team and the
 * persona are missing - and they are what the bulk toggle writes against.
 */
async function resolveSubject(client: PoolClient, subject: GateSubject): Promise<GateSubject> {
  if (!subject.userId) return subject;
  const { rows } = await client.query<{ team_id: string | null; owner_role: string | null }>(
    `SELECT (SELECT p.team_id
               FROM position_assignments pa
               JOIN positions p ON p.id = pa.position_id
              WHERE pa.user_id = $1 AND pa.end_date IS NULL
              ORDER BY pa.start_date DESC
              LIMIT 1) AS team_id,
            (SELECT m.owner_role FROM memberships m WHERE m.user_id = $1 LIMIT 1) AS owner_role`,
    [subject.userId],
  );
  return {
    ...subject,
    teamId: rows[0]?.team_id ?? null,
    ownerRole: rows[0]?.owner_role ?? null,
  };
}

async function meterUsage(
  client: PoolClient,
  orgId: string,
  subject: GateSubject,
  transcript: TranscriptRow,
  understanding: { tokensIn: number; tokensOut: number },
): Promise<void> {
  await meterGateUsage(
    client,
    orgId,
    FEATURE,
    { userId: subject.userId, telecallerId: subject.telecallerId },
    {
      transcripts: 1,
      // Rounded UP. A 40-second call is a minute on an invoice, and rounding
      // down would under-report every short call on a telecalling floor -
      // which is most of them.
      audioMinutes: Math.ceil((transcript.duration_sec ?? 0) / 60),
      modelCostMinor: estimateCostMinor(understanding.tokensIn, understanding.tokensOut),
    },
  );
}

/**
 * §13.2's "cost per call", estimated from tokens.
 *
 * ── AN ESTIMATE, AND SAID SO ───────────────────────────────────────────────
 *
 * The provider's own billing is the authority and arrives monthly. This is the
 * per-call figure §3A.7's admin table shows beside each person's accuracy, and
 * an estimate that is in the right order of magnitude is worth far more to an
 * owner deciding where the feature pays off than a blank column.
 *
 * The rates are env-overridable because they change, and pinning them in code
 * would mean a price change needs a deploy before the console stops lying.
 * Defaults are paise per million tokens for a flash-tier model.
 */
export function estimateCostMinor(tokensIn: number, tokensOut: number): number {
  const inPerMillion = Number(process.env.AGENT_COST_IN_MINOR_PER_M ?? 2_500);
  const outPerMillion = Number(process.env.AGENT_COST_OUT_MINOR_PER_M ?? 10_000);
  return Math.round((tokensIn * inPerMillion + tokensOut * outPerMillion) / 1_000_000);
}

interface TranscriptRow {
  id: string;
  call_id: string;
  lead_id: string | null;
  telecaller_id: string | null;
  caller_user_id: string | null;
  language: string | null;
  stt_confidence: number | null;
  roles_inferred: boolean;
  redacted_text: string | null;
  injection_signals: unknown;
  status: string;
  ended_at: string | null;
  duration_sec: number | null;
}

// ════════════════════════════════════════════════════════════════════════════
//  The durable half: sweeps
// ════════════════════════════════════════════════════════════════════════════

/**
 * The queue is only a wake-up signal (design doc §6.2), so this finds the work
 * Postgres already records: a transcript nobody started, a run whose message
 * was lost, a retry that is now due, and a gate that has re-opened.
 *
 * Without it, a lost message would hold a call's reading for ever - the exact
 * stranding `sweepEnrichment` exists to prevent on the other lane.
 */
export async function sweepAgentRuns(limit = 50): Promise<number> {
  const { getAdminPool } = await import("@aura/db");
  const pool = getAdminPool();

  const { rows } = await pool.query<{ org_id: string; transcript_id: string }>(
    `SELECT t.org_id, t.id AS transcript_id
       FROM agent_transcripts t
       LEFT JOIN agent_runs r ON r.transcript_id = t.id
      WHERE t.status = 'ready'
        AND (
          r.id IS NULL
          OR (r.status IN ('failed', 'blocked_by_gate')
              AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now())
              AND r.attempts < $2)
          -- A worker killed mid-run leaves a row in running that nothing
          -- else will look at again. Ten minutes is far longer than the
          -- slowest escalated read and short enough that a restart does not
          -- strand a call for an hour.
          OR (r.status = 'running' AND r.started_at < now() - interval '10 minutes')
        )
      ORDER BY t.created_at
      LIMIT $1`,
    [limit, MAX_RUN_ATTEMPTS],
  );

  let started = 0;
  for (const row of rows) {
    try {
      const outcome = await runAgent({ orgId: row.org_id, transcriptId: row.transcript_id });
      if (outcome.status !== "already_claimed") started += 1;
    } catch (error) {
      console.error(`agent sweep: transcript ${row.transcript_id} failed:`, error);
    }
  }
  return started;
}

export function startAgentSweep(): NodeJS.Timeout {
  const intervalMs = Number(process.env.AGENT_SWEEP_INTERVAL_MS ?? 60_000);
  return setInterval(() => {
    sweepAgentRuns().catch((error) => console.error("agent sweep failed:", error));
  }, intervalMs);
}

/**
 * §3A.5: "pending review items are frozen and EXPIRE AFTER N DAYS (default
 * 14) or resume if re-enabled in time."
 *
 * Two transitions, and the order matters: a frozen item whose gate has
 * re-opened goes back to `pending_review` BEFORE the ageing runs, so an owner
 * who switches the feature back on inside the window gets their queue back
 * rather than finding it expired on the same tick.
 */
export async function sweepFrozenActions(): Promise<{ resumed: number; expired: number }> {
  const { getAdminPool } = await import("@aura/db");
  const pool = getAdminPool();

  const { rows: orgs } = await pool.query<{ org_id: string; frozen_expiry_days: number }>(
    `SELECT org_id, frozen_expiry_days FROM agent_settings`,
  );

  let resumed = 0;
  let expired = 0;

  for (const org of orgs) {
    await withOrgContext(org.org_id, async (client) => {
      // Resume first. The gate is re-resolved per action's own telecaller,
      // which is the only correct granularity: an owner may have switched one
      // person back on and not another.
      const { rows: frozen } = await client.query<{ id: string; telecaller_id: string | null }>(
        `SELECT a.id, t.telecaller_id
           FROM agent_actions a
           JOIN agent_runs r ON r.id = a.run_id
           JOIN agent_transcripts t ON t.id = r.transcript_id
          WHERE a.state = 'frozen'
          LIMIT 500`,
      );

      for (const action of frozen) {
        const subject = await resolveSubject(client, {
          userId: null,
          telecallerId: action.telecaller_id,
          teamId: null,
          ownerRole: null,
        });
        const gate = await gateFor(client, FEATURE, subject);
        if (!gate.enabled) continue;
        const { rowCount } = await client.query(
          `UPDATE agent_actions
              SET state = 'pending_review',
                  reason = 'the assistant was switched back on, so this is waiting for you again',
                  updated_at = now()
            WHERE id = $1 AND state = 'frozen'`,
          [action.id],
        );
        resumed += rowCount ?? 0;
      }

      const { rowCount } = await client.query(
        `UPDATE agent_actions
            SET state = 'expired',
                reason = 'this waited ' || $1 || ' days while the assistant was switched off',
                updated_at = now()
          WHERE state = 'frozen'
            AND updated_at < now() - ($1 || ' days')::interval`,
        [org.frozen_expiry_days],
      );
      expired += rowCount ?? 0;
    });
  }

  return { resumed, expired };
}

export function startFrozenActionSweep(): NodeJS.Timeout {
  const intervalMs = Number(process.env.AGENT_FROZEN_SWEEP_INTERVAL_MS ?? 3_600_000);
  return setInterval(() => {
    sweepFrozenActions().catch((error) => console.error("frozen action sweep failed:", error));
  }, intervalMs);
}

/** Re-exported for `main.ts`'s one import. */
export { promptIntents, toolSpec };
