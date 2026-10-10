import { type PoolClient, gateFor, gateSubjectForCall, withOrgContext } from "@aura/db";
import {
  type GateDecision,
  type GateSubject,
  prepareTranscript,
} from "@aura/shared";

/**
 * §4 - INGESTION, AND THE GATE THAT COMES BEFORE EVERYTHING
 * (Build docs/transcript-agent-build-plan §4, §17 M1/M1a).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE GATE CHECK IS THE FIRST THING, AND §19 ASSERTS IT COSTS NOTHING
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §4's MUST: "resolve the telecaller for the call and call `FeatureGate.check`
 * BEFORE ANY PROCESSING. If the feature is not enabled for that user, mark the
 * transcript `skipped_feature_off` and stop; make no model, calendar or
 * messaging call."
 *
 * §19 turns that into a test: "for a disabled user, assert zero model calls,
 * zero calendar and messaging calls, and zero metered usage."
 *
 * So the order in `ingestTranscript` is load-bearing. The gate is resolved
 * before the transcript text is even read, the row is written with
 * `status = 'skipped_feature_off'`, and the function RETURNS - there is no run
 * to enqueue, so nothing downstream can decide to be clever about it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  IDEMPOTENCY IS THE DATABASE'S JOB
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §4's other MUST: "unique key on (source, external_call_id,
 * transcript_version). Duplicate, late or out-of-order deliveries must not
 * create duplicate actions."
 *
 * 0185 carries that as a UNIQUE constraint and this writes through
 * `ON CONFLICT DO NOTHING`. Not a read-then-write: two workers handling a
 * double delivery both read nothing and both insert, which is the exact race
 * an idempotency key exists to lose.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  A NEWER VERSION SUPERSEDES, AND RECONCILES
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §4: "a newer transcript version supersedes the older one and triggers
 * reconciliation (cancel or amend actions created from the older one where
 * safe)."
 *
 * "Where safe" is the whole difficulty and `reconcileSupersededVersion` below
 * is explicit about where the line is: a PENDING suggestion from the old
 * reading is withdrawn, because nobody has acted on it. An EXECUTED action is
 * NOT undone - a customer has been told about a booking, and un-booking it
 * because a better transcription arrived would be the agent taking an action
 * nobody reviewed.
 */

/** §4's gate outcome, returned so the caller can prove what happened. */
export type IngestOutcome =
  | { kind: "ready"; transcriptId: string; version: number; gate: GateDecision }
  | { kind: "duplicate"; transcriptId: string | null }
  | { kind: "skipped_feature_off"; transcriptId: string; gate: GateDecision }
  | { kind: "no_conversation"; transcriptId: string; reason: string }
  | { kind: "no_subject"; reason: string };

export interface IngestInput {
  orgId: string;
  callId: string;
  /** 'handset' for this platform's own pipeline; a provider name for a webhook. */
  source: string;
  /** The provider's own id for the call. Part of §4's idempotency key. */
  externalCallId?: string;
  /** The raw transcript text. Redacted before anything else sees it. */
  text: string | null;
  segments?: unknown;
  /** Did the STT provider label the speakers, or were roles inferred? */
  diarized: boolean;
  language?: string | null;
  sttProvider?: string | null;
  sttConfidence?: number | null;
  leadId?: string | null;
  direction?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
  durationSec?: number | null;
}

/**
 * §4's "skip or flag calls that are too short, silent, voicemail or IVR-only".
 *
 * Length rather than content, deliberately. A voicemail greeting and a real
 * forty-word conversation are hard to tell apart by keyword and trivial to
 * tell apart by length, and the cost of being wrong is asymmetric: skipping a
 * real call loses a lead, while reading a voicemail costs a few paise. So the
 * bar is LOW and the honest answer for everything above it is "read it".
 *
 * 40 characters is the same threshold `callSamples` in the agents module uses
 * to decide a transcript is worth testing an extractor against - one number,
 * two readers.
 */
export const MIN_CONVERSATION_CHARS = Number(process.env.AGENT_MIN_TRANSCRIPT_CHARS ?? 40);

const FEATURE = "transcript_agent" as const;

/**
 * Ingest one transcript, gate-first.
 *
 * Returns WITHOUT enqueueing anything when the gate is closed. The caller
 * (`runner.ts`) publishes the run only for a `ready` outcome, which is what
 * makes §19's no-cost proof a property of the code rather than of a convention.
 */
export async function ingestTranscript(input: IngestInput): Promise<IngestOutcome> {
  const externalCallId = input.externalCallId ?? input.callId;

  return withOrgContext(input.orgId, async (client) => {
    // ── 1. WHO. §3A.3's subject, before anything else. ────────────────────
    const subject = await gateSubjectForCall(client, input.callId);
    if (!subject) {
      // No call row, or no attribution on it. Nothing to gate on, so nothing
      // is processed - the fail-closed direction. A call with no telecaller is
      // a data problem worth seeing rather than a reason to process it under
      // somebody else's permissions.
      return { kind: "no_subject", reason: "the call has no telecaller attributed to it" };
    }

    // ── 2. THE GATE. Before the text is read, before a provider is called. ──
    const gate = await gateFor(client, FEATURE, subject);

    // The version this delivery is. A re-transcription of the same call
    // arrives as the next version; a duplicate delivery arrives as the same
    // one and loses to the unique constraint below.
    const { rows: versionRows } = await client.query<{ next: number }>(
      `SELECT COALESCE(max(version), 0) + 1 AS next
         FROM agent_transcripts
        WHERE source = $1 AND external_call_id = $2`,
      [input.source, externalCallId],
    );
    const version = Number(versionRows[0]?.next ?? 1);

    if (!gate.enabled) {
      // §3A.4: "Transcript stored per org policy but marked
      // `skipped_feature_off`; NO MODEL CALL, NO COST."
      //
      // The row is written WITHOUT `redacted_text`. Storing the text for a
      // telecaller whose owner has not switched the feature on would be
      // retaining a transcript for a purpose nobody consented to - and the
      // row's job here is only to explain, later, why this call has no run.
      const id = await insertTranscript(client, input, {
        version,
        subject,
        status: "skipped_feature_off",
        statusReason: `the assistant is not switched on for this person (${gate.reason})`,
        redacted: null,
      });
      return { kind: "skipped_feature_off", transcriptId: id ?? "", gate };
    }

    // ── 3. §4's no_conversation gate. Cheap, and before the model. ────────
    const text = input.text ?? "";
    if (text.trim().length < MIN_CONVERSATION_CHARS) {
      const id = await insertTranscript(client, input, {
        version,
        subject,
        status: "no_conversation",
        statusReason:
          text.trim().length === 0
            ? "there was no speech in this call"
            : `too little was said to read (${text.trim().length} characters)`,
        redacted: null,
      });
      return {
        kind: "no_conversation",
        transcriptId: id ?? "",
        reason: "too short to read",
      };
    }

    // ── 4. §4's redaction, BEFORE the transcript reaches any model. ───────
    //
    // `prepareTranscript` masks the card numbers, OTPs, Aadhaar and account
    // numbers, defangs §14's injection markers, and returns the counts. The
    // mapping is encrypted by the caller if it is kept at all; nothing
    // downstream of the model is given it.
    const prepared = prepareTranscript(text);

    const id = await insertTranscript(client, input, {
      version,
      subject,
      status: "ready",
      statusReason: null,
      redacted: prepared,
    });

    if (!id) {
      // The unique constraint refused it: this exact (source, external id,
      // version) has already been ingested. §4's "duplicate, late or
      // out-of-order deliveries must not create duplicate actions" - held by
      // the database rather than by a check.
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM agent_transcripts
          WHERE source = $1 AND external_call_id = $2 AND version = $3`,
        [input.source, externalCallId, version],
      );
      return { kind: "duplicate", transcriptId: rows[0]?.id ?? null };
    }

    // ── 5. Supersede the previous version, and reconcile what it produced. ─
    if (version > 1) {
      await reconcileSupersededVersion(client, {
        source: input.source,
        externalCallId,
        newVersion: version,
        newTranscriptId: id,
      });
    }

    return { kind: "ready", transcriptId: id, version, gate };
  });
}

async function insertTranscript(
  client: PoolClient,
  input: IngestInput,
  extra: {
    version: number;
    subject: GateSubject;
    status: string;
    statusReason: string | null;
    redacted: ReturnType<typeof prepareTranscript> | null;
  },
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO agent_transcripts
       (org_id, call_id, source, external_call_id, version, lead_id,
        telecaller_id, caller_user_id, direction, started_at, ended_at, duration_sec,
        language, stt_provider, stt_confidence, roles_inferred,
        redacted_text, redaction_counts, redaction_version, injection_signals,
        status, status_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             $17, $18::jsonb, $19, $20::jsonb, $21, $22)
     ON CONFLICT (org_id, source, external_call_id, version) DO NOTHING
     RETURNING id`,
    [
      input.orgId,
      input.callId,
      input.source,
      input.externalCallId ?? input.callId,
      extra.version,
      input.leadId ?? null,
      extra.subject.telecallerId,
      extra.subject.userId,
      input.direction ?? null,
      input.startedAt ?? null,
      input.endedAt ?? null,
      input.durationSec ?? null,
      input.language ?? null,
      input.sttProvider ?? null,
      input.sttConfidence ?? null,
      // §4: "if roles are missing, infer them with a model step and mark
      // `roles_inferred = true`, lowering autonomy for that call." The
      // provider's own `diarized` flag is the signal, and it is inverted here
      // rather than at the reader - a column called `roles_inferred` cannot be
      // misread, and a column called `diarized` has been (the ASR bake-off
      // found Gemini's `diarized` flag lies).
      !input.diarized,
      extra.redacted?.redacted ?? null,
      JSON.stringify(extra.redacted?.counts ?? {}),
      extra.redacted?.version ?? null,
      JSON.stringify(extra.redacted?.injection ?? []),
      extra.status,
      extra.statusReason,
    ],
  );
  return rows[0]?.id ?? null;
}

/**
 * §4's reconciliation, with the line stated.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT IS WITHDRAWN AND WHAT IS NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A better transcription arriving is a reason to revisit a SUGGESTION and not
 * a reason to undo a DECISION.
 *
 *   · `pending_review` -> `expired`, with a reason. Nobody acted on it, and
 *     leaving it would put two readings of the same call in front of a person
 *     with no way to tell which transcript each came from.
 *   · `planned` -> `blocked`. It was going to run and has not yet; the new
 *     run will plan whatever the better transcript implies.
 *   · `done`, `approved`, `executing` -> UNTOUCHED. A customer may already
 *     have been told. §10's compensating actions exist for a FAILED step, not
 *     for a second opinion, and an agent that cancelled a confirmed booking
 *     because the audio was re-read would be taking a customer-visible action
 *     nobody reviewed - which is the one thing §8.2's tiers exist to prevent.
 *
 * The superseded transcript is marked rather than deleted, and the new one's
 * id is recorded on it, so "why does this call have two runs" has an answer.
 */
export async function reconcileSupersededVersion(
  client: PoolClient,
  input: {
    source: string;
    externalCallId: string;
    newVersion: number;
    newTranscriptId: string;
  },
): Promise<{ supersededTranscripts: number; withdrawnActions: number }> {
  const { rows: superseded } = await client.query<{ id: string }>(
    `UPDATE agent_transcripts
        SET status = 'superseded',
            status_reason = 'a newer transcription of this call arrived',
            superseded_by = $4,
            updated_at = now()
      WHERE source = $1 AND external_call_id = $2 AND version < $3
        AND status <> 'superseded'
      RETURNING id`,
    [input.source, input.externalCallId, input.newVersion, input.newTranscriptId],
  );

  if (superseded.length === 0) return { supersededTranscripts: 0, withdrawnActions: 0 };

  const ids = superseded.map((row) => row.id);

  const { rowCount } = await client.query(
    `UPDATE agent_actions a
        SET state = CASE WHEN a.state = 'pending_review' THEN 'expired' ELSE 'blocked' END,
            policy_code = 'superseded',
            reason = 'a better transcription of this call arrived, so this was withdrawn',
            updated_at = now()
      WHERE a.run_id IN (SELECT id FROM agent_runs WHERE transcript_id = ANY($1::uuid[]))
        -- The line. Anything already approved, executing or done is left
        -- alone: a customer may have been told, and un-telling them is an
        -- action nobody reviewed.
        AND a.state IN ('pending_review', 'planned')`,
    [ids],
  );

  // The runs themselves are left in place. §20 requires every decision to be
  // "reproducible from stored inputs", and deleting the run that read the
  // earlier transcript would make the earlier transcript unexplainable.
  return { supersededTranscripts: superseded.length, withdrawnActions: rowCount ?? 0 };
}

/**
 * §3A.5: "queued runs not yet started are held as `blocked_by_gate`; running
 * runs stop BEFORE THEIR NEXT TOOL CALL."
 *
 * Called by the gate-change path and by the run claim. Returns how many were
 * held, so the switch-off confirmation can say.
 */
export async function holdRunsForClosedGate(
  orgId: string,
  telecallerId: string | null,
): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    // `orgId` is NOT a parameter, and that is not an oversight.
    //
    // `withOrgContext` has already set `app.org_id`, and RLS has already
    // narrowed this table to the one tenant - so there is no org predicate
    // here to get wrong. Passing it anyway is what the first version did, and
    // Postgres refuses the statement outright with "could not determine data
    // type of parameter $1" because nothing in the SQL uses it. A bound
    // parameter the statement does not reference is a runtime error, not dead
    // code, which is why this was caught by preparing every statement against
    // a real database rather than by typecheck.
    const { rowCount } = await client.query(
      `UPDATE agent_runs r
          SET status = 'blocked_by_gate',
              error = 'the assistant was switched off for this person before this run started',
              updated_at = now()
        WHERE r.status = 'queued'
          AND ($1::uuid IS NULL OR r.transcript_id IN (
                SELECT id FROM agent_transcripts WHERE telecaller_id = $1))`,
      [telecallerId],
    );
    return rowCount ?? 0;
  });
}

/**
 * §3A.5: "pending review items are FROZEN (not executable) and expire after N
 * days (default 14) or resume if re-enabled in time."
 *
 * Two states and not one, because they mean different things to the person
 * looking at the queue: `frozen` is recoverable by switching the feature back
 * on, `expired` is not. The sweep in `runner.ts` does the ageing.
 */
export async function freezePendingActions(
  orgId: string,
  telecallerId: string | null,
): Promise<number> {
  return withOrgContext(orgId, async (client) => {
    // Again, no `orgId` parameter - RLS has scoped it. See the note in
    // `holdRunsForClosedGate` above.
    const { rowCount } = await client.query(
      `UPDATE agent_actions a
          SET state = 'frozen',
              reason = 'the assistant was switched off, so this is waiting rather than expired',
              updated_at = now()
        WHERE a.state = 'pending_review'
          AND ($1::uuid IS NULL OR a.run_id IN (
                SELECT r.id FROM agent_runs r
                  JOIN agent_transcripts t ON t.id = r.transcript_id
                 WHERE t.telecaller_id = $1))`,
      [telecallerId],
    );
    return rowCount ?? 0;
  });
}
