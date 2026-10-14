import { getAdminPool } from "@aura/db";

/**
 * Prove the worker is running, to something outside the worker (0203).
 *
 * ── WHY A MONITOR CANNOT LIVE INSIDE THE PATIENT ────────────────────────────
 *
 * Every other health signal this deployment has is an inference. Queue depth
 * rising means the worker is dead OR the broker is slow OR a tenant uploaded
 * 400 calls at once. No calls completing means the worker is dead OR the vendor
 * is refusing us OR it is a quiet Sunday. Each inference has a false negative,
 * and the most important one is the cheapest to hit: a dead worker on a quiet
 * night has no queue to back up and no calls to fail, so every indirect check
 * reads healthy.
 *
 * A heartbeat is the one signal with no false negative. `scripts/alerts.js`
 * runs from cron - alive when this process is not - and reads a timestamp. If
 * it is nine minutes old, the worker is not running; there is nothing else it
 * can mean.
 *
 * ── WHY IT CARRIES THE BUILD ────────────────────────────────────────────────
 *
 * `release` answers "which commit is actually running" without an SSH session.
 * Doc 49 P7 names unanswerable-without-SSH as the reason deploy drift survives,
 * and `staged-vs-worktree-deploy-trap` is the measured case: a stale image
 * crash-looped production and the only way to find out what was running was to
 * log in and look.
 *
 * ── WHAT IT MUST NEVER DO ───────────────────────────────────────────────────
 *
 * Fail a deploy, hold a connection, or appear in a log every minute. One tiny
 * UPSERT on a one-row table, errors swallowed, and silent unless it breaks.
 */

/** How often. A minute, against a ten-minute staleness alarm - nine missed
 *  beats before anybody is woken, which is well clear of a restart. */
const INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 60_000);

async function beat(detail: string): Promise<void> {
  try {
    await getAdminPool().query(
      `INSERT INTO platform_heartbeats (service, beat_at, release, detail)
       VALUES ('worker', now(), $1, $2)
       ON CONFLICT (service) DO UPDATE
         SET beat_at = now(), release = $1, detail = $2`,
      [process.env.BUILD_SHA ?? process.env.GIT_SHA ?? null, detail.slice(0, 500)],
    );
  } catch (err) {
    // Swallowed, and deliberately not even logged on every failure: a database
    // blip would otherwise fill the log with the monitor's own complaints while
    // the thing being monitored is fine. The alert fires on a stale beat, which
    // is exactly what a failing write produces.
    if (process.env.HEARTBEAT_DEBUG === "1") console.error("heartbeat:", err);
  }
}

/**
 * Beat immediately, then on the interval.
 *
 * Immediately matters: without it a worker that crashes forty seconds into its
 * first boot leaves no record of ever having started, and the alert reads
 * "never written a heartbeat" - which is true but does not distinguish "not
 * deployed yet" from "crash-looping since the deploy".
 */
export function startHeartbeat(detail: string): NodeJS.Timeout {
  void beat(detail);
  const timer = setInterval(() => void beat(detail), INTERVAL_MS);
  timer.unref?.();
  return timer;
}
