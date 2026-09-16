import { getAdminPool, withOrgContext } from "@aura/db";
import { publishAnalyze, publishPipeline } from "@aura/queue";
import { priorAttempts, stageHelpers } from "./pipeline";

/**
 * Automatic retry for calls whose pipeline run failed.
 *
 * Same shape as the CRM outbox drain, and for the same reason: the calls table
 * IS the queue. `fail()` in pipeline.ts stamps `next_attempt_at`; this sweep
 * finds whatever is due, rewinds it to the earliest stage whose work is actually
 * missing, and republishes to that stage's queue. Nothing lives only in
 * RabbitMQ, so a worker restart, a redeploy or a purged broker cannot strand a
 * call that was waiting to be retried.
 *
 * Runs cross-tenant off the admin pool to find work, then re-enters each org's
 * RLS context to touch its rows - the sweep spans tenants, the writes never do.
 */

/**
 * REWIND TO THE STAGE THAT ACTUALLY NEEDS REDOING (A3).
 *
 * Rewind stays conditional on the row still being FAILED_* with a due
 * `next_attempt_at`. Two sweepers, or a sweep racing an operator pressing
 * Reprocess, therefore cannot both claim the same call: the first UPDATE clears
 * next_attempt_at and the second matches nothing.
 *
 * This used to set every failed call back to UPLOADED, which re-ran the whole
 * pipeline from the audio - including a second full ASR charge for a call whose
 * transcript was already written, correct, and paid for. Analyze failures are
 * the common case (it is the stage with two provider calls in it), so the
 * commonest retry in the system was also the one that wasted the most money.
 * The poller's own header has asked for this fix since the transaction split.
 *
 * The condition is deliberately on the FAILED STAGE and not merely on a
 * transcript existing. A reprocess re-runs ASR over audio that already has a
 * transcript from a previous run; if that re-run fails, "a transcript exists" is
 * true but stale, and resuming from it would quietly analyse the old one instead
 * of retrying the transcription the operator asked for. Only a failure at or
 * after ANALYZE may resume.
 *
 * FAILED_CRM resumes from ANALYZING too. That re-runs analyze, which is not
 * free, but it is the only in-flight state above ANALYZING and it is reached
 * solely by `failStalledCalls` - a worker that died mid-SYNCING - never by a
 * delivery failure, which has its own outbox and must not come through here.
 *
 * Returning the status is what tells the caller which queue to wake: the two
 * stages are consumed separately since A2, and publishing a resumed call to the
 * admission queue would have `processCall` skip it for not being in UPLOADED.
 */
const CLAIM_SQL = `
  UPDATE calls c
     SET status = CASE
           WHEN c.status IN ('FAILED_ANALYZE', 'FAILED_CRM')
            AND EXISTS (SELECT 1 FROM transcripts t WHERE t.call_id = c.id)
           THEN 'ANALYZING'
           ELSE 'UPLOADED'
         END,
         next_attempt_at = NULL
   WHERE c.id = $1
     AND c.status LIKE 'FAILED_%'
     AND c.next_attempt_at IS NOT NULL
     AND c.next_attempt_at <= now()
  RETURNING c.status`;

export async function retryDueCalls(limit = 200): Promise<number> {
  const { rows: due } = await getAdminPool().query<{ id: string; org_id: string }>(
    `SELECT id, org_id
       FROM calls
      WHERE next_attempt_at IS NOT NULL
        AND next_attempt_at <= now()
        AND status LIKE 'FAILED_%'
      ORDER BY next_attempt_at
      LIMIT $1`,
    [limit],
  );
  if (due.length === 0) return 0;

  const byOrg = new Map<string, string[]>();
  for (const row of due) {
    const list = byOrg.get(row.org_id) ?? [];
    list.push(row.id);
    byOrg.set(row.org_id, list);
  }

  let requeued = 0;
  for (const [orgId, callIds] of byOrg) {
    // Claim under the tenant's own context, then publish. Publishing only after
    // a successful claim means a call is never enqueued twice; if the publish
    // itself throws, the call is left in UPLOADED and the stuck-call sweep
    // below picks it up rather than it being lost.
    const claimed: Array<{ callId: string; status: string }> = [];
    await withOrgContext(orgId, async (client) => {
      for (const callId of callIds) {
        const res = await client.query<{ status: string }>(CLAIM_SQL, [callId]);
        if ((res.rowCount ?? 0) > 0) claimed.push({ callId, status: res.rows[0]!.status });
      }
    });

    for (const { callId, status } of claimed) {
      // Wake the queue that owns the stage this call was rewound TO. A resumed
      // call published to the admission queue would be skipped for not being in
      // UPLOADED, and would then sit in ANALYZING until the stall sweep noticed.
      if (status === "ANALYZING") await publishAnalyze({ callId, orgId });
      else await publishPipeline({ callId, orgId });
      requeued++;
    }
  }

  if (requeued > 0) console.log(`pipeline retry: requeued ${requeued} failed call(s)`);
  return requeued;
}

/**
 * How long a call may sit in UPLOADED before we assume its wake-up was lost.
 *
 * A call reaches UPLOADED and is published in the same breath, so the only ways
 * to be here for minutes are a broker that dropped the message or a worker that
 * died between the two. Neither leaves anything to retry from - the call is not
 * failed, so the sweep above will never look at it, and it would otherwise sit
 * untranscribed forever.
 */
const STUCK_UPLOADED_MS = Number(process.env.PIPELINE_STUCK_UPLOADED_MS ?? 10 * 60 * 1000);

export async function requeueStuckUploads(limit = 200): Promise<number> {
  const { rows: stuck } = await getAdminPool().query<{ id: string; org_id: string }>(
    `SELECT id, org_id
       FROM calls
      WHERE status = 'UPLOADED'
        AND updated_at < now() - make_interval(secs => $1)
      ORDER BY updated_at
      LIMIT $2`,
    [Math.round(STUCK_UPLOADED_MS / 1000), limit],
  );
  if (stuck.length === 0) return 0;

  for (const row of stuck) {
    // Nothing to claim: the call is already in the state the pipeline expects,
    // and processCall is idempotent on the UPLOADED→TRANSCODING transition, so
    // a duplicate wake-up is harmless.
    await publishPipeline({ callId: row.id, orgId: row.org_id });
  }
  console.log(`pipeline retry: re-woke ${stuck.length} stuck upload(s)`);
  return stuck.length;
}

/**
 * The in-flight states, and the failure each one lands on when the run that
 * owned it never came back.
 *
 * This is the same grid the console's stage panel uses
 * (`admin.controller.ts:15-20`) and the same one the CHECK constraint declares:
 * a stage that dies is a failure OF THAT STAGE, so a call abandoned in
 * ANALYZING must read as FAILED_ANALYZE and not as something vaguer.
 */
const STALL_STAGE_OF: Record<string, string> = {
  TRANSCODING: "TRANSCODE",
  TRANSCRIBING: "ASR",
  ANALYZING: "ANALYZE",
  SYNCING: "CRM",
};

/**
 * How long a call may sit in ONE in-flight state before we call the run dead.
 *
 * A pipeline run is seconds to a minute even on a long recording, so an hour is
 * far outside normal - deliberately so. Failing a call that is merely slow is
 * worse than the bug this closes: it costs a second round of ASR and analyze
 * (both billed) and, on the SYNCING stage, a second delivery into a customer's
 * CRM. The only thing an over-long timeout costs is a later recovery of a call
 * that is already lost.
 *
 * It is also deliberately LONGER than ASR_JOB_TIMEOUT_MS (30 min), which is the
 * clock asr-poll.ts runs on a batch job parked in TRANSCRIBING. The poller owns
 * those calls and ends them itself; every UPDATE bumps `updated_at` (0001's
 * set_updated_at trigger), so a submitted job's clock starts at submission and
 * the poller gets a full extra window before this sweep looks at it. Only a job
 * the poller can never resolve at all reaches here.
 */
const STALLED_MS = Number(process.env.PIPELINE_STALL_MS ?? 60 * 60 * 1000);

/**
 * Claim before failing. Conditional on the row still being in the same
 * in-flight state and still stale, so two sweepers - or a sweep racing an
 * operator pressing Reprocess - cannot both act on it: the first UPDATE takes
 * the row lock for the rest of the transaction and moves `updated_at` to now,
 * and the second re-reads the row after the commit and matches nothing.
 *
 * The SET is a no-op the trigger would do anyway. The point of the statement is
 * the lock and the predicate, not the write: the actual failure is recorded by
 * `fail()` immediately below it, inside the same transaction, so the call goes
 * through exactly the machinery an inline stage failure does.
 */
const CLAIM_STALLED_SQL = `
  UPDATE calls
     SET updated_at = now()
   WHERE id = $1
     AND status = $2
     AND updated_at < now() - make_interval(secs => $3)
  RETURNING id`;

/**
 * Calls abandoned mid-stage.
 *
 * `retryDueCalls` covers a run that failed and said so; `requeueStuckUploads`
 * covers a wake-up that never arrived. Neither covers the third case: a worker
 * killed - OOM, redeploy, SIGKILL - while it held a call. That call keeps the
 * in-flight status of the stage it died in, which is not `FAILED_%` and not
 * `UPLOADED`, so nothing ever looks at it again. It shows as "in pipeline" on
 * the dashboard forever and the customer's transcript simply never appears.
 *
 * The fix is deliberately not a fourth retry mechanism: land the call on the
 * FAILED_* of the stage it died in, through the same `fail()` every stage uses,
 * and let the sweep above do the retrying. Attempts are counted, so a call that
 * strands repeatedly retires to a human instead of looping forever.
 */
export async function failStalledCalls(limit = 200): Promise<number> {
  const seconds = Math.round(STALLED_MS / 1000);
  const { rows: stalled } = await getAdminPool().query<{
    id: string;
    org_id: string;
    status: string;
    updated_at: Date;
  }>(
    `SELECT id, org_id, status, updated_at
       FROM calls
      WHERE status = ANY($1::text[])
        AND updated_at < now() - make_interval(secs => $2)
      ORDER BY updated_at
      LIMIT $3`,
    [Object.keys(STALL_STAGE_OF), seconds, limit],
  );
  if (stalled.length === 0) return 0;

  const byOrg = new Map<string, typeof stalled>();
  for (const row of stalled) {
    const list = byOrg.get(row.org_id) ?? [];
    list.push(row);
    byOrg.set(row.org_id, list);
  }

  let failed = 0;
  for (const [orgId, rows] of byOrg) {
    await withOrgContext(orgId, async (client) => {
      for (const row of rows) {
        // Unreachable while the SELECT filters on the same map's keys - but the
        // value goes into a CHECK-constrained column, so a status this map does
        // not know is skipped rather than written as FAILED_undefined.
        const stage = STALL_STAGE_OF[row.status];
        if (!stage) continue;

        const claim = await client.query(CLAIM_STALLED_SQL, [row.id, row.status, seconds]);
        if ((claim.rowCount ?? 0) === 0) continue;

        // Re-wrapped rather than trusted: this is only the human-readable part
        // of the reason, and a driver handing back a string instead of a Date
        // must not throw inside the transaction that is recovering the call.
        const minutes = Math.round((Date.now() - new Date(row.updated_at).getTime()) / 60000);
        const attempts = await priorAttempts(client, row.id);
        // Same call `fail()` gets from an inline stage: error_message, the
        // attempt counter, the backoff and `next_attempt_at` all behave
        // identically, which is what puts the call back in front of
        // retryDueCalls on the next tick.
        await stageHelpers(client, row.id, attempts, row.org_id).fail(
          stage,
          new Error(
            `stalled in ${row.status} for ${minutes} minutes - the run that claimed it never finished`,
          ),
        );
        failed++;
      }
    });
  }

  if (failed > 0) console.log(`pipeline stall sweep: failed ${failed} stranded call(s)`);
  return failed;
}

/**
 * How long a call may sit in AWAITING_AUDIO before its upload is declared
 * never coming.
 *
 * There was no sweeper at all for this state until now (calls.controller.ts,
 * migration 0019 both flag the gap) - a call whose upload was interrupted and
 * then abandoned (handset offline for good, local file/DB row wiped, app
 * uninstalled) sat here forever, indistinguishable from one still mid-upload.
 * Generous on purpose: as of 0101 the client's own retry resumes the SAME
 * call via its idempotency key, and it fires on every new call the device
 * makes (UploadScheduler.enqueue drains the whole pending/failed queue), not
 * on a fixed schedule - a rep who goes quiet for a few hours must not have a
 * perfectly retriable upload declared dead under them.
 */
const AWAITING_AUDIO_STALL_MS = Number(
  process.env.PIPELINE_AWAITING_AUDIO_STALL_MS ?? 6 * 60 * 60 * 1000,
);

const CLAIM_AWAITING_AUDIO_SQL = `
  UPDATE calls
     SET status = 'FAILED_UPLOAD',
         error_message = $2,
         updated_at = now()
   WHERE id = $1
     AND status = 'AWAITING_AUDIO'
     AND created_at < now() - make_interval(secs => $3)
  RETURNING id`;

/**
 * Stranded AWAITING_AUDIO rows: audio never arrived, and nothing left to wait
 * for. FAILED_UPLOAD is deliberately given no `next_attempt_at` - unlike every
 * other FAILED_* state, retryDueCalls resuming this one from the server side
 * cannot help, because there is no audio in S3 to resume from. The only way a
 * call like this ever completes is the handset uploading again from scratch,
 * which - since it starts a fresh POST /v1/calls - lands as a brand new row,
 * not a change to this one.
 *
 * `created_at`, not `updated_at`: a call that keeps getting retried under 0101
 * reuses this same row without moving its status, so measuring from creation
 * is what makes "it has been in this state for N hours" mean what it says
 * regardless of how many failed attempts happened in between.
 */
export async function failStrandedAwaitingAudio(limit = 200): Promise<number> {
  const seconds = Math.round(AWAITING_AUDIO_STALL_MS / 1000);
  const { rows: stranded } = await getAdminPool().query<{ id: string; org_id: string }>(
    `SELECT id, org_id
       FROM calls
      WHERE status = 'AWAITING_AUDIO'
        AND created_at < now() - make_interval(secs => $1)
      ORDER BY created_at
      LIMIT $2`,
    [seconds, limit],
  );
  if (stranded.length === 0) return 0;

  const byOrg = new Map<string, string[]>();
  for (const row of stranded) {
    const list = byOrg.get(row.org_id) ?? [];
    list.push(row.id);
    byOrg.set(row.org_id, list);
  }

  const message = `no audio received within ${Math.round(seconds / 3600)}h of the call being created`;
  let failed = 0;
  for (const [orgId, callIds] of byOrg) {
    await withOrgContext(orgId, async (client) => {
      for (const callId of callIds) {
        const res = await client.query(CLAIM_AWAITING_AUDIO_SQL, [callId, message, seconds]);
        if ((res.rowCount ?? 0) > 0) failed++;
      }
    });
  }

  if (failed > 0) console.log(`pipeline retry: failed ${failed} stranded awaiting-audio call(s)`);
  return failed;
}

export function startRetrySweeper(): NodeJS.Timeout {
  const interval = Number(process.env.PIPELINE_RETRY_INTERVAL_MS ?? 30_000);
  return setInterval(() => {
    void retryDueCalls().catch((err) => console.error("pipeline retry:", err));
    void requeueStuckUploads().catch((err) => console.error("pipeline stuck-upload sweep:", err));
  }, interval);
}

/**
 * The stall sweep runs on its own, much slower timer.
 *
 * Two reasons, both about cost rather than taste. Its SELECT has no `org_id`
 * predicate, so `calls_status (org_id, status)` cannot serve it and - unlike
 * `requeueStuckUploads`, which 0019 gave a partial index - it scans the whole
 * multi-tenant calls table. And it is looking for a condition measured in
 * hours, so 30-second resolution buys nothing: five minutes is 288 scans a day
 * instead of 2,880, and the worst case is that a call already lost for an hour
 * is recovered up to five minutes later.
 */
export function startStalledCallSweeper(): NodeJS.Timeout {
  const interval = Number(process.env.PIPELINE_STALL_INTERVAL_MS ?? 5 * 60 * 1000);
  return setInterval(() => {
    void failStalledCalls().catch((err) => console.error("pipeline stall sweep:", err));
    void failStrandedAwaitingAudio().catch((err) =>
      console.error("pipeline awaiting-audio sweep:", err),
    );
  }, interval);
}
