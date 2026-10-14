import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getAdminPool, readEffectiveLimits, type PoolClient, withOrgContext } from "@aura/db";
import { analyzeTranscript } from "@aura/llm";
import { type PipelineMessage, publishEnrich } from "@aura/queue";
import {
  callIssueRef,
  type ClassifiedFailure,
  classifyFailure,
  ExtractionSchema,
  PLATFORM_REASON_SEVERITY,
  type PlatformFailureReason,
  QUOTA_WARN_AT,
  readQuota,
} from "@aura/shared";
import { recordReprocessOutcome } from "./call-issue-followup";
import { escalatePlatformFailure } from "./platform-escalation";
import { type AsrResult, transcribe } from "./asr";
import {
  type AsrProvider,
  chooseAsrProvider,
  describeProvider,
  parkDurationFor,
  parkProvider,
  recordProviderSuccess,
} from "./asr-route";
import { startSarvamAsrJob } from "./asr-sarvam";
import { prepareAudioForAsr } from "./audio-prep";
import { analyseDeadAirInBackground } from "./dead-air";
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

export interface FailContext {
  /**
   * The ASR provider this stage was talking to, when it was talking to one.
   *
   * This is what lets `fail()` tell "the vendor refused us" from "this call
   * went wrong": a failure with a provider attached and a vendor-level reason
   * parks the VENDOR and does NOT spend the call's retry budget (doc 49 P1-A).
   * Omit it and the failure behaves exactly as it always did.
   */
  provider?: AsrProvider;
}

export interface StageHelpers {
  /** Optimistic status transition; false means someone else already moved it. */
  advance(from: string, to: string): Promise<boolean>;
  /** Record the failure and schedule the next attempt (or give up). */
  fail(stage: string, err: unknown, ctx?: FailContext): Promise<void>;
  /**
   * Record a failure that is a PROVIDER's and schedule a retry for `retryAt`,
   * without spending one of the call's attempts.
   *
   * Used when no provider is usable at all - every one configured is parked -
   * so the stage never ran and there is nothing about this call to retry
   * differently. "All of our vendors are refusing us" is not a defect in this
   * recording and must not consume the budget that exists to decide whether
   * this recording is defective.
   */
  defer(
    stage: string,
    reason: PlatformFailureReason,
    operatorDetail: string,
    retryAt: Date,
  ): Promise<void>;
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
  /**
   * Record a failure, decide whether it spends an attempt, and schedule the
   * retry. The one SQL statement both `fail` and `defer` go through.
   *
   * `spend = false` is doc 49 P1-A's central correction: a provider-level error
   * must not consume the CALL's retry budget. For 62 days it did - a vendor
   * with an empty wallet burned all five attempts of 2,792 calls on a
   * 30s/2m/8m/32m backoff and landed every one of them in FAILED_ASR
   * permanently. The retry budget exists to decide whether THIS RECORDING is
   * the problem; a 402 from a vendor is not evidence about this recording.
   *
   * The status still becomes FAILED_* either way, which is the truth: the call
   * really has not been transcribed right now. `next_attempt_at` is what
   * distinguishes "we will try again shortly" from "this needs a person", and
   * `failure_class = 'platform'` is what makes the console say "Processing
   * delayed - nothing is wrong with the call or the recording" rather than
   * blaming the customer's handset (migration 0201).
   */
  const record = async (
    stage: string,
    errText: string,
    classified: ClassifiedFailure,
    opts: { spend: boolean; retryAt: Date | null },
  ): Promise<number> => {
    const {
      rows: [row],
    } = await client.query<{ pipeline_attempts: number }>(
      `UPDATE calls
          SET status = $2,
              error_message = $3,
              failure_class = $6,
              failure_reason_code = $7,
              pipeline_attempts = pipeline_attempts + CASE WHEN $8 THEN 1 ELSE 0 END,
              asr_job_id = NULL,
              asr_job_started_at = NULL,
              next_attempt_at = CASE
                -- An explicit retry time (a parked provider's expiry, or "now"
                -- because another provider is usable) always wins: it is a
                -- scheduling fact, not a backoff guess.
                WHEN $9::timestamptz IS NOT NULL THEN $9::timestamptz
                WHEN pipeline_attempts + CASE WHEN $8 THEN 1 ELSE 0 END < $4
                THEN now() + make_interval(secs => $5)
                ELSE NULL
              END
        WHERE id = $1
      RETURNING pipeline_attempts`,
      [
        callId,
        `FAILED_${stage}`,
        errText,
        MAX_PIPELINE_ATTEMPTS,
        // Computed from the attempt this failure becomes, read before the
        // update inside the same statement - hence the +1 mirrored here.
        retryBackoffSeconds(attempts + 1),
        classified.failureClass,
        classified.reason,
        opts.spend,
        opts.retryAt,
      ],
    );
    if (orgId) announce(orgId, "call", "updated", callId);
    return row?.pipeline_attempts ?? attempts + (opts.spend ? 1 : 0);
  };

  const fail = async (stage: string, err: unknown, ctx?: FailContext) => {
    // WHOSE FAULT, decided once, here (migration 0201). `error_message` keeps
    // the raw vendor text for us; `failure_class` is what every client-facing
    // surface reads instead of guessing from the status.
    //
    // Why it has to happen in `fail` and not at the call sites: there are
    // eleven of them across this file and `asr-poll.ts`, and the one that was
    // missed would be the one that tells a customer their recording is
    // unreadable because our vendor's wallet is empty. One funnel, one verdict.
    const classified = classifyFailure(stage, err);

    // ── IS THIS THE VENDOR'S FAULT, AND IS IT NOW PARKED? ─────────────────
    //
    // Only when the caller named the provider it was talking to. A failure with
    // no provider attached cannot be a provider's fault, and guessing would
    // park a vendor over our own storage being down - taking ASR offline for
    // six hours for a problem the vendor did not have.
    let spend = true;
    let retryAt: Date | null = null;
    const parkSeconds = ctx?.provider ? parkDurationFor(classified) : null;
    if (ctx?.provider && parkSeconds !== null) {
      await parkProvider(
        client,
        ctx.provider,
        classified.reason!,
        classified.operatorSummary,
        new Date(Date.now() + parkSeconds * 1000),
      );
      spend = false;
      // Ask the router AFTER the park, so the answer accounts for it. Another
      // provider usable → retry immediately and this call transcribes on its
      // next attempt instead of dying on its last. Nothing usable → wait for
      // the earliest park to expire rather than hammering on a backoff.
      //
      // "Immediately" means the next tick of the retry sweeper, 30s by default
      // (PIPELINE_RETRY_INTERVAL_MS). That sweep is the only thing that may
      // move a call out of FAILED_*; publishing from here instead would race
      // it and risk the call being processed twice.
      const route = await chooseAsrProvider(client);
      retryAt = route.kind === "provider" ? new Date() : (route.retryAfter ?? new Date());
      console.error(
        `asr: parked ${ctx.provider} for ${parkSeconds}s [${classified.reason}] - ` +
          (route.kind === "provider"
            ? `routing to ${route.provider}`
            : "no usable ASR provider, deferring work"),
      );
    }

    const used = await record(stage, reasonOf(err), classified, { spend, retryAt });

    // ── ESCALATE, ONCE PER INCIDENT ────────────────────────────────────────
    //
    // Two triggers, and the second one only exists because of the park above.
    //
    // 1. THE LAST ATTEMPT. A vendor blip that clears on retry 2 is not
    //    something a human needs to read about - the retry machine already
    //    handled it, and a queue full of self-healed blips is a queue nobody
    //    opens. A failure that has exhausted its budget is, by definition, one
    //    the machine could not fix.
    //
    // 2. A BLOCKING REASON THAT JUST PARKED A VENDOR. P1-A's whole point is
    //    that a provider-level failure no longer spends the retry budget - so
    //    on its own, trigger 1 would mean the exact incident this machinery was
    //    built for (62 days of HTTP 402) never escalates at all, because no call
    //    ever reaches attempt five. Fixing the hammering without this would have
    //    traded a loud wrong answer for a silent one.
    //
    //    `PLATFORM_REASON_SEVERITY` already draws the line in the right place.
    //    'blocking' means the reason does not degrade - no credit, no
    //    credentials, no provider configured, storage down - and every call
    //    through the stage fails until a human acts. A rate limit or a 5xx is
    //    'minor'/'wrong': the park alone handles those, and they escalate only
    //    if they persist long enough to exhaust a call's attempts.
    //
    // The de-duplication that keeps 2,792 failing calls to ONE ticket lives in
    // the unique index, not here (see platform-escalation.ts), so a trigger
    // firing on the first occurrence costs one row rather than thousands.
    //
    // Wrapped, and deliberately swallowed: escalation is telemetry about a
    // failure, and telemetry that can turn a handled failure into an unhandled
    // throw is worse than no telemetry. The call is already marked failed and
    // the raw reason is already stored before this runs.
    const blockingPark =
      !spend &&
      classified.reason !== null &&
      PLATFORM_REASON_SEVERITY[classified.reason] === "blocking";
    if (
      orgId &&
      classified.failureClass === "platform" &&
      (used >= MAX_PIPELINE_ATTEMPTS || blockingPark)
    ) {
      try {
        const outcome = await escalatePlatformFailure(client, {
          orgId,
          callId,
          stage,
          classified,
        });
        if (outcome.ref !== null) {
          console.error(
            `call ${callId}: platform failure at ${stage} [${classified.reason}] ` +
              `${outcome.action} ticket ${callIssueRef(outcome.ref)} ` +
              `(${outcome.occurrences} occurrence(s)): ${classified.operatorSummary}`,
          );
        }
      } catch (escalationErr) {
        console.error(`call ${callId}: could not raise an escalation ticket:`, escalationErr);
      }
    }

    if (!spend) {
      console.error(
        `call ${callId} failed at ${stage} on a provider fault - attempt ${used} NOT spent, ` +
          `retrying at ${retryAt?.toISOString() ?? "the next backoff"}:`,
        err,
      );
    } else if (used < MAX_PIPELINE_ATTEMPTS) {
      console.error(
        `call ${callId} failed at ${stage} (attempt ${used}/${MAX_PIPELINE_ATTEMPTS}), ` +
          `retrying in ${retryBackoffSeconds(used)}s:`,
        err,
      );
    } else {
      console.error(`call ${callId} failed at ${stage} and gave up after ${used} attempt(s):`, err);
    }
  };

  /**
   * No provider was usable, so the stage never ran.
   *
   * This is NOT `fail()` with a nicer message. Nothing about this call was
   * tried, so there is nothing about it to learn from a retry and no reason to
   * spend one of its attempts - and the client's row must read "processing
   * delayed", which `failure_class = 'platform'` is what produces. A deployment
   * with both vendors parked for six hours is an operations problem, and 900
   * calls sitting at FAILED_ASR with four attempts burned would turn it into a
   * data problem as well.
   *
   * It escalates on the same terms `fail()` does, because "no ASR provider is
   * usable" is the single most blocking thing this pipeline can say.
   */
  const defer = async (
    stage: string,
    reason: PlatformFailureReason,
    operatorDetail: string,
    retryAt: Date,
  ) => {
    const classified: ClassifiedFailure = {
      failureClass: "platform",
      reason,
      operatorSummary: operatorDetail,
      // The same sentence `classifyFailure` gives every platform failure. Not
      // re-worded here: one wording, one place, or the two drift and the
      // client-facing copy stops being reviewable in one file.
      clientSummary: classifyFailure(stage, new Error("platform")).clientSummary,
      retryable: true,
    };
    await record(stage, operatorDetail, classified, { spend: false, retryAt });
    console.error(
      `call ${callId}: deferred at ${stage} [${reason}] until ${retryAt.toISOString()} - ` +
        operatorDetail,
    );
    if (orgId && PLATFORM_REASON_SEVERITY[reason] === "blocking") {
      try {
        await escalatePlatformFailure(client, { orgId, callId, stage, classified });
      } catch (escalationErr) {
        console.error(`call ${callId}: could not raise an escalation ticket:`, escalationErr);
      }
    }
  };

  return { advance, fail, defer };
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
    fail: (stage, err, ctx) =>
      withOrgContext(orgId, (client) =>
        stageHelpers(client, callId, attempts, orgId).fail(stage, err, ctx),
      ),
    defer: (stage, reason, detail, retryAt) =>
      withOrgContext(orgId, (client) =>
        stageHelpers(client, callId, attempts, orgId).defer(stage, reason, detail, retryAt),
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

      // `kind = 'call_extractor'` is load-bearing since 0121: a workspace can
      // now hold a chat qualifier or reply drafter too, and without the filter
      // an active drafter's empty field list would "extract" every call into
      // nothing - no facts, no lead, and no error. The unique index on
      // (workspace_id) for active extractors makes the LIMIT a formality.
      const {
        rows: [agentRow],
      } = await client.query<AgentRow>(
        `SELECT a.id, a.version, a.system_prompt, a.field_schema FROM agents a
          JOIN calls c ON c.workspace_id = a.workspace_id
         WHERE c.id = $1 AND a.is_active = true AND a.kind = 'call_extractor'
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
            `call ${callId}: crm-object projection skipped - org ${orgId} has no default pipeline`,
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

  /*
   * Tell any open escalation ticket how its re-run turned out (0147, doc 36).
   *
   * Swallowed on failure, like the enrich publish below and for the same reason:
   * the call is COMPLETE as of the line above, and a support ticket that never
   * learns the outcome is cosmetic beside a call that failed to finish because a
   * ticket write threw. It is also a no-op for the overwhelming majority of
   * calls - one indexed lookup that finds nothing.
   */
  try {
    await recordReprocessOutcome(orgId, callId);
  } catch (err) {
    console.error(`call ${callId}: recording the re-run outcome failed:`, err);
  }

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

  /*
   * Offer the call to the TRANSCRIPT AGENT (Build docs/transcript-agent-build-
   * plan §4). Last, non-blocking, and swallowed on failure - the same contract
   * `publishEnrich` above has, for the same three reasons.
   *
   * ── THE GATE IS INSIDE `handOffToAgent`, NOT HERE ─────────────────────────
   *
   * §4's MUST is that the gate is resolved BEFORE ANY PROCESSING, and §19 turns
   * that into "for a disabled user, assert zero model calls and zero metered
   * usage". A check here would be a second place that reads the gate, which
   * §3A.4 forbids outright ("no code reads flags directly"). So the ingest step
   * owns it: for a telecaller whose owner has not switched the assistant on,
   * `ingestTranscript` writes one row marked `skipped_feature_off` and returns.
   *
   * ── WHY THE AGENT DOES NOT BLOCK `COMPLETE` ───────────────────────────────
   *
   * The call is COMPLETE as of the advance above: the transcript, the facts and
   * the lead all exist and are correct. A failure in the agent costs a
   * suggestion, not a lead - and `sweepAgentRuns` finds any transcript whose
   * run never started. Letting it fail the call would put a second retry
   * machine over work that already has one, which is the mistake FAILED_CRM's
   * comment above exists to prevent.
   */
  try {
    await handOffToAgent(orgId, callId);
  } catch (err) {
    console.error(`call ${callId}: transcript agent hand-off failed (sweep will retry):`, err);
  }
}

/**
 * Ingest this call's transcript for the agent, and run it if the gate allows.
 *
 * Imported LAZILY, inside the function. Two reasons, and the second is the one
 * that matters: the agent's module graph pulls in `@aura/llm`'s understanding
 * step and the whole policy layer, and a top-level import would load all of it
 * into every worker process at boot - including one that only drains exports.
 * The first is that it keeps this file's import list about the ASR pipeline.
 */
async function handOffToAgent(orgId: string, callId: string): Promise<void> {
  const [{ ingestTranscript }, { runAgent }] = await Promise.all([
    import("./agent/ingest"),
    import("./agent/runner"),
  ]);

  const transcript = await withOrgContext(orgId, async (client) => {
    const {
      rows: [row],
    } = await client.query<{
      text: string | null;
      language: string | null;
      engine: string | null;
      confidence: number | null;
      diarized: boolean | null;
      direction: string | null;
      started_at: Date | null;
      ended_at: Date | null;
      duration_s: number | null;
      lead_id: string | null;
    }>(
      `SELECT t.text, t.language, t.engine, t.confidence, t.diarized,
              c.direction, c.started_at, c.ended_at, c.duration_s,
              (SELECT l.id FROM leads l
                WHERE l.last_call_id = c.id OR l.first_call_id = c.id
                ORDER BY (l.last_call_id = c.id) DESC
                LIMIT 1) AS lead_id
         FROM calls c
         LEFT JOIN transcripts t ON t.call_id = c.id
        WHERE c.id = $1`,
      [callId],
    );
    return row;
  });

  if (!transcript) return;

  const ingested = await ingestTranscript({
    orgId,
    callId,
    // 'handset', because that is where this pipeline's calls come from. A
    // telephony webhook would pass its own provider name and its own
    // `externalCallId`, which is what §4's idempotency key is keyed on.
    source: "handset",
    externalCallId: callId,
    text: transcript.text,
    diarized: Boolean(transcript.diarized),
    language: transcript.language,
    sttProvider: transcript.engine,
    sttConfidence: transcript.confidence,
    leadId: transcript.lead_id,
    direction: transcript.direction,
    startedAt: transcript.started_at,
    endedAt: transcript.ended_at,
    durationSec: transcript.duration_s,
  });

  // Only a `ready` outcome has a run to make. `skipped_feature_off`,
  // `no_conversation` and `duplicate` are all terminal and all cost nothing -
  // which is §19's no-cost proof, held by this branch.
  if (ingested.kind !== "ready") {
    console.log(`call ${callId}: agent ${ingested.kind}`);
    return;
  }

  const outcome = await runAgent({ orgId, transcriptId: ingested.transcriptId });
  console.log(
    `call ${callId}: agent run ${outcome.status} - ` +
      `${outcome.executed} done, ${outcome.pendingReview} for review, ${outcome.blocked} blocked`,
  );
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
 * Tell the owners their transcription hours are running out (0197).
 *
 * ── THE SAME SHAPE AS THE STORAGE WARNING, DELIBERATELY ─────────────────────
 *
 * `storage-usage.ts` already warns owners at 80% and 100% of their storage
 * quota, once per threshold, through a `dedupe_key` that carries the threshold
 * and the day. This is the hours meter's half of the published "what happens
 * at each limit" table, and copying that shape is the point: two meters that
 * warn in two different ways are two things an owner has to learn.
 *
 * ── WHY IT IS FIRE-AND-FORGET ───────────────────────────────────────────────
 *
 * The caller does not await it. This runs on the hot path of every call once a
 * tenant is past 80%, and the thing it must never do is delay or fail a
 * recording: a notification that did not send is a nuisance, a call that did
 * not transcribe because the bell failed is a refund. The caller catches and
 * logs instead.
 *
 * ── AND WHY THE BODY DOES NOT READ LIKE AN ERROR ────────────────────────────
 *
 * Because nothing is wrong. At the ceiling the call is still recorded, stored,
 * listed and playable; only transcription and analysis are skipped, and the
 * call is left in TRANSCRIPTION_OFF, which is REPROCESSABLE - so a top-up or
 * the next month's reset picks it up and transcribes it after the fact.
 * Nothing is lost by running out of hours except time, and an owner told
 * "transcription failed" opens a support ticket about a product that is
 * working as sold.
 */
async function warnOwnersAboutHours(
  orgId: string,
  limitMinutes: number,
  usedMinutes: number,
): Promise<void> {
  // 100 before 80, so a tenant that jumped both in one call is told the one
  // that matters. `Math.floor` on the fraction would read 0.999 as 0.
  const level = usedMinutes >= limitMinutes ? 100 : usedMinutes / limitMinutes >= QUOTA_WARN_AT ? 80 : null;
  if (level === null) return;

  const usedHours = Math.round(usedMinutes / 60);
  const limitHours = Math.round(limitMinutes / 60);
  const title =
    level === 100
      ? `Transcription hours used up: ${usedHours} of ${limitHours}`
      : `Transcription is ${level}% used: ${usedHours} of ${limitHours} hours`;

  const { rowCount } = await getAdminPool().query(
    `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
     SELECT m.org_id, m.user_id, 'transcription_quota', $2, $3, '/owner/account/plan',
            'transcription_quota:' || $4 || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
       FROM memberships m
      -- Owners only - the persona that talks to the account manager. COALESCE
      -- because a null persona IS the owner persona (resolveOwnerRole, 0153),
      -- and the operator console's member writer never sets that column.
      WHERE m.org_id = $1 AND COALESCE(m.owner_role, 'owner') = 'owner' AND m.status = 'active'
     -- The dedupe key carries the threshold and the MONTH, not the day: an org
     -- sitting at 85% hears about it once for the month rather than once a day,
     -- and the next month's reset earns a fresh warning because the key moves.
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [
      orgId,
      title,
      level === 100
        ? "Calls are still being recorded and kept - only transcription and analysis are paused, " +
          "and they will be picked up automatically after a top-up or on the 1st. Add hours from your plan page."
        : "Calls are transcribing normally. Add hours from your plan page if you expect to go over.",
      String(level),
    ],
  );
  if ((rowCount ?? 0) > 0) announce(orgId, "notification", "created");
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
  // ── THE EFFECTIVE CEILING: THE PLAN, PLUS WHAT THEY TOPPED UP ─────────────
  //
  // Since 0197 the ceiling is no longer only `asr_monthly_minutes_budget`. A
  // capture plan includes a number of hours (100 on Starter, 200 on Growth),
  // and an hour pack bought this month adds to it. `readEffectiveLimits`
  // resolves all of that - the plan's entitlement, the grants ledger for THIS
  // UTC month, and the operator's hand-set column, which still wins when it is
  // set because that is how a negotiated Enterprise hour count is expressed.
  //
  // It is resolved HERE, at read time, rather than written into a column at
  // purchase time. A column holding "the ceiling including this month's
  // top-ups" would be stale on the first of every month and would need a sweep
  // to correct it - a sweep that, if it were ever late, would hand a customer
  // either hours they had not bought or a refusal after they had paid. This
  // cannot be late.
  //
  // The admin pool, because `plans` and `plan_entitlements` are revoked from
  // `aura_app`: a statement inside `withOrgContext` may not join them.
  const planLimits = await readEffectiveLimits(getAdminPool(), orgId);

  if (planLimits.transcriptionMinutes != null) {
    const used = await withOrgContext(orgId, async (client) => {
      const {
        rows: [usage],
      } = await client.query<{ minutes: string }>(
        `SELECT COALESCE(sum(quantity), 0)::text AS minutes
           FROM usage_events
          WHERE org_id = $1
            AND kind IN ('asr_minutes', 'asr_minutes_diarized')
            -- The platform's UTC month, said explicitly: withOrgContext now runs
            -- on the org's clock (Build docs/30), and the budget month is a
            -- billing contract, not a reporting view. plan-usage.controller.ts
            -- and the owner's billing overview read the same window.
            --
            -- It is a KNOWN divergence from the customer's own calendar: a
            -- floor in Dubai sees its allowance reset partway through their
            -- evening, and a contract starting on the 15th still resets on the
            -- 1st. The price list says "per calendar month" and means it;
            -- aligning the window to the billing date is an open decision, not
            -- something half-done here.
            AND occurred_at >= date_trunc('month', now(), 'UTC')`,
        [orgId],
      );
      return Number(usage?.minutes ?? 0);
    });

    // One reading, shared with the warning below, so the bell and the refusal
    // cannot disagree about where 80% and 100% are.
    const reading = readQuota(planLimits.transcriptionMinutes, used);
    if (reading.state === "warning" || reading.state === "grace" || reading.state === "blocked") {
      void warnOwnersAboutHours(orgId, planLimits.transcriptionMinutes, used).catch((err) =>
        console.error(`call ${callId}: transcription quota warning for org ${orgId}:`, err),
      );
    }

    if (used >= planLimits.transcriptionMinutes) {
      if (await advance("UPLOADED", "TRANSCRIPTION_OFF")) {
        const budget = planLimits.transcriptionMinutes;
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

  /**
   * Which provider this run talked to, hoisted so the `catch` can name it.
   *
   * `fail()` needs it to tell "the vendor refused us" from "this call went
   * wrong": only a failure with a provider attached may park a vendor and
   * decline to spend the call's retry budget (P1-A). Undefined until the route
   * is chosen, which means a failure BEFORE the submit - a missing recording,
   * object storage down - behaves exactly as it always did and parks nothing.
   */
  let asrProvider: AsrProvider | undefined;

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
      // Dead air (doc 33 §5, 0140): four numbers from the audio just
      // downloaded, in the background. Never awaited and never throws - it
      // cannot delay or fail this call, and it costs no ASR.
      analyseDeadAirInBackground(original, callId, orgId);

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

      // ── WHICH PROVIDER, AND IS IT WORKING? ──────────────────────────────
      //
      // This was `if (sarvamAsrConfigured())` - key presence - and that single
      // `if` is doc 49 P1. It answered "is a key set" while the code read the
      // answer as "does this provider work", and for 62 days those disagreed:
      // Sarvam's wallet was empty, GEMINI_API_KEY was set and funded the whole
      // time, and 2,792 calls went to the empty one because a key was present.
      //
      // `chooseAsrProvider` reads `asr_provider_health` (0202) and answers the
      // question the pipeline actually has, which is whether a provider is
      // USABLE.
      const route = await withOrgContext(orgId, (client) => chooseAsrProvider(client));
      if (route.kind === "none") {
        // Nothing to try. Defer - do not fail - and do not spend an attempt:
        // this call was never attempted, and a customer must not be shown a
        // red row because our vendors are both refusing us.
        const soonest = route.retryAfter ?? new Date(Date.now() + 15 * 60 * 1000);
        await helpers.defer(
          "ASR",
          route.parked.length > 0 ? "provider_out_of_credit" : "provider_not_configured",
          route.parked.length > 0
            ? `No ASR provider is usable: ${route.parked
                .map((p) => `${p.provider} parked until ${p.parkedUntil.toISOString()} (${p.reason ?? "unknown"})`)
                .join("; ")}. Top one up, or set ASR_PROVIDER_ORDER to a provider that works.`
            : "No ASR provider is configured at all - set SARVAM_API_KEY or GEMINI_API_KEY.",
          soonest,
        );
        return;
      }
      asrProvider = route.provider;

      if (asrProvider === "sarvam") {
        // Batch provider: hand over the audio, record the job, and stop.
        // The call stays in TRANSCRIBING - which is exactly true - and the
        // poller drives it from here. Committing the job id before returning
        // is what makes this survive a worker restart: the provider is
        // already transcribing (and billing) this audio, so losing the id
        // would mean paying twice.
        // ── SPEAKER SEPARATION IS A PAID TIER, CHECKED HERE TOO ───────────
        //
        // The plan-apply path already clamps `asr_diarization` to false for a
        // plan that does not sell it (0197, `applyPlanMeters`), so this `&&`
        // is the second lock rather than the first. It is worth having: the
        // tenancy PATCH route can write that column, so a tenant who toggled
        // it back on between plan applications would otherwise be spending
        // Growth money on Starter. Sarvam diarized is ₹45 an audio-hour
        // against ₹30 plain, and it is the ONLY provider that charges a real
        // premium - which is precisely why this is the one ASR option a plan
        // gates.
        //
        // What a tenant without it loses is the speaker LABELS and the
        // talk-time ratios, not the words: Sarvam uses the same transcription
        // model either way.
        const diarize = orgRow?.asr_diarization === true && planLimits.speakerSeparation;
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
          // The submit is where a 402 arrives, so a submit the vendor ACCEPTED
          // is the evidence that its account is funded and its credentials are
          // live. Recording it here clears any park left over from an outage
          // that has since been fixed - which is what lets a six-hour park end
          // the moment somebody tops the account up, rather than six hours
          // later.
          await recordProviderSuccess(client, "sarvam");
        });
        console.log(
          `call ${callId}: submitted to ${process.env.SARVAM_STT_MODEL ?? "saaras:v3"} ` +
            `[${orgRow?.asr_language ?? process.env.SARVAM_STT_LANGUAGE ?? "unknown"}/` +
            `${orgRow?.asr_mode ?? process.env.SARVAM_STT_MODE ?? "transcribe"}/` +
            `${diarize ? "diarized" : "plain"}] (job ${jobId})`,
        );
        return;
      }

      // The duration goes in so the ASR validator can catch a timeline that
      // claims to run past the end of the audio - the inline provider does that
      // routinely, and a transcript is not evidence that its clock is real.
      console.log(`call ${callId}: transcribing inline via ${describeProvider(asrProvider)}`);
      const result = await transcribe(audio, "audio/mp4", billableS);
      await withOrgContext(orgId, async (client) => {
        await persistTranscript(client, orgId, callId, result);
        // The inline provider diarizes as part of the same request rather
        // than as a priced add-on, so it is metered on the plain tier.
        await recordAsrUsage(client, orgId, callId, billableS, false);
        await recordProviderSuccess(client, asrProvider!);
      });
    }
  } catch (err) {
    // The provider rides along, so a vendor-level error parks the VENDOR
    // instead of spending this call's attempts (P1-A).
    await fail("ASR", err, { provider: asrProvider });
    return;
  }

  await runPostAsrStages(orgId, callId, helpers);
}
