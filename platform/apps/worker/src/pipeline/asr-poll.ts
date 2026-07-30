import { getAdminPool, withOrgContext } from "@aura/db";
import { collectSarvamAsrJob, sarvamAsrConfigured } from "./asr-sarvam";
import { persistTranscript, priorAttempts, runPostAsrStages, stageHelpers } from "./pipeline";

/**
 * Second half of the ASR stage for batch providers.
 *
 * `processCall` submits the audio, records the job id and stops at
 * TRANSCRIBING. This sweep finds those calls, asks the provider whether the job
 * is done, and — when it is — writes the transcript and runs the call through
 * the remaining stages. Same shape and same reasoning as the retry sweeper and
 * the CRM outbox drain: the calls table IS the queue, so a worker restart, a
 * redeploy or a purged broker cannot strand a call whose audio the provider has
 * already accepted and charged for.
 *
 * Runs cross-tenant off the admin pool to find work, then re-enters each org's
 * RLS context to touch its rows — the sweep spans tenants, the writes never do.
 */

/**
 * How long a submitted job may stay unfinished before we treat it as lost.
 *
 * Sarvam's own client gives up after 10 minutes; this is deliberately looser,
 * because a long call queued behind a provider backlog is not an error. What it
 * catches is the job that never reaches a terminal state at all — without it,
 * such a call would sit in TRANSCRIBING forever, invisible to the retry sweep
 * (which only looks at FAILED_*) and to anyone not reading worker logs.
 */
const ASR_JOB_TIMEOUT_MS = Number(process.env.ASR_JOB_TIMEOUT_MS ?? 30 * 60 * 1000);

interface PendingJob {
  id: string;
  org_id: string;
  asr_job_id: string;
  asr_job_started_at: Date | null;
}

/**
 * Claim before writing. Clearing the job id under a check that it is still the
 * one we polled means two pollers (or a poller racing an operator pressing
 * Reprocess) cannot both drive the same call: the first UPDATE takes the id and
 * the second matches nothing.
 */
const CLAIM_SQL = `
  UPDATE calls
     SET asr_job_id = NULL, asr_job_started_at = NULL
   WHERE id = $1
     AND asr_job_id = $2
     AND status = 'TRANSCRIBING'
  RETURNING id`;

export async function pollAsrJobs(limit = 100): Promise<number> {
  if (!sarvamAsrConfigured()) return 0;

  const { rows: pending } = await getAdminPool().query<PendingJob>(
    `SELECT id, org_id, asr_job_id, asr_job_started_at
       FROM calls
      WHERE asr_job_id IS NOT NULL
        AND status = 'TRANSCRIBING'
      ORDER BY asr_job_started_at
      LIMIT $1`,
    [limit],
  );
  if (pending.length === 0) return 0;

  let finished = 0;
  for (const row of pending) {
    // Polled outside the org transaction on purpose: this is a network round
    // trip per outstanding job, and holding a pooled Postgres connection open
    // across it would put every tenant behind the slowest provider response.
    let outcome: Awaited<ReturnType<typeof collectSarvamAsrJob>>;
    try {
      outcome = await collectSarvamAsrJob(row.asr_job_id);
    } catch (err) {
      // A transport-level problem is not the job's verdict — leave it pending
      // and ask again next tick. The stall check below is what eventually
      // ends a job that never resolves.
      console.error(`call ${row.id}: asr poll error for job ${row.asr_job_id}:`, err);
      continue;
    }

    if (outcome.state === "pending") {
      const startedAt = row.asr_job_started_at ? row.asr_job_started_at.getTime() : 0;
      const age = Date.now() - startedAt;
      if (startedAt && age > ASR_JOB_TIMEOUT_MS) {
        await failCall(
          row,
          new Error(
            `ASR job ${row.asr_job_id} still unfinished after ${Math.round(age / 60000)} minutes`,
          ),
        );
        finished++;
      }
      continue;
    }

    if (outcome.state === "failed") {
      await failCall(row, new Error(outcome.reason));
      finished++;
      continue;
    }

    await withOrgContext(row.org_id, async (client) => {
      const claim = await client.query(CLAIM_SQL, [row.id, row.asr_job_id]);
      if ((claim.rowCount ?? 0) === 0) return;

      const attempts = await priorAttempts(client, row.id);
      const helpers = stageHelpers(client, row.id, attempts);
      try {
        await persistTranscript(client, row.org_id, row.id, outcome.result);
      } catch (err) {
        await helpers.fail("ASR", err);
        return;
      }
      console.log(
        `call ${row.id}: transcript from ${outcome.result.engine} ` +
          `(${outcome.result.segments.length} segments, ${outcome.result.diarized ? "diarized" : "single speaker"})`,
      );
      await runPostAsrStages(client, row.org_id, row.id, helpers);
    });
    finished++;
  }

  return finished;
}

/** Record a job-level failure through the same budget as an inline ASR error. */
async function failCall(row: PendingJob, err: Error): Promise<void> {
  await withOrgContext(row.org_id, async (client) => {
    const claim = await client.query(CLAIM_SQL, [row.id, row.asr_job_id]);
    if ((claim.rowCount ?? 0) === 0) return;
    const attempts = await priorAttempts(client, row.id);
    await stageHelpers(client, row.id, attempts).fail("ASR", err);
  });
}

export function startAsrPoller(): NodeJS.Timeout {
  const interval = Number(process.env.ASR_POLL_INTERVAL_MS ?? 15_000);
  return setInterval(() => {
    void pollAsrJobs().catch((err) => console.error("asr poll:", err));
  }, interval);
}
