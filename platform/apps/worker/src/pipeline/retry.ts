import { getAdminPool, withOrgContext } from "@aura/db";
import { publishPipeline } from "@aura/queue";

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
 * RLS context to touch its rows — the sweep spans tenants, the writes never do.
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
 * died between the two. Neither leaves anything to retry from — the call is not
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

export function startRetrySweeper(): NodeJS.Timeout {
  const interval = Number(process.env.PIPELINE_RETRY_INTERVAL_MS ?? 30_000);
  return setInterval(() => {
    void retryDueCalls().catch((err) => console.error("pipeline retry:", err));
    void requeueStuckUploads().catch((err) => console.error("pipeline stuck-upload sweep:", err));
  }, interval);
}
