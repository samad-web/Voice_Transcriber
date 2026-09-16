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
    "SELECT id, retention_days, qualification_retention_days FROM organizations WHERE status = 'active'",
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

      // Leads age out on their OWN clock, not their source call's. A deal the
      // owner is still working must survive the recording that started it
      // (0010 nulls the call link rather than cascading), but a lead nobody
      // has touched for the retention window is still tenant data holding a
      // contact name, so it goes.
      const dormant = await client.query(
        `DELETE FROM leads WHERE last_activity_at < now() - make_interval(days => $1)
         RETURNING id`,
        [org.retention_days],
      );
      if ((dormant.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, meta)
           VALUES ($1, 'system', 'reaper', 'retention.reap', 'lead', $2::jsonb)`,
          [org.id, JSON.stringify({ count: dormant.rowCount })],
        );
      }

      // Deals age out the same way, on their own last_activity_at clock - an
      // owner still working one keeps bumping it via every edit, same as
      // leads above. Deleting the deal itself cascades its custom-field
      // values, stage-transition ledger, and any interactions/tasks hung
      // off it (0037/0040/0041/0046).
      const dormantDeals = await client.query(
        `DELETE FROM deals WHERE last_activity_at < now() - make_interval(days => $1)
         RETURNING id`,
        [org.retention_days],
      );
      if ((dormantDeals.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, meta)
           VALUES ($1, 'system', 'reaper', 'retention.reap', 'deal', $2::jsonb)`,
          [org.id, JSON.stringify({ count: dormantDeals.rowCount })],
        );
      }

      // WhatsApp qualification verdicts (0080/0082) age out on their OWN clock,
      // not retention_days. A verdict is a small, short-lived thing: once the
      // thread has been approved or rejected its only remaining jobs are to
      // stop the sweep re-reading and re-billing that conversation, and to
      // answer "why did this enquiry never reach the board". Both expire.
      //
      // This matters most for the rows nobody ever asked for: every message the
      // qualifier judged `personal` has a row here, and while 0082 guarantees
      // it holds no extracted content, "this number wrote to us and it was
      // private" is itself a fact with no reason to live forever.
      //
      // PENDING rows are excluded. A verdict still waiting for a human is work
      // in progress, and deleting it would silently drop an enquiry nobody had
      // got to yet - the exact failure this whole feature exists to end.
      const staleVerdicts = await client.query(
        `DELETE FROM conversation_qualifications
          WHERE status <> 'pending'
            AND created_at < now() - make_interval(days => $1)
          RETURNING id`,
        [org.qualification_retention_days],
      );
      if ((staleVerdicts.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, meta)
           VALUES ($1, 'system', 'reaper', 'retention.reap', 'conversation_qualification', $2::jsonb)`,
          [org.id, JSON.stringify({ count: staleVerdicts.rowCount })],
        );
      }

      // A contact goes once it's stale AND nothing else still needs it -
      // same "last link" question erasure.controller.ts asks (a hand-created
      // deal, a manual note, a task), checked fresh here so a deal reaped
      // just above already counts as gone. `status <> 'merged'`: a merge
      // victim is a tombstone with its own 30-day revert window (0038), not
      // this sweep's business to remove.
      const dormantContacts = await client.query(
        `DELETE FROM contacts c
          WHERE c.status <> 'merged'
            AND c.last_activity_at < now() - make_interval(days => $1)
            AND NOT EXISTS (SELECT 1 FROM deals WHERE contact_id = c.id)
            -- A person's record of them (a note, an email, a call someone
            -- logged by hand) keeps the contact; a RECORDED call row does not.
            -- Keyed on type plus the hand-logged marker, never on
            -- call_id IS NULL: interactions.call_id is ON DELETE SET NULL, so
            -- once this very sweep removes an expired call its row would read
            -- as hand-logged and keep the contact alive forever. The marker is
            -- in metadata rather than actor_user_id, which is SET NULL too.
            AND NOT EXISTS (
              SELECT 1 FROM interactions
               WHERE contact_id = c.id
                 AND (type <> 'call' OR metadata @> '{"logged_by_hand": true}')
            )
            AND NOT EXISTS (SELECT 1 FROM tasks WHERE contact_id = c.id AND deal_id IS NULL)
         RETURNING c.id`,
        [org.retention_days],
      );
      if ((dormantContacts.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, meta)
           VALUES ($1, 'system', 'reaper', 'retention.reap', 'contact', $2::jsonb)`,
          [org.id, JSON.stringify({ count: dormantContacts.rowCount })],
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
