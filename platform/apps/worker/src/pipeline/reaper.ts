import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getAdminPool, withOrgContext } from "@aura/db";
import { AUTH_EVENT_RETENTION_DAYS } from "@aura/shared";
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

interface QueryClient {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}

/**
 * Delete expired calls - but only the ones whose audio is really gone.
 *
 * ── THIS IS THE DATA CLOCK, NOT THE AUDIO CLOCK (0197) ────────────────────
 *
 * Until 0197 one `retention_days` governed everything, and when it expired
 * this function deleted the audio, the transcript, the AI analysis and the
 * call row together. Wiring a plan's "60 days on Starter" to that column would
 * have quietly deleted a paying customer's CRM history - which is not a bug,
 * it is a refund, a reputation and possibly a compliance problem.
 *
 * So there are two clocks now and this one is the FULL PURGE, driven by
 * `organizations.data_retention_days`: off the price list, defaulting to 90
 * days or more, only ever changed per customer on request. The plan lever is
 * `retention_days`, it deletes the recording FILE and nothing else, and it is
 * `expireAudio` below.
 *
 * This used to swallow a failed S3 delete (`.catch(() => undefined)`) and
 * delete the rows anyway. The object then stayed in the bucket with no row
 * pointing at it: invisible in the console, never retried, still paid for, and
 * - since doc 27 - never counted by the storage meter, which reads
 * `recordings.bytes`. So a failed delete now keeps its call and recording
 * rows, and the next run tries again. A call with no audio (no s3_key) has
 * nothing to fail and goes as before.
 *
 * Exported with the S3 call injected, so a test can hand it a failing bucket.
 */
export async function reapCalls(
  client: QueryClient,
  orgId: string,
  expired: Array<{ id: string; s3_key: string | null }>,
  deleteObject: (key: string) => Promise<unknown>,
): Promise<{ reaped: number; kept: number }> {
  let reaped = 0;
  let kept = 0;
  for (const call of expired) {
    if (call.s3_key) {
      try {
        await deleteObject(call.s3_key);
      } catch (err) {
        kept++;
        console.warn(`reaper: kept call ${call.id} - its recording could not be deleted:`, err);
        continue;
      }
    }
    for (const table of ["transcripts", "ai_outputs", "call_facts", "crm_sync_log", "recordings"]) {
      await client.query(`DELETE FROM ${table} WHERE call_id = $1`, [call.id]);
    }
    await client.query("DELETE FROM calls WHERE id = $1", [call.id]);
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'system', 'reaper', 'retention.reap', 'call', $2)`,
      [orgId, call.id],
    );
    reaped++;
  }
  return { reaped, kept };
}

/**
 * The AUDIO clock (0197): delete the recording file, keep everything else.
 *
 * ── WHAT A CUSTOMER AT THEIR RETENTION LIMIT ACTUALLY LOSES ───────────────
 *
 * The ability to replay the call. That is all. The transcript, the AI
 * analysis, the extracted lead, the deal it became and every CRM record stay
 * exactly where they were, and the call reads "recording expired" rather than
 * offering a player that plays nothing. A customer at day 90 on Starter still
 * has their whole history and simply cannot listen to it.
 *
 * This is the lever the price list sells - "audio kept for 30 / 60 / 90 / 180
 * days" - and the one an operator raises with the retention add-on.
 *
 * ── WHY THE ROW IS KEPT AND ONLY STAMPED ──────────────────────────────────
 *
 * `expired_at` is set and `s3_key` is left intact, rather than deleting the
 * `recordings` row. Three reasons, and the third is the one that bites:
 *
 *   * the key is the record of WHAT was removed and from where, which is the
 *     first thing anybody asks after a complaint;
 *   * a reader whose player is missing gets an explanation instead of an
 *     absence, because `HAS_RECORDING` can tell "never had audio" from "the
 *     audio aged out";
 *   * `calls` is NOT deleted here, so a deleted `recordings` row would make
 *     the call indistinguishable from one that failed to upload - and
 *     `retry.ts` would try to collect audio for it forever.
 *
 * A FAILED S3 delete keeps the row unstamped and retries next run, exactly as
 * the purge below does: an object still in the bucket with a row that claims
 * it is gone is an object nobody will ever pay attention to again, and we are
 * still paying for it.
 */
export async function expireAudio(
  client: QueryClient,
  orgId: string,
  expired: Array<{ id: string; recording_id: string; s3_key: string }>,
  deleteObject: (key: string) => Promise<unknown>,
  /**
   * What the audit row calls it. The storage-cap sweep evicts audio by exactly
   * this mechanism and reuses this function, but the two are different events
   * to anybody reading the log afterwards: one is the plan working as sold,
   * the other is a tenant over their ceiling. Same deletion, different story.
   */
  action: "retention.audio_expired" | "retention.storage_evicted" = "retention.audio_expired",
): Promise<{ expired: number; kept: number }> {
  let done = 0;
  let kept = 0;
  for (const row of expired) {
    try {
      await deleteObject(row.s3_key);
    } catch (err) {
      kept++;
      console.warn(`reaper: kept audio for call ${row.id} - the object could not be deleted:`, err);
      continue;
    }
    await client.query(
      "UPDATE recordings SET expired_at = now(), updated_at = now() WHERE id = $1",
      [row.recording_id],
    );
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'system', 'reaper', $3, 'call', $2)`,
      [orgId, row.id, action],
    );
    done++;
  }
  return { expired: done, kept };
}

/**
 * Retention reaper (§2.6). Two clocks since 0197: `retention_days` expires the
 * AUDIO FILE, `data_retention_days` purges the records. Org list is read via
 * the admin pool (cross-tenant by nature); each org's sweep runs inside its
 * own RLS context. Runs on an interval in dev (REAPER_INTERVAL_MS); production
 * wants a scheduled job + metrics.
 */
export async function reapExpired(): Promise<number> {
  const { rows: orgs } = await getAdminPool().query(
    `SELECT id, retention_days, data_retention_days, qualification_retention_days
       FROM organizations WHERE status = 'active'`,
  );

  let reaped = 0;
  let kept = 0;
  let audioExpired = 0;
  for (const org of orgs) {
    let removed = 0;
    reaped += await withOrgContext(org.id, async (client) => {
      // ── PASS 1: the AUDIO clock. Deletes the file, keeps the call ─────────
      //
      // Runs first and on its own window, which for every plan is at or below
      // the data window - so by the time pass 2 looks at a call its audio is
      // usually already gone and there is nothing left in the bucket to
      // delete. The purge still handles a key it finds, because an operator
      // can set the two clocks in either order by hand.
      //
      // `expired_at IS NULL` is what makes this idempotent: a call whose audio
      // went last night is not re-selected, so the bucket is not asked to
      // delete the same key every hour forever.
      const { rows: agedAudio } = await client.query(
        `SELECT c.id, r.id AS recording_id, r.s3_key
           FROM calls c
           JOIN recordings r ON r.call_id = c.id
          WHERE c.started_at < now() - make_interval(days => $1)
            AND r.expired_at IS NULL
            AND r.s3_key IS NOT NULL
          LIMIT 500`,
        [org.retention_days],
      );
      const audio = await expireAudio(client, org.id, agedAudio, (key) =>
        s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })),
      );
      audioExpired += audio.expired;
      kept += audio.kept;

      // ── PASS 2: the DATA clock. The full purge ────────────────────────────
      //
      // `data_retention_days`, NOT `retention_days`. This is the line 0197
      // exists to draw: a plan's audio window must never reach a customer's
      // transcripts, leads, deals and contacts. COALESCE to 90 for safety -
      // the column is NOT NULL with a default, so this can only matter if
      // somebody adds a row around the schema, and the fail-safe direction for
      // a purge window is the longer one.
      const purgeDays = org.data_retention_days ?? 90;
      const { rows: expired } = await client.query(
        `SELECT c.id, r.s3_key FROM calls c
           LEFT JOIN recordings r ON r.call_id = c.id AND r.expired_at IS NULL
          WHERE c.started_at < now() - make_interval(days => $1)
          LIMIT 500`,
        [purgeDays],
      );
      const calls = await reapCalls(client, org.id, expired, (key) =>
        s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })),
      );
      kept += calls.kept;

      // Leads age out on their OWN clock, not their source call's. A deal the
      // owner is still working must survive the recording that started it
      // (0010 nulls the call link rather than cascading), but a lead nobody
      // has touched for the retention window is still tenant data holding a
      // contact name, so it goes.
      const dormant = await client.query(
        `DELETE FROM leads WHERE last_activity_at < now() - make_interval(days => $1)
         RETURNING id`,
        [purgeDays],
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
        [purgeDays],
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
        [purgeDays],
      );
      if ((dormantContacts.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, meta)
           VALUES ($1, 'system', 'reaper', 'retention.reap', 'contact', $2::jsonb)`,
          [org.id, JSON.stringify({ count: dormantContacts.rowCount })],
        );
      }

      removed =
        calls.reaped +
        (dormant.rowCount ?? 0) +
        (dormantDeals.rowCount ?? 0) +
        (dormantContacts.rowCount ?? 0);
      return calls.reaped;
    });
    // After the commit. Retention removes rows from boards and lists people
    // may have open; without this they would linger until the next navigation.
    if (removed > 0) announce(org.id, "lead", "deleted");
  }
  if (audioExpired > 0) console.log(`reaper: expired the audio on ${audioExpired} call(s), records kept`);
  if (reaped > 0) console.log(`reaper: removed ${reaped} call(s) past the data-retention window`);
  if (kept > 0) console.warn(`reaper: kept ${kept} recording(s) that could not be deleted from the bucket; retrying next run`);

  // A person's sign-in history (0127) on its own, platform-wide clock. Not a
  // tenant setting: the table is keyed on the person, not the org.
  const { rowCount: pruned } = await getAdminPool().query(
    `DELETE FROM auth_events WHERE created_at < now() - make_interval(days => $1)`,
    [AUTH_EVENT_RETENTION_DAYS],
  );
  if ((pruned ?? 0) > 0) console.log(`reaper: pruned ${pruned} sign-in event(s) older than ${AUTH_EVENT_RETENTION_DAYS} days`);

  return reaped;
}

export function startReaper(): NodeJS.Timeout {
  const interval = Number(process.env.REAPER_INTERVAL_MS ?? 60 * 60 * 1000);
  return setInterval(() => void reapExpired().catch((err) => console.error("reaper:", err)), interval);
}
