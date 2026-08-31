import { getAdminPool, withOrgContext } from "@aura/db";
import { publishPipeline } from "@aura/queue";
import { priorAttempts, stageHelpers } from "./pipeline";

/**
 * Automatic retry for calls whose pipeline run failed.
 *
 * Same shape as the CRM outbox drain, and for the same reason: the calls table
 * IS the queue. `fail()` in pipeline.ts stamps `next_attempt_at`; this sweep
 * finds whatever is due, rewinds it to UPLOADED and republishes. Nothing lives
 * only in RabbitMQ, so a worker restart, a redeploy or a purged broker cannot
 * strand a call that was waiting to be retried.
 *
 * Runs cross-tenant off the admin pool to find work, then re-enters each org's
 * RLS context to touch its rows - the sweep spans tenants, the writes never do.
 */

/**
 * Rewind is conditional on the row still being FAILED_* with a due
 * `next_attempt_at`. Two sweepers, or a sweep racing an operator pressing
 * Reprocess, therefore cannot both claim the same call: the first UPDATE clears
 * next_attempt_at and the second matches nothing.
 */
const CLAIM_SQL = `
  UPDATE calls
     SET status = 'UPLOADED', next_attempt_at = NULL
   WHERE id = $1
     AND status LIKE 'FAILED_%'
     AND next_attempt_at IS NOT NULL
     AND next_attempt_at <= now()
  RETURNING id`;

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
    const claimed: string[] = [];
    await withOrgContext(orgId, async (client) => {
      for (const callId of callIds) {
        const res = await client.query(CLAIM_SQL, [callId]);
        if ((res.rowCount ?? 0) > 0) claimed.push(callId);
      }
    });

    for (const callId of claimed) {
      await publishPipeline({ callId, orgId });
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
        await stageHelpers(client, row.id, attempts).fail(
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
  }, interval);
}
