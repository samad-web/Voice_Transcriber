import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { type PoolClient, withOrgContext } from "@aura/db";
import { analyzeTranscript } from "@aura/llm";
import { type PipelineMessage, publishEnrich } from "@aura/queue";
import { ExtractionSchema } from "@aura/shared";
import { type AsrResult, transcribe } from "./asr";
import { sarvamAsrConfigured, startSarvamAsrJob } from "./asr-sarvam";
import { prepareAudioForAsr } from "./audio-prep";
import { projectLeadToCrm } from "./crm-objects";
import { upsertLead } from "./leads";
import { announce } from "./realtime";

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
 * hangup - there is no speech in it, but it still costs a full audio-in ASR
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
 * 30s, 2m, 8m, 32m… capped at an hour - the same shape the CRM outbox uses.
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
 * than JSON null - `"null"`, `"not_discussed"`, `"N/A"`. Left alone these are
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
 * TRANSCRIBING, and the poller that picks the call up later - possibly in a
 * different process - has to advance and fail it by exactly the same rules.
 */
export function stageHelpers(
  client: PoolClient,
  callId: string,
  attempts: number,
  /**
   * The tenant, when the caller knows it - and every caller does. Optional only
   * because this signature is public and a fourth required parameter would be a
   * breaking change for no gain: without it the transition still happens, it is
   * simply not announced, and the console falls back to noticing on its next
   * poll. Pass it. A call moving from TRANSCRIBING to COMPLETE with nobody told
   * is exactly the case where somebody sits watching "Transcribing" for four
   * minutes after it finished.
   */
  orgId?: string,
): StageHelpers {
  const advance = async (from: string, to: string) => {
    const res = await client.query(
      "UPDATE calls SET status = $3 WHERE id = $1 AND status = $2 RETURNING id",
      [callId, from, to],
    );
    const moved = (res.rowCount ?? 0) > 0;
    // Only a transition that actually took is worth announcing. A lost race
    // means another worker owns this call and will announce its own.
    if (moved && orgId) announce(orgId, "call", "updated", callId);
    return moved;
  };

  /**
   * Record the failure AND schedule the next attempt, unless the call has
   * used up its budget. The status stays FAILED_* either way - the call
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
        // update inside the same statement - hence the +1 mirrored here.
        retryBackoffSeconds(attempts + 1),
      ],
    );

    if (orgId) announce(orgId, "call", "updated", callId);

    const used = row?.pipeline_attempts ?? attempts + 1;
    if (used < MAX_PIPELINE_ATTEMPTS) {
      console.error(
        `call ${callId} failed at ${stage} (attempt ${used}/${MAX_PIPELINE_ATTEMPTS}), ` +
          `retrying in ${retryBackoffSeconds(used)}s:`,
        err,
      );
    } else {
      console.error(`call ${callId} failed at ${stage} and gave up after ${used} attempt(s):`, err);
    }
  };

  return { advance, fail };
}

/**
 * Store an ASR result as this call's one transcript.
 *
 * Reprocess re-runs the ASR stage; replacing rather than appending keeps a call
 * to exactly one transcript (otherwise the drawer can show a stale duplicate).
 *
 * IT NO LONGER BILLS THE AUDIO. This used to write a second usage_event of kind
 * `asr_seconds` from the handset's `duration_s`, which `recordAsrUsage` now
 * supersedes (B0) - keeping both double-counted every call for anything summing
 * ASR usage. The replacement is strictly better on three counts, which is why
 * this is the one that went:
 *
 *   - it is written at SUBMIT, so a job the provider accepted, charged for and
 *     never returned is still on the ledger; this only ever fired once a
 *     transcript came back;
 *   - it records what was actually SENT, which after the silence trim (B2) and
 *     the duration cap (B3) is not the handset's duration; and
 *   - it carries the rate tier, so a historic row can be priced without
 *     guessing what the org's diarization setting was at the time.
 *
 * Nothing read `asr_seconds` - it was write-only from the day it was added.
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
}

/**
 * Everything after the transcript exists: analyze → crm-dispatch → COMPLETE.
 *
 * Entered from two places - the inline run, and the batch-ASR poller once the
 * provider hands back a transcript.
 *
 * The inline run arrives with the call still in TRANSCRIBING and lets this
 * function make the transition. The poller does NOT: it commits the transcript
 * and the ANALYZING advance in a transaction of their own first, so the console
 * can see the call move on rather than sitting on its last committed status for
 * the whole of analyze (asr-poll.ts). `alreadyAnalyzing` is how it says so -
 * without it the advance below finds the call already in ANALYZING, returns
 * false, and this function silently does nothing at all.
 */
/**
 * Put the ASR charge on the tenant's ledger (B0).
 *
 * ASR is ~82% of what a call costs to process, and until this existed NONE of
 * it was attributed: `usage_events` carried only `llm_tokens_in`/`out`, so the
 * cheapest line on the invoice was the only one any org could be billed for or
 * measured against. The schema anticipated it from the first migration - the
 * `kind` comment in 0001 lists `minutes` - it was simply never written.
 *
 * The two kinds are kept separate rather than folded into one `asr_minutes`
 * with a flag, because they are charged at different rates (₹30 against ₹45)
 * and a cost query that has to join back to the org's CURRENT setting to price
 * a historic row would misprice every call recorded before someone flipped it.
 * The rate tier belongs to the event, not to the org.
 *
 * A duration of 0 means the handset never reported one. Recording a 0 would be
 * a measurement claiming this call was free, which is worse than no row at all -
 * so it logs instead, and the gap is visible rather than silently understated.
 */
export async function recordAsrUsage(
  client: PoolClient,
  orgId: string,
  callId: string,
  durationS: number,
  diarized: boolean,
): Promise<void> {
  if (!(durationS > 0)) {
    console.warn(`call ${callId}: no duration reported - ASR usage not metered`);
    return;
  }
  await client.query(
    `INSERT INTO usage_events (org_id, kind, quantity, unit, ref_id)
     VALUES ($1, $2, $3, 'minutes', $4)`,
    [orgId, diarized ? "asr_minutes_diarized" : "asr_minutes", durationS / 60, callId],
  );
}

/**
 * The same state-machine helpers, each opening its own short transaction.
 *
 * `stageHelpers` binds to a caller's client, which was fine while one
 * transaction spanned the whole run. Now that the provider calls happen with no
 * connection held (A1), there is no ambient client for an `advance` or a `fail`
 * to ride on - and both are single statements, so a transaction of their own
 * costs one round trip and nothing else.
 *
 * It also fixes something the shared-client version got wrong by accident: a
 * `fail()` recorded inside a transaction that later rolled back went down with
 * it, losing the very error it existed to record. Here the failure commits on
 * its own, which is the only way it is any use to the retry sweep.
 */
export function orgStageHelpers(orgId: string, callId: string, attempts: number): StageHelpers {
  return {
    advance: (from, to) =>
      withOrgContext(orgId, (client) =>
        stageHelpers(client, callId, attempts, orgId).advance(from, to),
      ),
    fail: (stage, err) =>
      withOrgContext(orgId, (client) =>
        stageHelpers(client, callId, attempts, orgId).fail(stage, err),
      ),
  };
}

/** The transcript row both halves of analyze read from. */
interface TranscriptRow {
  text: string | null;
  segments: unknown;
  diarized: boolean | null;
}

/** The tenant's active extraction agent, if they have one. */
interface AgentRow {
  id: string;
  version: number;
  system_prompt: string;
  field_schema: unknown;
}

/**
 * The analyze and CRM stages, in three phases: read, compute, write.
 *
 * WHY THE PHASES EXIST (A1). This function used to receive one `client` and run
 * end to end inside the caller's `withOrgContext` - which is BEGIN ... COMMIT.
 * The provider calls in the middle take minutes, so every call in flight held an
 * open transaction, and a pooled connection, for essentially the whole of that
 * time while doing nothing but waiting on HTTP. At the ~190s a call spent here
 * that is 53 concurrent transactions to sustain 1,000 calls an hour, against a
 * DB_POOL_MAX of 10 - so the pool, not the provider, was the ceiling, and the
 * database spent its day holding snapshots open against vacuum for work that
 * was not touching it.
 *
 * Now: connections are opened around the writes and released across the waits.
 * Same statements, same order, roughly 2-3 seconds of held transaction per call
 * instead of 190.
 *
 * WHAT THE PHASING MUST NOT BREAK. The two write phases are deliberately NOT one
 * transaction. Intelligence is written before the extraction is awaited, so a
 * call whose extraction throws still keeps the summary and analytics that landed
 * before it - that is what a reader sees while the retry is pending, and folding
 * both into a single transaction would roll the summary back and quietly change
 * what a failing call looks like in the console.
 */
export async function runPostAsrStages(
  orgId: string,
  callId: string,
  { advance, fail }: StageHelpers,
  alreadyAnalyzing = false,
): Promise<void> {
  // ── analyze ──────────────────────────────────────────────────────────
  if (!alreadyAnalyzing && !(await advance("TRANSCRIBING", "ANALYZING"))) return;

  // ── phase 1: read ────────────────────────────────────────────────────
  //
  // Everything the provider calls need, in one short transaction that is
  // committed and released before the first of them is made. Read here rather
  // than threaded down from processCall: the batch-ASR path re-enters this
  // function from the poller, which never saw the org row.
  let vocabulary: string[] = [];
  let direction: string | null = null;
  let t: TranscriptRow | undefined;
  let agent: AgentRow | undefined;

  try {
    await withOrgContext(orgId, async (client) => {
      const {
        rows: [vocabRow],
      } = await client.query<{ vocabulary: string[] | null }>(
        "SELECT vocabulary FROM organizations WHERE id = $1",
        [orgId],
      );
      vocabulary = vocabRow?.vocabulary ?? [];

      // Who dialled. The recording comes off the telecaller's own handset, so
      // this is a genuine prior on which voice is the Agent - and the analyser's
      // role decision is the one thing a reader notices immediately when it is
      // wrong.
      const {
        rows: [dirRow],
      } = await client.query<{ direction: string | null }>(
        "SELECT direction FROM calls WHERE id = $1",
        [callId],
      );
      direction = dirRow?.direction ?? null;

      // ONE read for both halves of analyze. The extraction used to re-select
      // `text` further down; nothing between the two writes that column, so the
      // second read only existed because the two halves were written apart.
      const {
        rows: [transcriptRow],
      } = await client.query<TranscriptRow>(
        "SELECT text, segments, diarized FROM transcripts WHERE call_id = $1",
        [callId],
      );
      t = transcriptRow;

      const {
        rows: [agentRow],
      } = await client.query<AgentRow>(
        `SELECT a.id, a.version, a.system_prompt, a.field_schema FROM agents a
          JOIN calls c ON c.workspace_id = a.workspace_id
         WHERE c.id = $1 AND a.is_active = true
         ORDER BY a.version DESC LIMIT 1`,
        [callId],
      );
      agent = agentRow;
    });
  } catch (err) {
    await fail("ANALYZE", err);
    return;
  }

  try {
    /*
     * The tenant's extraction starts HERE, and is awaited far below.
     *
     * The two halves of analyze - conversation intelligence and the tenant's
     * own field extraction - share nothing. One reads the segments, the other
     * reads the flat text, neither reads the other's output, and both are pure
     * provider calls with no database access of their own. Run one after the
     * other they were simply two lots of ~95s; started together they are one.
     *
     * Started, not awaited. The await stays after the intelligence writes so
     * the ORDER of writes is exactly what it was: a call whose extraction
     * throws still keeps the summary and analytics that landed before it,
     * which is what a reader sees while the retry is pending.
     *
     * `.then(ok, err)` rather than a bare promise, and this is load-bearing: a
     * rejection sitting unhandled for the minutes intelligence takes is an
     * unhandledRejection, which this Node version turns into a process crash.
     * Settling it into a value keeps the rejection alive but handled, to be
     * re-thrown at the await where the outer catch can still turn it into
     * fail("ANALYZE") exactly as before.
     *
     * No transcript means the call was gated as too short, or ASR genuinely
     * heard nothing. Running the agent over that can only invent field values,
     * and it is billed either way - so skip it.
     */
    // Captured so both the closure and the write phase below see them NARROWED.
    // The ternary guards on `agent && t?.text`, but TypeScript carries that
    // narrowing neither across the async boundary nor down to a later block -
    // and the agent travels WITH the result for the same reason the schema
    // does, so the write phase never has to assert it is there.
    const activeAgent = agent;
    const transcriptText = t?.text ?? null;

    const extraction = (
      activeAgent && transcriptText
        ? (async () => {
            // The parsed schema travels WITH the result: the call_facts
            // projection below walks its fields, and it is parsed in here so a
            // malformed field_schema still surfaces at the await, where the
            // outer catch can fail the stage - not before intelligence has had
            // a chance to write.
            const schema = ExtractionSchema.parse(activeAgent.field_schema);
            const output = await analyzeTranscript(
              activeAgent.system_prompt,
              schema,
              transcriptText,
              vocabulary,
            );
            return { schema, output, agent: activeAgent };
          })()
        : Promise.resolve(null)
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // The extraction started before intelligence did; collect it now. A
    // rejection is re-thrown rather than logged, because unlike conversation
    // intelligence this half IS the call's purpose - the outer catch lands it
    // on FAILED_ANALYZE, exactly as when the call was made inline here.
    const settled = await extraction;
    if (!settled.ok) throw settled.error;
    const extracted = settled.value;

    if (extracted) {
      const { schema, output: result, agent: extractionAgent } = extracted;
      // ── write phase B: the tenant's extraction ────────────────────────
      //
      // A second short transaction, opened only once the extraction has been
      // collected. Deliberately not shared with write phase A above: a failure
      // in here must not roll back the intelligence that already landed.
      await withOrgContext(orgId, async (client) => {
        await client.query(
          `INSERT INTO ai_outputs
           (org_id, call_id, agent_id, agent_version, output, provider, model,
            tokens_in, tokens_out, validation_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            orgId,
            callId,
            extractionAgent.id,
            extractionAgent.version,
            JSON.stringify(result.output),
            result.provider,
            result.model,
            result.tokensIn,
            result.tokensOut,
            result.validationStatus,
          ],
        );
        await client.query(`UPDATE calls SET agent_id = $2, agent_version = $3 WHERE id = $1`, [
          callId,
          extractionAgent.id,
          extractionAgent.version,
        ]);

        // call_facts projection - consumer (c) of the single field definition
        if (result.validationStatus !== "failed") {
          /*
           * ONE statement for the whole projection, not one per field (A5).
           *
           * This was a loop issuing an INSERT per extracted field. Every one of
           * them is a full round trip, and the database is in Seoul while the
           * worker runs in Mumbai - ~125ms each, so a schema with ten fields spent
           * over a second here, inside the transaction, doing nothing but waiting
           * on the network. It is the same write either way; it just used to be
           * paid for ten times.
           *
           * The columns are built as parallel arrays and unnested server-side.
           * Order is what binds them: index i of each array describes the same
           * field, so nothing may push to one without pushing to all four.
           */
          const keys: string[] = [];
          const texts: Array<string | null> = [];
          const nums: Array<number | null> = [];
          const bools: Array<boolean | null> = [];

          for (const field of schema.fields) {
            const value = result.output[field.key];
            // Skipped, not written as NULL: a fact that was never established
            // should be missing from the projection entirely, so the CRM payload
            // omits the key rather than sending an empty one.
            if (isAbsent(value)) continue;
            keys.push(field.key);
            texts.push(
              field.type === "number" || field.type === "boolean"
                ? null
                : Array.isArray(value)
                  ? JSON.stringify(value)
                  : String(value),
            );
            nums.push(field.type === "number" ? (value as number) : null);
            bools.push(field.type === "boolean" ? (value as boolean) : null);
          }

          // A call where every field came back absent writes nothing at all -
          // unnest over four empty arrays is a no-op, but so is skipping the
          // round trip entirely.
          if (keys.length > 0) {
            await client.query(
              `INSERT INTO call_facts (org_id, call_id, field_key, value_text, value_num, value_bool)
             SELECT $1, $2, f.key, f.text, f.num, f.bool
               FROM unnest($3::text[], $4::text[], $5::numeric[], $6::boolean[])
                 AS f(key, text, num, bool)
             ON CONFLICT (call_id, field_key) DO UPDATE
               SET value_text = EXCLUDED.value_text,
                   value_num = EXCLUDED.value_num,
                   value_bool = EXCLUDED.value_bool`,
              [orgId, callId, keys, texts, nums, bools],
            );
          }
        }

        await client.query(
          `INSERT INTO usage_events (org_id, kind, quantity, unit, ref_id)
         VALUES ($1, 'llm_tokens_in', $2, 'tokens', $3), ($1, 'llm_tokens_out', $4, 'tokens', $3)`,
          [orgId, result.tokensIn, callId, result.tokensOut],
        );
      });
    }
  } catch (err) {
    await fail("ANALYZE", err);
    return;
  }

  // ── crm-dispatch ─────────────────────────────────────────────────────
  //
  // FAILED_CRM stays deliberately unreachable, and that is not an oversight -
  // read this before "finishing" it the way FAILED_TRANSCODE was finished.
  //
  // A delivery failure is not this call's outcome: the transcript, the facts
  // and the lead all exist and are correct, so the call is genuinely COMPLETE.
  // Dispatch already has its own durable retry - crm_sync_log holds the pending
  // send with its own attempts, backoff and terminal 'dead' state, drained by
  // drainOutbox and re-drivable from the console. Failing the call would put a
  // SECOND retry machine over the same work, and the two do not compose:
  // retryDueCalls rewinds a failed call and republishes it, so every CRM retry
  // would re-run analyze (paying that provider again) and re-enqueue dispatch -
  // turning one undelivered lead into duplicate rows in the customer's CRM,
  // which is not retractable. A3 made that rewind resume from the transcript
  // rather than the audio, so it no longer pays for ASR twice as well; the
  // duplicate delivery is the part that matters and it is unchanged.
  //
  // So what the status is FOR is the stage failing to RUN, not the delivery
  // failing: a worker killed while the call sits in SYNCING leaves work nothing
  // will ever finish, and `failStalledCalls` in retry.ts is the one caller that
  // lands FAILED_CRM. A delivery outcome never does.
  if (!(await advance("ANALYZING", "SYNCING"))) return;

  // ── write phase C: lead, CRM objects, dispatch ──────────────────────
  //
  // All local work with no provider call in it, so one transaction covers the
  // lot - the same shape it had before A1, just no longer sharing a connection
  // with the minutes of analyze that preceded it.
  await withOrgContext(orgId, async (client) => {
    // Lead projection first: it is a local write, so the owner's board is
    // populated even if the tenant has no CRM connected at all. Non-blocking
    // for the same reason dispatch is - a qualification bug must not strand
    // calls in SYNCING.
    //
    // Whether the call qualified is no longer tracked here: the CRM send that
    // used to read it now runs in the enrichment lane, and re-reads it from the
    // lead's own existence rather than carrying a flag across two lanes.
    let leadId: string | null = null;
    try {
      const lead = await upsertLead(client, orgId, callId);
      leadId = lead.leadId;
      console.log(
        lead.leadId
          ? `call ${callId}: lead ${lead.leadId} ${lead.reason}`
          : `call ${callId}: no lead - ${lead.reason}`,
      );
    } catch (err) {
      console.error(`call ${callId}: lead projection error (non-blocking):`, err);
    }

    // CRM Phase 1 foundation (E0.1): project the same lead onto the new
    // Contact/Deal object model, alongside `leads` - not instead of it. Its own
    // try/catch, strictly AFTER upsertLead and reading back what it wrote, so a
    // bug here can never affect whether the call reaches COMPLETE or whether
    // `leads`/crm-dispatch below run. The owner console's board/leads pages
    // still read `leads`, not contacts/deals, as their primary source (A6) -
    // this write is additive until that cutover happens.
    if (leadId) {
      try {
        // emitEvents: a live call is exactly what a "deal created" rule is
        // written for (doc 23, C1). The backfill replays history and leaves
        // it off.
        const projection = await projectLeadToCrm(client, orgId, leadId, { emitEvents: true });
        if (projection.reason === "no default pipeline for org") {
          // The projection itself now leaves the operator-visible audit row
          // (one per org per day), for every door rather than only this one.
          console.error(
            `call ${callId}: crm-object projection skipped - org ${orgId} has no active pipeline`,
          );
        } else {
          console.log(
            `call ${callId}: crm-object contact=${projection.contactId} deal=${projection.dealId} (${projection.reason})`,
          );
        }
      } catch (err) {
        console.error(`call ${callId}: crm-object projection error (non-blocking):`, err);
      }
    }

    // Risk-flag alerts and the CRM send both moved to the enrichment lane (A4).
    //
    // The alert because it is computed from the conversation read, which now
    // happens there. The SEND because the dispatch payload carries that read:
    // going out from here would push leads with empty summaries into a
    // customer's own CRM, and a delivered record cannot be recalled. Enrichment
    // releases it on any terminal outcome - see enrich.ts.
  });

  await advance("SYNCING", "COMPLETE");
  // The call made it through, so its failure history stops counting: a future
  // reprocess gets a full retry budget rather than inheriting attempts from a
  // problem that has already been resolved.
  await withOrgContext(orgId, async (client) => {
    await client.query(
      "UPDATE calls SET pipeline_attempts = 0, next_attempt_at = NULL WHERE id = $1",
      [callId],
    );
  });
  console.log(`call ${callId}: COMPLETE`);

  // The lead, the contact and the deal this call produced are committed and
  // visible as of the line above. The `call` topic was already announced by the
  // SYNCING -> COMPLETE advance; this is the second half of the same moment,
  // for the board and the pipeline panels rather than the call log.
  announce(orgId, "lead", "created", callId);

  // Hand the call to the enrichment lane (A4). Last, and deliberately outside
  // every transaction above: the lead is committed and visible by now, so a
  // broker that is down costs a summary and a delayed CRM send - both of which
  // `sweepEnrichment` recovers - rather than the lead itself.
  try {
    await publishEnrich({ callId, orgId });
  } catch (err) {
    console.error(`call ${callId}: enrich publish failed (sweep will retry):`, err);
  }
}

/**
 * Analyse one call whose transcript is already written (A2).
 *
 * The consumer half of `aura.analyze`. The ASR poller commits the transcript,
 * advances the call to ANALYZING and publishes; this picks it up, possibly in a
 * different process, and runs everything from analyze onwards.
 *
 * The status check is what makes a redelivery harmless. Every other stage claims
 * its work with an optimistic `advance(from, to)`, but this one starts from a
 * status the poller has ALREADY set, so there is no transition left to lose the
 * race on - a duplicate message would otherwise re-run both provider calls and
 * re-deliver the lead. Reading the status is that claim, and it comes back with
 * the attempt count in the same round trip.
 */
export async function analyzeCall({ callId, orgId }: PipelineMessage): Promise<void> {
  const state = await withOrgContext(orgId, async (client) => {
    const {
      rows: [row],
    } = await client.query<{ status: string; pipeline_attempts: number }>(
      "SELECT status, pipeline_attempts FROM calls WHERE id = $1",
      [callId],
    );
    return row;
  });
  if (!state) return;
  if (state.status !== "ANALYZING") {
    console.log(`call ${callId}: not in ANALYZING (${state.status}), skipping (idempotent replay)`);
    return;
  }
  const attempts = Number(state.pipeline_attempts ?? 0);
  await runPostAsrStages(orgId, callId, orgStageHelpers(orgId, callId, attempts), true);
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
  const attempts = await withOrgContext(orgId, (client) => priorAttempts(client, callId));
  const helpers = orgStageHelpers(orgId, callId, attempts);
  const { advance, fail } = helpers;

  /**
   * Transcription switched off for this instance (0014).
   *
   * Checked before the transcode advance so the call settles immediately
   * rather than walking the stages. Everything the console needs - the call
   * row, the number, the duration, the uploaded audio - already landed at
   * admission, so the customer's call log stays complete; only the paid
   * stages are skipped.
   *
   * Lead projection and CRM dispatch are skipped too. Both derive from the
   * analysis that did not run, so they would at best deliver an empty record
   * to the customer's real CRM - an outbound side effect nobody asked for and
   * which cannot be recalled.
   */
  const orgRow = await withOrgContext(orgId, async (client) => {
    const {
      rows: [row],
    } = await client.query<{
      transcription_enabled: boolean;
      asr_language: string | null;
      asr_mode: string | null;
      asr_diarization: boolean;
      asr_max_seconds: number | null;
      min_transcribe_seconds: number | null;
      asr_monthly_minutes_budget: number | null;
    }>(
      `SELECT transcription_enabled, asr_language, asr_mode, asr_diarization,
                asr_max_seconds, min_transcribe_seconds, asr_monthly_minutes_budget
           FROM organizations WHERE id = $1`,
      [orgId],
    );
    return row;
  });
  if (orgRow && orgRow.transcription_enabled === false) {
    if (await advance("UPLOADED", "TRANSCRIPTION_OFF")) {
      await withOrgContext(orgId, async (client) => {
        await client.query(
          "UPDATE calls SET error_message = NULL, next_attempt_at = NULL, pipeline_attempts = 0 WHERE id = $1",
          [callId],
        );
      });
      console.log(
        `call ${callId}: transcription disabled for this instance - stored, not transcribed`,
      );
    }
    return;
  }

  /**
   * The instance's monthly ASR ceiling (0086, B5).
   *
   * Checked in the same place and with the same outcome as the transcription
   * toggle above, because it IS the same outcome: the call is stored and listed
   * in full, and only the paid stages are skipped. The reason goes to
   * error_message so an operator can tell this apart from an instance that has
   * transcription switched off on purpose - and so the call can simply be
   * reprocessed next month, or once the ceiling is raised.
   *
   * Only queried for instances that actually set a ceiling: this is an
   * aggregate on the hot path of every call, and the overwhelming majority of
   * instances have no budget and should pay nothing for the feature.
   */
  if (orgRow?.asr_monthly_minutes_budget != null) {
    const used = await withOrgContext(orgId, async (client) => {
      const {
        rows: [usage],
      } = await client.query<{ minutes: string }>(
        `SELECT COALESCE(sum(quantity), 0)::text AS minutes
           FROM usage_events
          WHERE org_id = $1
            AND kind IN ('asr_minutes', 'asr_minutes_diarized')
            AND occurred_at >= date_trunc('month', now())`,
        [orgId],
      );
      return Number(usage?.minutes ?? 0);
    });

    if (used >= orgRow.asr_monthly_minutes_budget) {
      if (await advance("UPLOADED", "TRANSCRIPTION_OFF")) {
        const budget = orgRow.asr_monthly_minutes_budget;
        await withOrgContext(orgId, async (client) => {
          await client.query(
            `UPDATE calls
                SET error_message = $2, next_attempt_at = NULL, pipeline_attempts = 0
              WHERE id = $1`,
            [callId, `monthly ASR budget reached (${Math.round(used)}/${budget} minutes)`],
          );
          // One audit row per org per day, not per call - at the ceiling EVERY
          // call takes this path, and an operator needs to know the instance
          // stopped transcribing, not read it a thousand times.
          await client.query(
            `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, meta)
             SELECT $1, 'system', 'pipeline', 'asr.budget_exhausted', 'organization', $2::jsonb
              WHERE NOT EXISTS (
                SELECT 1 FROM audit_log
                 WHERE org_id = $1 AND action = 'asr.budget_exhausted'
                   AND created_at > now() - interval '24 hours'
              )`,
            [orgId, JSON.stringify({ usedMinutes: Math.round(used), budget })],
          );
        });
        console.warn(
          `call ${callId}: org ${orgId} has used ${Math.round(used)} of its ${budget} ` +
            "monthly ASR minutes - stored, not transcribed",
        );
      }
      return;
    }
  }

  // ── transcode ────────────────────────────────────────────────────────
  if (!(await advance("UPLOADED", "TRANSCODING"))) {
    console.log(`call ${callId}: not in UPLOADED, skipping (idempotent replay)`);
    return;
  }

  /**
   * The claim above stays OUTSIDE the try on purpose: until it returns true
   * this run does not own the call, and stamping a status onto a row another
   * worker is holding would fail its work, not ours.
   *
   * Everything the stage actually does goes inside. It is a pass-through
   * today so nothing in it throws - but ffmpeg and envelope-decrypt (§2.3)
   * are precisely the kind of code that does, and without this catch a throw
   * escapes processCall entirely: no error_message, no attempt increment, no
   * next_attempt_at. The call then strands in TRANSCODING, where neither
   * sweeper in retry.ts looks (`FAILED_%` due, and `UPLOADED`) - silent,
   * permanent loss of a recording the customer already paid to store.
   * Routing through the same fail() every other stage uses makes a transcode
   * failure behave identically to an ASR one, and is what makes the
   * long-declared FAILED_TRANSCODE status reachable at all.
   */
  try {
    // TODO (checklist §2.3): ffmpeg → 16 kHz mono Opus + device-envelope
    // decrypt. The client already records 16 kHz mono AAC, so pass-through
    // is acceptable until encryption-at-rest lands.

    // A retry starts clean: leaving the previous reason attached would make a
    // call that later completes still read as broken in the drawer. The pending
    // retry is cleared too - this run IS that retry, and leaving the timestamp
    // set would let the sweeper claim the call again while it is mid-flight.
    // Any ASR job from a previous run goes with it: this run submits its own,
    // and a stale id would have the poller waiting on the wrong job.
    await withOrgContext(orgId, async (client) => {
      await client.query(
        `UPDATE calls
              SET error_message = NULL, next_attempt_at = NULL,
                  asr_job_id = NULL, asr_job_started_at = NULL
            WHERE id = $1`,
        [callId],
      );
    });
  } catch (err) {
    await fail("TRANSCODE", err);
    return;
  }

  // ── asr ──────────────────────────────────────────────────────────────
  if (!(await advance("TRANSCODING", "TRANSCRIBING"))) return;

  // The duration read is INSIDE the try with the rest of the stage: it runs
  // after the call is already in TRANSCRIBING, so a blip on that one query
  // used to throw straight out of processCall and strand the call in a state
  // no sweeper claimed. It is an ASR-stage failure like any other.
  try {
    // A duration of 0 means the device never reported one, not that the call
    // was empty - those still go through ASR rather than being dropped on a
    // missing field.
    // Both reads in one statement and one short transaction, committed before
    // the audio is fetched and the provider is called. They used to be two
    // round trips on a connection that then stayed open for the whole of ASR.
    const {
      rows: [row],
    } = await withOrgContext(orgId, (client) =>
      client.query<{ duration_s: number | null; s3_key: string | null }>(
        `SELECT c.duration_s, r.s3_key
             FROM calls c LEFT JOIN recordings r ON r.call_id = c.id
            WHERE c.id = $1`,
        [callId],
      ),
    );
    const durationS = Number(row?.duration_s ?? 0);
    // The instance's own floor wins over the deployment's (B4). A telecalling
    // floor knows how long its ring-outs and wrong numbers actually run; five
    // seconds only ever catches an instant hangup.
    const floorS = orgRow?.min_transcribe_seconds ?? MIN_TRANSCRIBE_SECONDS;
    const tooShort = durationS > 0 && durationS < floorS;

    if (tooShort) {
      console.log(
        `call ${callId}: ${durationS}s is under the ${floorS}s floor - skipping ASR + analyze`,
      );
    } else {
      if (!row?.s3_key) throw new Error("no recording for call");
      const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: row.s3_key }));
      const original = Buffer.from(await object.Body!.transformToByteArray());

      // Strip the silence and cap the length before anyone is billed for it
      // (B2/B3). Never throws and never fails a call - a deployment without
      // ffmpeg gets the original buffer back and simply pays more.
      const prepared = await prepareAudioForAsr(original, callId, orgRow?.asr_max_seconds ?? null);
      const audio = prepared.audio;
      // Meter what was actually SUBMITTED, not what the handset recorded: the
      // provider bills for the audio it receives, so once it has been trimmed
      // those are different numbers and only one of them is the invoice.
      const billableS = prepared.seconds ?? durationS;
      if (prepared.seconds !== null) {
        console.log(`call ${callId}: audio prep ${prepared.reason}`);
      }

      if (sarvamAsrConfigured()) {
        // Batch provider: hand over the audio, record the job, and stop.
        // The call stays in TRANSCRIBING - which is exactly true - and the
        // poller drives it from here. Committing the job id before returning
        // is what makes this survive a worker restart: the provider is
        // already transcribing (and billing) this audio, so losing the id
        // would mean paying twice.
        const diarize = orgRow?.asr_diarization === true;
        const jobId = await startSarvamAsrJob(audio, callId, {
          language: orgRow?.asr_language,
          mode: orgRow?.asr_mode,
          diarize,
        });
        await withOrgContext(orgId, async (client) => {
          await client.query(
            "UPDATE calls SET asr_job_id = $2, asr_job_started_at = now() WHERE id = $1",
            [callId, jobId],
          );
          // Metered here rather than on collection: the provider bills for
          // audio it has ACCEPTED, so a job that is submitted and then never
          // collected still cost money and still belongs on the ledger.
          await recordAsrUsage(client, orgId, callId, billableS, diarize);
        });
        console.log(
          `call ${callId}: submitted to ${process.env.SARVAM_STT_MODEL ?? "saaras:v3"} ` +
            `[${orgRow?.asr_language ?? process.env.SARVAM_STT_LANGUAGE ?? "unknown"}/` +
            `${orgRow?.asr_mode ?? process.env.SARVAM_STT_MODE ?? "transcribe"}/` +
            `${diarize ? "diarized" : "plain"}] (job ${jobId})`,
        );
        return;
      }

      const result = await transcribe(audio, "audio/mp4");
      await withOrgContext(orgId, async (client) => {
        await persistTranscript(client, orgId, callId, result);
        // The inline provider diarizes as part of the same request rather
        // than as a priced add-on, so it is metered on the plain tier.
        await recordAsrUsage(client, orgId, callId, billableS, false);
      });
    }
  } catch (err) {
    await fail("ASR", err);
    return;
  }

  await runPostAsrStages(orgId, callId, helpers);
}
