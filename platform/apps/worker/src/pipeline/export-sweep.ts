import { getAdminPool } from "@aura/db";
import { publishExport } from "@aura/queue";

/**
 * The durable half of the export lane (doc 35 SS6.3, migration 0148).
 *
 * The queue is only a wake-up signal - `export_jobs` is the record - so
 * something has to find the jobs whose message was lost, whose worker died
 * mid-stream, or whose retry is now due. Without this, a broker restart during
 * a publish strands a job in 'queued' forever while the console shows "Waiting
 * to start" and nothing ever happens.
 *
 * Same shape as `startStalledCallSweeper` and the outbox drain: cross-tenant on
 * the admin pool, set-based, no per-org loop.
 */

/** A job still 'queued' after this long never got its message. */
const LOST_MESSAGE_AFTER = "5 minutes";
/** A job in flight longer than this is stalled, not slow (EXPORT_LIMITS.wallClockMinutes). */
const STALLED_AFTER = "60 minutes";
const INTERVAL_MS = Number(process.env.EXPORT_SWEEP_INTERVAL_MS ?? 60_000);

export async function sweepExports(): Promise<{ republished: number; failed: number; retried: number }> {
  const pool = getAdminPool();

  // 1 ── Lost messages. Re-publish rather than run inline: the consumer holds
  // the concurrency cap and the prefetch, and a sweep that ran jobs itself
  // would be a second, unthrottled execution path into the same work.
  const { rows: lost } = await pool.query<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM export_jobs
      WHERE status = 'queued'
        AND created_at < now() - $1::interval
      ORDER BY created_at
      LIMIT 50`,
    [LOST_MESSAGE_AFTER],
  );
  for (const job of lost) {
    // Best effort: a broker that is still down leaves the row untouched and the
    // next tick tries again. Never let one unreachable broker abort the sweep's
    // other two jobs, which need no broker at all.
    await publishExport({ jobId: job.id, orgId: job.org_id }).catch(() => undefined);
  }

  // 2 ── Stalled in flight. A worker killed mid-stream leaves its row in
  // 'running' or 'packaging' and its temp file on a disk nobody will look at
  // again; the row is what has to be reclaimed.
  //
  // This does NOT reset to 'queued' directly. Going through 'failed' means the
  // retry decision below is made in one place, the row keeps a readable reason,
  // and a job that stalls three times stops rather than cycling forever.
  const { rowCount: failed } = await pool.query(
    `UPDATE export_jobs
        SET status = 'failed',
            error = 'stalled: the worker did not finish within the hour',
            finished_at = now(),
            retry_count = retry_count + 1
      WHERE status IN ('running', 'packaging')
        AND started_at < now() - $1::interval`,
    [STALLED_AFTER],
  );

  // 3 ── Retries. Only for jobs that stalled: a job that FAILED for a reason -
  // a withdrawn permission, a row limit, an unimplemented dataset - reaches the
  // same answer on the second attempt, and `runExportJob` charges those the
  // full retry budget up front so they are excluded here by `retry_count < 3`.
  //
  // Backoff is in the predicate rather than a scheduler: one minute per attempt
  // made so far, which is enough to let a restarting worker come back.
  const { rows: retried } = await pool.query<{ id: string; org_id: string }>(
    `UPDATE export_jobs
        SET status = 'queued', error = NULL, started_at = NULL,
            rows_written = 0, bytes_written = 0
      WHERE status = 'failed'
        AND retry_count < 3
        AND error LIKE 'stalled:%'
        AND finished_at < now() - make_interval(mins => retry_count)
      RETURNING id, org_id`,
  );
  for (const job of retried) {
    await publishExport({ jobId: job.id, orgId: job.org_id }).catch(() => undefined);
  }

  return { republished: lost.length, failed: failed ?? 0, retried: retried.length };
}

export function startExportSweep(): NodeJS.Timeout {
  const timer = setInterval(() => {
    void sweepExports().catch((err) => console.error("export sweep failed:", err));
  }, INTERVAL_MS);
  // A sweep must never be the reason the process refuses to exit.
  timer.unref?.();
  return timer;
}
