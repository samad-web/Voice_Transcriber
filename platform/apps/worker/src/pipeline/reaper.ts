import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getAdminPool, withOrgContext } from "@aura/db";

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
 * Retention reaper (§2.6): enforces each org's retention_days across S3 +
 * Postgres. Org list is read via the admin pool (cross-tenant by nature);
 * each org's sweep runs inside its own RLS context. Runs on an interval in
 * dev (REAPER_INTERVAL_MS); production wants a scheduled job + metrics.
 */
export async function reapExpired(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query(
    "SELECT id, retention_days FROM organizations WHERE status = 'active'",
  );

  let reaped = 0;
  for (const org of orgs) {
    reaped += await withOrgContext(org.id, async (client) => {
      const { rows: expired } = await client.query(
        `SELECT c.id, r.s3_key FROM calls c
           LEFT JOIN recordings r ON r.call_id = c.id
          WHERE c.started_at < now() - make_interval(days => $1)
          LIMIT 500`,
        [org.retention_days],
      );
      for (const call of expired) {
        if (call.s3_key) {
          await s3
            .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: call.s3_key }))
            .catch(() => undefined);
        }
        for (const table of ["transcripts", "ai_outputs", "call_facts", "crm_sync_log", "recordings"]) {
          await client.query(`DELETE FROM ${table} WHERE call_id = $1`, [call.id]);
        }
        await client.query("DELETE FROM calls WHERE id = $1", [call.id]);
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
           VALUES ($1, 'system', 'reaper', 'retention.reap', 'call', $2)`,
          [org.id, call.id],
        );
      }
      return expired.length;
    });
  }
  if (reaped > 0) console.log(`reaper: removed ${reaped} expired call(s)`);
  return reaped;
}

export function startReaper(): NodeJS.Timeout {
  const interval = Number(process.env.REAPER_INTERVAL_MS ?? 60 * 60 * 1000);
  return setInterval(() => void reapExpired().catch((err) => console.error("reaper:", err)), interval);
}
