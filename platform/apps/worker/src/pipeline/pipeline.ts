import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { type PoolClient, withOrgContext } from "@aura/db";
import { analyzeConversation, analyzeTranscript } from "@aura/llm";
import type { PipelineMessage } from "@aura/queue";
import { ExtractionSchema } from "@aura/shared";
import { type AsrResult, transcribe } from "./asr";
import { sarvamAsrConfigured, startSarvamAsrJob } from "./asr-sarvam";
import { upsertLead } from "./leads";
import { enqueueDispatch } from "./outbox";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "ap-south-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "aura_minio",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "aura_minio_password",
  },
});
const BUCKET = process.env.S3_BUCKET ?? "aura-recordings";

/**
 * Below this many seconds a recording is a ring-out, a misdial or an instant
 * hangup — there is no speech in it, but it still costs a full audio-in ASR
 * round trip plus the analyze calls to conclude exactly that. On a telecalling
 * floor these are a large share of call volume, so gating them is the cheapest
 * saving available. Set to 0 to transcribe everything.
 */
const MIN_TRANSCRIBE_SECONDS = Number(process.env.MIN_TRANSCRIBE_SECONDS ?? 5);

/**
 * How many times a call may fail before it stops retrying itself and waits for
 * a human. With the backoff below that spans roughly half an hour of trying,
 * which covers a provider rate-limit, a restart or a network blip without
 * hammering a provider that is genuinely rejecting us.
 */
export const MAX_PIPELINE_ATTEMPTS = Number(process.env.PIPELINE_MAX_ATTEMPTS ?? 5);

/**
 * 30s, 2m, 8m, 32m… capped at an hour — the same shape the CRM outbox uses.
 * The first retry is deliberately quick: the common case is a transient
 * provider error that has already cleared by the time we ask again.
 */
export function retryBackoffSeconds(attempt: number): number {
  return Math.min(30 * 4 ** Math.max(0, attempt - 1), 3600);
}

/**
 * Values that mean "the transcript did not say" but arrive as strings.
 *
 * Asked for a field the call never mentions, models write the *word* rather
 * than JSON null — `"null"`, `"not_discussed"`, `"N/A"`. Left alone these are
 * projected into call_facts as ordinary text, and call_facts is what the CRM
 * payload is built from, so a customer's system ends up holding a contact
 * literally named "null". Absent must look absent by the time it leaves here.
 *
 * Only the exact token counts: a genuine answer of "none of the above" is real
 * content and is not on this list.
 */
const ABSENT_TOKENS = new Set([
  "null",
  "none",
  "n/a",
  "na",
  "nil",
  "unknown",
  "not_discussed",
  "not discussed",
  "not_stated",
  "not stated",
  "not_mentioned",
  "not mentioned",
  "not_provided",
  "not provided",
  "unspecified",
  "",
]);

function isAbsent(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return ABSENT_TOKENS.has(value.trim().toLowerCase());
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Provider errors carry the useful detail; cap it so one huge stack trace
 *  cannot bloat the row, and keep the head where the cause usually is. */
function reasonOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.trim() || "unknown error";
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

export interface StageHelpers {
  /** Optimistic status transition; false means someone else already moved it. */
  advance(from: string, to: string): Promise<boolean>;
  /** Record the failure and schedule the next attempt (or give up). */
  fail(stage: string, err: unknown): Promise<void>;
}

/** Failures so far. Read up front so `fail` can name the attempt it is
 *  recording and pick the matching backoff. */
export async function priorAttempts(client: PoolClient, callId: string): Promise<number> {
  const {
    rows: [row],
  } = await client.query<{ pipeline_attempts: number }>(
    "SELECT pipeline_attempts FROM calls WHERE id = $1",
    [callId],
  );
  return Number(row?.pipeline_attempts ?? 0);
}

/**
 * The state-machine helpers for one call.
 *
 * Extracted to module scope because the pipeline is no longer driven from a
 * single place: a run that submits audio to a batch ASR provider stops at
 * TRANSCRIBING, and the poller that picks the call up later — possibly in a
 * different process — has to advance and fail it by exactly the same rules.
 */
export function stageHelpers(
  client: PoolClient,
  callId: string,
  attempts: number,
): StageHelpers {
  const advance = async (from: string, to: string) => {
    const res = await client.query(
      "UPDATE calls SET status = $3 WHERE id = $1 AND status = $2 RETURNING id",
      [callId, from, to],
    );
    return (res.rowCount ?? 0) > 0;
  };

  /**
   * Record the failure AND schedule the next attempt, unless the call has
   * used up its budget. The status stays FAILED_* either way — the call
   * really is failed right now; `next_attempt_at` is what distinguishes
   * "we'll try again shortly" from "this needs a person".
   *
   * Any outstanding batch-ASR job is forgotten here: the retry re-submits from
   * the audio, so keeping the old job id would only give the poller a job it
   * must not act on.
   */
  const fail = async (stage: string, err: unknown) => {
    const {
      rows: [row],
    } = await client.query<{ pipeline_attempts: number }>(
      `UPDATE calls
          SET status = $2,
              error_message = $3,
              pipeline_attempts = pipeline_attempts + 1,
              asr_job_id = NULL,
              asr_job_started_at = NULL,
              next_attempt_at = CASE
                WHEN pipeline_attempts + 1 < $4
                THEN now() + make_interval(secs => $5)
                ELSE NULL
              END
        WHERE id = $1
      RETURNING pipeline_attempts`,
      [
        callId,
        `FAILED_${stage}`,
        reasonOf(err),
        MAX_PIPELINE_ATTEMPTS,
        // Computed from the attempt this failure becomes, read before the
        // update inside the same statement — hence the +1 mirrored here.
        retryBackoffSeconds(attempts + 1),
      ],
    );

    const used = row?.pipeline_attempts ?? attempts + 1;
    if (used < MAX_PIPELINE_ATTEMPTS) {
      console.error(
        `call ${callId} failed at ${stage} (attempt ${used}/${MAX_PIPELINE_ATTEMPTS}), ` +
          `retrying in ${retryBackoffSeconds(used)}s:`,
        err,
      );
    } else {
      console.error(
        `call ${callId} failed at ${stage} and gave up after ${used} attempt(s):`,
        err,
      );
    }
  };

  return { advance, fail };
}

/**
 * Store an ASR result as this call's one transcript, and bill the audio.
 *
 * Reprocess re-runs the ASR stage; replacing rather than appending keeps a call
 * to exactly one transcript (otherwise the drawer can show a stale duplicate).
 */
export async function persistTranscript(
  client: PoolClient,
  orgId: string,
  callId: string,
  result: AsrResult,
): Promise<void> {
  await client.query("DELETE FROM transcripts WHERE call_id = $1", [callId]);
  await client.query(
    `INSERT INTO transcripts (org_id, call_id, language, engine, text, segments, diarized)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      orgId,
      callId,
      result.language,
      result.engine,
      result.text,
      JSON.stringify(result.segments),
      result.diarized,
    ],
  );
  await client.query(
    `INSERT INTO usage_events (org_id, kind, quantity, unit, ref_id)
     VALUES ($1, 'asr_seconds', (SELECT duration_s FROM calls WHERE id = $2), 'seconds', $2)`,
    [orgId, callId],
  );
}

/**
 * Everything after the transcript exists: analyze → crm-dispatch → COMPLETE.
 *
 * Entered from two places — the inline run, and the batch-ASR poller once the
 * provider hands back a transcript. Both arrive with the call in TRANSCRIBING,
 * so the first transition is the same either way.
 */
export async function runPostAsrStages(
  client: PoolClient,
  orgId: string,
  callId: string,
  { advance, fail }: StageHelpers,
): Promise<void> {
  // ── analyze ──────────────────────────────────────────────────────────
  if (!(await advance("TRANSCRIBING", "ANALYZING"))) return;

  // Read here rather than threading it down from processCall: the batch-ASR
  // path re-enters this function from the poller, which never saw the org row.
  const {
    rows: [vocabRow],
  } = await client.query<{ vocabulary: string[] | null }>(
    "SELECT vocabulary FROM organizations WHERE id = $1",
    [orgId],
  );
  const vocabulary = vocabRow?.vocabulary ?? [];

  // Who dialled. The recording comes off the telecaller's own handset, so this
  // is a genuine prior on which voice is the Agent — and the analyser's role
  // decision is the one thing a reader notices immediately when it is wrong.
  const {
    rows: [dirRow],
  } = await client.query<{ direction: string | null }>(
    "SELECT direction FROM calls WHERE id = $1",
    [callId],
  );
  const direction = dirRow?.direction ?? null;

  try {
    // Conversation intelligence: diarize (Agent/Customer) + per-turn intent +
    // call-level intent/sentiment/outcome. Always on, non-blocking — a failure
    // here must never fail the whole call (the tenant extraction still runs).
    try {
      const {
        rows: [t],
      } = await client.query(
        "SELECT text, segments, diarized FROM transcripts WHERE call_id = $1",
        [callId],
      );
      if (t?.text) {
        // Hand ASR's segments to the analyzer so it labels them instead of
        // re-splitting the flat text: ASR owns the boundaries and timings,
        // analyze only adds the Agent/Customer role and the intent.
        const asrSegments: Array<{
          speaker?: string;
          text: string;
          startMs?: number;
          endMs?: number;
        }> = Array.isArray(t.segments) ? t.segments : [];
        const intel = await analyzeConversation(t.text, asrSegments, vocabulary, direction);
        const segments = intel.turns.map((turn) => {
          const src = turn.index === null ? undefined : asrSegments[turn.index];
          return {
            speaker: turn.speaker,
            text: turn.text,
            intent: turn.intent,
            // Keep ASR's real offsets; only a re-split turn has none.
            startMs: src?.startMs ?? 0,
            endMs: src?.endMs ?? 0,
          };
        });
        const speakers = new Set(segments.map((s) => s.speaker));
        const summary = {
          summary: intel.summary,
          overall_intent: intel.overall_intent,
          customer_intent: intel.customer_intent,
          agent_intent: intel.agent_intent,
          sentiment: intel.sentiment,
          outcome: intel.outcome,
          key_points: intel.key_points,
          action_items: intel.action_items,
        };
        // Enrich, never destroy: if analyze produced no turns, the ASR
        // segments stay exactly as transcribed and only the call-level
        // intelligence is written.
        if (segments.length > 0) {
          await client.query(
            `UPDATE transcripts
               SET segments = $2::jsonb, diarized = $3, intelligence = $4::jsonb
             WHERE call_id = $1`,
            [
              callId,
              JSON.stringify(segments),
              speakers.size >= 2 || t.diarized === true,
              JSON.stringify(summary),
            ],
          );
        } else {
          await client.query(
            `UPDATE transcripts SET intelligence = $2::jsonb WHERE call_id = $1`,
            [callId, JSON.stringify(summary)],
          );
        }
        if (intel.tokensIn || intel.tokensOut) {
          await client.query(
            `INSERT INTO usage_events (org_id, kind, quantity, unit, ref_id)
             VALUES ($1, 'llm_tokens_in', $2, 'tokens', $3),
                    ($1, 'llm_tokens_out', $4, 'tokens', $3)`,
            [orgId, intel.tokensIn, callId, intel.tokensOut],
          );
        }
      }
    } catch (err) {
      console.error(`call ${callId}: conversation-intelligence error (non-blocking):`, err);
    }

    const {
      rows: [agent],
    } = await client.query(
      `SELECT a.id, a.version, a.system_prompt, a.field_schema FROM agents a
        JOIN calls c ON c.workspace_id = a.workspace_id
       WHERE c.id = $1 AND a.is_active = true
       ORDER BY a.version DESC LIMIT 1`,
      [callId],
    );
    const {
      rows: [transcript],
    } = await client.query("SELECT text FROM transcripts WHERE call_id = $1", [callId]);
    // No transcript means the call was gated as too short, or ASR genuinely
    // heard nothing. Running the agent over that can only invent field
    // values, and it is billed either way — so skip it.
    if (agent && transcript?.text) {
      const schema = ExtractionSchema.parse(agent.field_schema);
      const result = await analyzeTranscript(
        agent.system_prompt,
        schema,
        transcript.text,
        vocabulary,
      );

      await client.query(
        `INSERT INTO ai_outputs
           (org_id, call_id, agent_id, agent_version, output, provider, model,
            tokens_in, tokens_out, validation_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          orgId,
          callId,
          agent.id,
          agent.version,
          JSON.stringify(result.output),
          result.provider,
          result.model,
          result.tokensIn,
          result.tokensOut,
          result.validationStatus,
        ],
      );
      await client.query(
        `UPDATE calls SET agent_id = $2, agent_version = $3 WHERE id = $1`,
        [callId, agent.id, agent.version],
      );

      // call_facts projection — consumer (c) of the single field definition
      if (result.validationStatus !== "failed") {
        for (const field of schema.fields) {
          const value = result.output[field.key];
          // Skipped, not written as NULL: a fact that was never established
          // should be missing from the projection entirely, so the CRM payload
          // omits the key rather than sending an empty one.
          if (isAbsent(value)) continue;
          await client.query(
            `INSERT INTO call_facts (org_id, call_id, field_key, value_text, value_num, value_bool)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (call_id, field_key) DO UPDATE
               SET value_text = EXCLUDED.value_text,
                   value_num = EXCLUDED.value_num,
                   value_bool = EXCLUDED.value_bool`,
            [
              orgId,
              callId,
              field.key,
              field.type === "number" || field.type === "boolean"
                ? null
                : Array.isArray(value)
                  ? JSON.stringify(value)
                  : String(value),
              field.type === "number" ? (value as number) : null,
              field.type === "boolean" ? (value as boolean) : null,
            ],
          );
        }
      }

      await client.query(
        `INSERT INTO usage_events (org_id, kind, quantity, unit, ref_id)
         VALUES ($1, 'llm_tokens_in', $2, 'tokens', $3), ($1, 'llm_tokens_out', $4, 'tokens', $3)`,
        [orgId, result.tokensIn, callId, result.tokensOut],
      );
    }
  } catch (err) {
    await fail("ANALYZE", err);
    return;
  }

  // ── crm-dispatch ─────────────────────────────────────────────────────
  if (!(await advance("ANALYZING", "SYNCING"))) return;

  // Lead projection first: it is a local write, so the owner's board is
  // populated even if the tenant has no CRM connected at all. Non-blocking
  // for the same reason as dispatch — a qualification bug must not strand
  // calls in SYNCING.
  // Drives the only_qualified filter below. A projection that throws leaves
  // this false, so a lead-only connector stays silent rather than sending a
  // call whose qualification was never actually established.
  let qualified = false;
  try {
    const lead = await upsertLead(client, orgId, callId);
    qualified = lead.leadId !== null;
    console.log(
      lead.leadId
        ? `call ${callId}: lead ${lead.leadId} ${lead.reason}`
        : `call ${callId}: no lead — ${lead.reason}`,
    );
  } catch (err) {
    console.error(`call ${callId}: lead projection error (non-blocking):`, err);
  }

  // Queue the lead for every connected integration and try once immediately.
  // Anything that doesn't land is left due in crm_sync_log for the outbox
  // drain to retry with backoff, so a CRM outage delays delivery rather than
  // losing it. Failures NEVER block completion (§6.2).
  try {
    await enqueueDispatch(client, orgId, callId, qualified);
  } catch (err) {
    console.error(`call ${callId}: crm-dispatch error (non-blocking):`, err);
  }

  await advance("SYNCING", "COMPLETE");
  // The call made it through, so its failure history stops counting: a future
  // reprocess gets a full retry budget rather than inheriting attempts from a
  // problem that has already been resolved.
  await client.query(
    "UPDATE calls SET pipeline_attempts = 0, next_attempt_at = NULL WHERE id = $1",
    [callId],
  );
  console.log(`call ${callId}: COMPLETE`);
}

/**
 * Pipeline stages (design doc §6.2). Each stage advances the Postgres state
 * machine under an optimistic status check, so replays are idempotent and the
 * queue is only a wake-up signal. Terminal states: COMPLETE or FAILED_{STAGE}.
 *
 * With a batch ASR provider the run ends early, at TRANSCRIBING with a job id
 * recorded; `startAsrPoller` resumes it. With an inline provider the whole
 * pipeline still runs here, end to end, exactly as before.
 */
export async function processCall({ callId, orgId }: PipelineMessage): Promise<void> {
  await withOrgContext(orgId, async (client) => {
    const attempts = await priorAttempts(client, callId);
    const helpers = stageHelpers(client, callId, attempts);
    const { advance, fail } = helpers;

    /**
     * Transcription switched off for this instance (0014).
     *
     * Checked before the transcode advance so the call settles immediately
     * rather than walking the stages. Everything the console needs — the call
     * row, the number, the duration, the uploaded audio — already landed at
     * admission, so the customer's call log stays complete; only the paid
     * stages are skipped.
     *
     * Lead projection and CRM dispatch are skipped too. Both derive from the
     * analysis that did not run, so they would at best deliver an empty record
     * to the customer's real CRM — an outbound side effect nobody asked for and
     * which cannot be recalled.
     */
    const {
      rows: [orgRow],
    } = await client.query<{
      transcription_enabled: boolean;
      asr_language: string | null;
      asr_mode: string | null;
    }>(
      "SELECT transcription_enabled, asr_language, asr_mode FROM organizations WHERE id = $1",
      [orgId],
    );
    if (orgRow && orgRow.transcription_enabled === false) {
      if (await advance("UPLOADED", "TRANSCRIPTION_OFF")) {
        await client.query(
          "UPDATE calls SET error_message = NULL, next_attempt_at = NULL, pipeline_attempts = 0 WHERE id = $1",
          [callId],
        );
        console.log(`call ${callId}: transcription disabled for this instance — stored, not transcribed`);
      }
      return;
    }

    // ── transcode ────────────────────────────────────────────────────────
    // TODO (checklist §2.3): ffmpeg → 16 kHz mono Opus + device-envelope
    // decrypt. The client already records 16 kHz mono AAC, so pass-through
    // is acceptable until encryption-at-rest lands.
    if (!(await advance("UPLOADED", "TRANSCODING"))) {
      console.log(`call ${callId}: not in UPLOADED, skipping (idempotent replay)`);
      return;
    }

    // A retry starts clean: leaving the previous reason attached would make a
    // call that later completes still read as broken in the drawer. The pending
    // retry is cleared too — this run IS that retry, and leaving the timestamp
    // set would let the sweeper claim the call again while it is mid-flight.
    // Any ASR job from a previous run goes with it: this run submits its own,
    // and a stale id would have the poller waiting on the wrong job.
    await client.query(
      `UPDATE calls
          SET error_message = NULL, next_attempt_at = NULL,
              asr_job_id = NULL, asr_job_started_at = NULL
        WHERE id = $1`,
      [callId],
    );

    // ── asr ──────────────────────────────────────────────────────────────
    if (!(await advance("TRANSCODING", "TRANSCRIBING"))) return;

    // A duration of 0 means the device never reported one, not that the call
    // was empty — those still go through ASR rather than being dropped on a
    // missing field.
    const {
      rows: [durRow],
    } = await client.query("SELECT duration_s FROM calls WHERE id = $1", [callId]);
    const durationS = Number(durRow?.duration_s ?? 0);
    const tooShort = durationS > 0 && durationS < MIN_TRANSCRIBE_SECONDS;

    if (tooShort) {
      console.log(
        `call ${callId}: ${durationS}s is under MIN_TRANSCRIBE_SECONDS=${MIN_TRANSCRIBE_SECONDS} — skipping ASR + analyze`,
      );
    } else {
      try {
        const {
          rows: [rec],
        } = await client.query("SELECT s3_key FROM recordings WHERE call_id = $1", [callId]);
        const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: rec.s3_key }));
        const audio = Buffer.from(await object.Body!.transformToByteArray());

        if (sarvamAsrConfigured()) {
          // Batch provider: hand over the audio, record the job, and stop.
          // The call stays in TRANSCRIBING — which is exactly true — and the
          // poller drives it from here. Committing the job id before returning
          // is what makes this survive a worker restart: the provider is
          // already transcribing (and billing) this audio, so losing the id
          // would mean paying twice.
          const jobId = await startSarvamAsrJob(audio, callId, {
            language: orgRow?.asr_language,
            mode: orgRow?.asr_mode,
          });
          await client.query(
            "UPDATE calls SET asr_job_id = $2, asr_job_started_at = now() WHERE id = $1",
            [callId, jobId],
          );
          console.log(
            `call ${callId}: submitted to ${process.env.SARVAM_STT_MODEL ?? "saaras:v3"} ` +
              `[${orgRow?.asr_language ?? process.env.SARVAM_STT_LANGUAGE ?? "unknown"}/` +
              `${orgRow?.asr_mode ?? process.env.SARVAM_STT_MODE ?? "transcribe"}] (job ${jobId})`,
          );
          return;
        }

        const result = await transcribe(audio, "audio/mp4");
        await persistTranscript(client, orgId, callId, result);
      } catch (err) {
        await fail("ASR", err);
        return;
      }
    }

    await runPostAsrStages(client, orgId, callId, helpers);
  });
}
