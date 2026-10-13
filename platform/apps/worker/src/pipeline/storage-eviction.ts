import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getAdminPool, readEffectiveLimits, withOrgContext } from "@aura/db";
import { expireAudio } from "./reaper";

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
 * The storage cap: evict the oldest audio, never refuse an upload (0197).
 *
 * ── WHY EVICTION AND NOT REFUSAL ────────────────────────────────────────────
 *
 * One principle governs all four of the published limits: **a call is never
 * refused.** A recording we decline is lost for good, the handset would retry
 * it forever, and the customer loses the one thing they are paying us to keep.
 * So the gigabyte cap is a rail against abuse rather than a tier the customer
 * feels, and when it is reached the oldest audio goes rather than the newest
 * being turned away.
 *
 * ── AND WHY A NORMAL CUSTOMER NEVER SEES THIS RUN ───────────────────────────
 *
 * The two storage limits line up, which is worth saying plainly because it was
 * not designed in one go. At 20.6 MiB per audio-hour, Starter's 60-day window
 * holds about 2.3 GB against a 5 GB cap, and Growth's 90-day window about 7 GB
 * against 15 GB. So the DAY limit does the commercial work and the gigabyte cap
 * sits behind it with roughly two times headroom - waiting for the handset
 * stuck in a loop, or the floor that uploads everything twice.
 *
 * That headroom is the reason this sweep can afford to be blunt. It is not a
 * pricing mechanism firing on a paying customer every month; it is a backstop
 * for an account doing something unusual, and the unusual thing is almost
 * always a defect rather than a purchase decision.
 *
 * ── THE SAME DELETION AS RETENTION, A DIFFERENT STORY ───────────────────────
 *
 * It reuses `expireAudio`: delete the object, stamp `recordings.expired_at`,
 * keep the row and its `s3_key`. So an evicted call reads "recording expired"
 * exactly like one that aged out, the transcript and every CRM record survive,
 * and the storage meter falls on the next sweep because it excludes expired
 * rows. The audit action differs (`retention.storage_evicted`), which is what
 * lets somebody reading the log afterwards tell "your plan worked as sold"
 * from "you were over your ceiling".
 */
export async function evictOverCap(): Promise<{ orgs: number; evicted: number }> {
  const pool = getAdminPool();

  // Only orgs whose meter is at or past their ceiling. The meter is the hourly
  // snapshot (`org_storage_usage`), not a live sum, for the reason that table
  // exists: summing a year of recordings per org, Mumbai to Seoul, is the cost
  // this platform refuses to pay on a schedule.
  //
  // The CEILING is deliberately NOT read from `organizations.storage_quota_bytes`
  // here. That column is what the plan resolved into, and it is correct - but
  // `readEffectiveLimits` is the one function that knows about the extra-5 GB
  // add-on, and a tenant who bought one must not have last month's column
  // enforced against them. The column stays as the fast path for the warning
  // sweep; eviction, which DELETES, resolves properly.
  const { rows: candidates } = await pool.query<{
    org_id: string;
    recording_bytes: string;
  }>(
    `SELECT s.org_id, s.recording_bytes::text
       FROM org_storage_usage s
       JOIN organizations o ON o.id = s.org_id
      WHERE o.status = 'active'
        AND o.storage_quota_bytes IS NOT NULL
        AND s.recording_bytes > o.storage_quota_bytes`,
  );
  if (candidates.length === 0) return { orgs: 0, evicted: 0 };

  let evicted = 0;
  let orgs = 0;
  for (const candidate of candidates) {
    try {
      const limits = await readEffectiveLimits(pool, candidate.org_id);
      const cap = limits.storageCapBytes;
      // No cap after add-ons: the snapshot was read against a column that is
      // now stale, and deleting a customer's audio on a stale number is the
      // one mistake this sweep must not make.
      if (cap === null) continue;

      const freed = await withOrgContext(candidate.org_id, async (client) => {
        // Oldest first, and only live audio. The window function is what keeps
        // this to ONE round trip: a running total lets Postgres hand back
        // exactly the rows that have to go, rather than this loop fetching a
        // page, deciding, and fetching again.
        //
        // `running - bytes < over` selects every row up to and including the
        // one that crosses the overage - so the sweep lands at or under the
        // cap rather than one recording short of it, which would leave the
        // org selected again on the next run forever.
        const { rows } = await client.query<{
          id: string;
          recording_id: string;
          s3_key: string;
        }>(
          `WITH live AS (
             SELECT r.id AS recording_id, r.call_id, r.s3_key, COALESCE(r.bytes, 0) AS bytes,
                    sum(COALESCE(r.bytes, 0)) OVER (ORDER BY r.uploaded_at, r.id) AS running
               FROM recordings r
              WHERE r.uploaded_at IS NOT NULL
                AND r.expired_at IS NULL
                AND r.s3_key IS NOT NULL
           )
           SELECT call_id AS id, recording_id, s3_key
             FROM live
            WHERE running - bytes < $1::bigint
            ORDER BY running
            LIMIT 2000`,
          [String(Math.max(0, Number(candidate.recording_bytes) - cap))],
        );
        if (rows.length === 0) return 0;

        const result = await expireAudio(
          client,
          candidate.org_id,
          rows,
          (key) => s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })),
          "retention.storage_evicted",
        );
        return result.expired;
      });

      if (freed > 0) {
        orgs++;
        evicted += freed;
        console.warn(
          `storage eviction: org ${candidate.org_id} was over its ${cap}-byte cap; ` +
            `evicted the audio on ${freed} oldest call(s)`,
        );
      }
    } catch (err) {
      // One org's failure must not stop the others. A bucket that refuses a
      // delete leaves the rows unstamped and the org selected again next run,
      // which is the same self-healing shape the reaper has.
      console.error(`storage eviction: org ${candidate.org_id}:`, err);
    }
  }
  return { orgs, evicted };
}

export function startStorageEviction(): NodeJS.Timeout {
  // Hourly, and deliberately offset from the usage sweep by running on its own
  // timer started at a different moment: eviction reads the snapshot that sweep
  // writes, and racing it would mean evicting against numbers from two hours
  // ago. An hour of a tenant sitting over their cap costs us one hour of
  // storage, which is a rounding error against the risk of deleting audio on a
  // stale reading.
  const interval = Number(process.env.STORAGE_EVICTION_INTERVAL_MS ?? 60 * 60 * 1000);
  const run = () =>
    void evictOverCap()
      .then(({ orgs, evicted }) => {
        if (evicted > 0) console.log(`storage eviction: ${evicted} recording(s) across ${orgs} org(s)`);
      })
      .catch((err) => console.error("storage eviction:", err));
  // Five minutes after boot, so the usage sweep (which runs at 30 seconds) has
  // written a snapshot for this process to read.
  setTimeout(run, 5 * 60 * 1000);
  return setInterval(run, interval);
}
