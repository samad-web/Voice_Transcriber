import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getAdminPool, withOrgContext, type PoolClient } from "@aura/db";
import type { ExportMessage } from "@aura/queue";
import {
  CSV_BOM,
  EXPORT_LIMITS,
  EXPORT_RETENTION_DAYS,
  type ExportDataset,
  type ExportDatasetKey,
  csvHeader,
  csvRow,
  exportDataset,
  redactedColumns,
  visibleColumns,
  type CsvColumn,
} from "@aura/shared";

import {
  buildCountQuery,
  buildDatasetQuery,
  CURSOR_COLUMN,
  IMPLEMENTED_DATASETS,
  type Cursor,
} from "./export-queries";
import {
  assertSubjectStillVisible,
  narrowerGridGrant,
  narrowerOwnerScope,
  readGridGrant,
  readOwnerScope,
  readRecordingsExport,
  resolvedScopeFor,
  SubjectNoLongerVisibleError,
  type ScopeSnapshot,
} from "./export-scope";
import { announce } from "./realtime";

/**
 * The export worker (doc 35 SS6.2, migration 0148).
 *
 * E1: CSV, `scope: 'view'`, one dataset per job, no UI in front of it. The ZIP
 * writer, XLSX and the section/bulk scopes are E3-E5; this lane exists first so
 * its throughput and memory behaviour can be measured against a real tenant
 * before anybody can reach it.
 *
 * ── THE SHAPE, AND WHY EACH STEP IS WHERE IT IS ─────────────────────────────
 *
 *   claim    a CONDITIONAL UPDATE, so two workers racing one job produce one
 *            run - the loser's UPDATE matches zero rows and it moves on. Not an
 *            advisory lock: the conditional update is the pattern every sweep
 *            in this directory uses and it survives a worker being killed.
 *   re-scope BEFORE the first row is read (SS4.2). See export-scope.ts.
 *   count    best effort, skipped above a threshold - a count that costs more
 *            than the export is not progress.
 *   stream   keyset pages into a temp file on disk. The process holds one page,
 *            one write buffer and a file handle. Never a result set.
 *   upload   to S3, then the row learns the key.
 *   notify   the requester only. The OWNER alert was written at enqueue, in the
 *            same transaction as the job (SS4.5), and a retry must not repeat it.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not send anything. `export_ready` is a `notifications` row, which
 * cannot reach a person who is not signed in to the console. No email carries a
 * download link, because a download link in an inbox is an unauthenticated
 * artifact sitting outside every gate this file just applied.
 */

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

/** Above this, the count is skipped and the console shows an indeterminate bar. */
const COUNT_CEILING = 250_000;
/** Progress is written at most this often, in rows and in milliseconds. */
const PROGRESS_EVERY_ROWS = 5_000;
const PROGRESS_EVERY_MS = 2_000;

interface JobRow {
  id: string;
  org_id: string;
  scope: "view" | "section" | "bulk" | "person";
  format: string;
  datasets: string[];
  filters: Record<string, unknown>;
  columns: Record<string, string[]>;
  requested_by_user_id: string;
  scope_snapshot: ScopeSnapshot;
  /** 0188: whose work a `person` export is about. Null on every other scope. */
  subject_telecaller_id: string | null;
  subject_user_id: string | null;
  subject_label: string | null;
}

/** A failure the sweep should not retry - the second attempt reaches the same answer. */
export class PermanentExportError extends Error {}

export async function runExportJob(message: ExportMessage): Promise<void> {
  const pool = getAdminPool();

  // ── CLAIM ────────────────────────────────────────────────────────────────
  //
  // Also enforces the per-org concurrency cap in the same statement: a third
  // running job for this org matches nothing and the message is left for the
  // sweep to re-publish. Doing it here rather than in a prior SELECT means two
  // workers cannot both read "2 running" and both start a third.
  const { rows: claimed } = await pool.query<JobRow>(
    `UPDATE export_jobs
        SET status = 'running', started_at = now()
      WHERE id = $1
        AND status = 'queued'
        AND (SELECT count(*) FROM export_jobs o
              WHERE o.org_id = export_jobs.org_id
                AND o.status IN ('running', 'packaging')) < $2
      RETURNING id, org_id, scope, format, datasets, filters, columns,
                requested_by_user_id, scope_snapshot,
                subject_telecaller_id, subject_user_id, subject_label`,
    [message.jobId, EXPORT_LIMITS.concurrentPerOrg],
  );
  if (claimed.length === 0) return;
  const job = claimed[0];

  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "aura-export-"));
    await withOrgContext(job.org_id, async (client) => {
      await streamJob(client, job, tempDir as string);
    });
    announce(job.org_id, "export", "updated", job.id);
  } catch (err) {
    const permanent = err instanceof PermanentExportError;
    const messageText = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE export_jobs
          SET status = 'failed', error = $2, finished_at = now(),
              retry_count = retry_count + $3
        WHERE id = $1`,
      // A permanent failure is charged the full retry budget immediately, so
      // the sweep's `retry_count < 3` test declines to try it again. Recording
      // it as retries-exhausted rather than adding a second column keeps one
      // meaning of "has this job given up".
      [job.id, messageText.slice(0, 2000), permanent ? 3 : 1],
    );
    await notifyRequester(pool, job, "export_failed", "Export failed", messageText.slice(0, 1000));
    announce(job.org_id, "export", "updated", job.id);
    // Rethrown so the queue's nack path logs it. The row already carries the
    // verdict, so the message itself is not needed again.
    throw err;
  } finally {
    // The temp file goes whatever happened. A worker that fails 200 jobs must
    // not fill the disk with their half-written CSVs.
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function streamJob(client: PoolClient, job: JobRow, tempDir: string): Promise<void> {
  // `person` (0188) renders through this same path: it is a single-dataset
  // export with one extra predicate, which is exactly why it was shaped like
  // `view` rather than like `bulk`. Multi-dataset archives are still doc 35's
  // E3 and still unbuilt, so `section` and `bulk` are still refused here.
  if ((job.scope !== "view" && job.scope !== "person") || job.datasets.length !== 1) {
    throw new PermanentExportError(
      `this build runs single-dataset 'view' and 'person' exports only; got '${job.scope}' with ${job.datasets.length}`,
    );
  }
  const key = job.datasets[0] as ExportDatasetKey;
  if (!IMPLEMENTED_DATASETS.includes(key)) {
    throw new PermanentExportError(`dataset not available yet: ${key}`);
  }
  const dataset = exportDataset(key);

  // ── RE-SCOPE (SS4.2) ─────────────────────────────────────────────────────
  const snapshot = job.scope_snapshot;
  const freshOwner = await readOwnerScope(client, job.requested_by_user_id, job.org_id);
  const owner = narrowerOwnerScope(
    {
      role: freshOwner.role,
      scope: snapshot.ownerScopeKind,
      userId: snapshot.userId,
      telecallerId: snapshot.telecallerId,
    },
    freshOwner,
  );

  let grid: "all" | "owned" | null = null;
  if (dataset.object) {
    grid = narrowerGridGrant(
      snapshot.grid?.[dataset.object],
      await readGridGrant(client, job.requested_by_user_id, job.org_id, dataset.object),
    );
    // The grant is gone since enqueue - a demotion, a role edit, the module
    // switched off. Refusing is the only safe reading: the person may not have
    // these rows NOW, and the file would outlive the permission.
    if (!grid) {
      throw new PermanentExportError(`permission withdrawn since this export was requested`);
    }
  }

  // Recordings likewise: the snapshot cannot widen it, and losing it since
  // enqueue drops the gated columns rather than failing the job. That
  // asymmetry is deliberate - a call export without transcripts is still the
  // export they asked for, minus what they may no longer see.
  const canExportRecordings =
    snapshot.canExportRecordings &&
    (await readRecordingsExport(client, job.requested_by_user_id, job.org_id));

  // ── RE-AUTHORIZE THE SUBJECT (0188) ──────────────────────────────────────
  //
  // After the persona and the grid, before a single row is read. The subject
  // comes from the JOB ROW rather than the snapshot - the column carries the
  // foreign key and the CHECK that guarantees a person job has one, so it is
  // the authoritative copy and the snapshot's is a convenience.
  let subject: { telecallerId: string; userId: string | null } | null = null;
  if (job.scope === "person") {
    if (!job.subject_telecaller_id) {
      // 0188's CHECK makes this unreachable. Guarded anyway, because the
      // failure mode is a person export rendering with no subject predicate -
      // the whole tenant in a file bearing one person's name.
      throw new PermanentExportError("a person export with no subject cannot be rendered");
    }
    try {
      await assertSubjectStillVisible(client, freshOwner, job.subject_telecaller_id);
    } catch (error) {
      if (error instanceof SubjectNoLongerVisibleError) {
        throw new PermanentExportError(error.message);
      }
      throw error;
    }
    subject = {
      telecallerId: job.subject_telecaller_id,
      userId: job.subject_user_id,
    };
  }

  const scope = resolvedScopeFor(owner, grid, subject);
  const columns = visibleColumns(dataset, canExportRecordings);
  const csvColumns: Array<CsvColumn<Record<string, unknown>>> = columns.map((c) => ({
    header: c.name,
    value: (row) => row[c.name],
  }));

  // ── COUNT (best effort) ──────────────────────────────────────────────────
  const count = buildCountQuery(dataset, scope);
  const { rows: counted } = await client.query<{ n: string }>(count.sql, count.params);
  const total = Number(counted[0]?.n ?? 0);
  if (total > EXPORT_LIMITS.rowsPerDataset) {
    throw new PermanentExportError(
      `${dataset.label} has ${total.toLocaleString()} rows, over the ${EXPORT_LIMITS.rowsPerDataset.toLocaleString()} limit. Narrow the date range and try again.`,
    );
  }
  const pool = getAdminPool();
  await pool.query(`UPDATE export_jobs SET rows_total = $2, current_dataset = $3 WHERE id = $1`, [
    job.id,
    total <= COUNT_CEILING ? total : null,
    dataset.key,
  ]);

  // ── STREAM ───────────────────────────────────────────────────────────────
  const fileName = `${dataset.key}-${new Date().toISOString().slice(0, 10)}.csv`;
  const filePath = join(tempDir, fileName);
  const out = createWriteStream(filePath, { encoding: "utf8" });

  // The BOM first, or Excel on Windows reads the file in the system codepage
  // and mangles every Devanagari or Tamil name in it - which is exactly what
  // this product's contacts are called.
  await write(out, CSV_BOM + csvHeader(csvColumns));

  let cursor: Cursor | null = null;
  let written = 0;
  let lastProgressRows = 0;
  let lastProgressAt = Date.now();

  for (;;) {
    const page = buildDatasetQuery(dataset, scope, canExportRecordings, cursor);
    const { rows } = await client.query<Record<string, unknown>>(page.sql, page.params);
    if (rows.length === 0) break;

    let chunk = "";
    for (const row of rows) chunk += csvRow(csvColumns, row);
    await write(out, chunk);
    written += rows.length;

    const last = rows[rows.length - 1];
    cursor = cursorFrom(dataset, last);
    // A dataset whose sort value is null on the last row cannot be paged past
    // it - the row-value comparison would exclude every remaining row. Stop
    // rather than loop forever or silently truncate without saying so.
    if (!cursor) {
      if (rows.length === EXPORT_LIMITS.pageRows) {
        throw new PermanentExportError(
          `${dataset.label} could not be paged: a row has no ${dataset.defaultOrder.split(" ")[0]}`,
        );
      }
      break;
    }

    if (
      written - lastProgressRows >= PROGRESS_EVERY_ROWS &&
      Date.now() - lastProgressAt >= PROGRESS_EVERY_MS
    ) {
      await pool.query(`UPDATE export_jobs SET rows_written = $2 WHERE id = $1`, [job.id, written]);
      announce(job.org_id, "export", "updated", job.id);
      lastProgressRows = written;
      lastProgressAt = Date.now();
    }

    // Cancelled from the console, between pages. One cheap indexed read per
    // page rather than per row.
    const { rows: live } = await pool.query<{ status: string }>(
      `SELECT status FROM export_jobs WHERE id = $1`,
      [job.id],
    );
    if (live[0]?.status !== "running") return;

    if (rows.length < EXPORT_LIMITS.pageRows) break;
  }

  await new Promise<void>((resolve, reject) => out.end((err?: Error) => (err ? reject(err) : resolve())));

  const { size } = await stat(filePath);
  if (size > EXPORT_LIMITS.bytesPerJob) {
    throw new PermanentExportError(
      `the file reached ${(size / 1024 / 1024).toFixed(0)} MB, over the limit. Narrow the export and try again.`,
    );
  }

  // ── PACKAGE + UPLOAD ─────────────────────────────────────────────────────
  await pool.query(`UPDATE export_jobs SET status = 'packaging', rows_written = $2 WHERE id = $1`, [
    job.id,
    written,
  ]);
  announce(job.org_id, "export", "updated", job.id);

  const storageKey = `exports/${job.org_id}/${job.id}/${fileName}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: storageKey,
      Body: createReadStream(filePath),
      ContentLength: size,
      ContentType: "text/csv; charset=utf-8",
    }),
  );

  await pool.query(
    `INSERT INTO export_job_files (org_id, job_id, dataset, file_name, row_count, bytes, redacted_columns)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (job_id, dataset) DO UPDATE
        SET file_name = EXCLUDED.file_name, row_count = EXCLUDED.row_count,
            bytes = EXCLUDED.bytes, redacted_columns = EXCLUDED.redacted_columns`,
    [
      job.org_id,
      job.id,
      dataset.key,
      fileName,
      written,
      size,
      redactedColumns(dataset, canExportRecordings),
    ],
  );

  await pool.query(
    `UPDATE export_jobs
        SET status = 'ready', storage_key = $2, file_name = $3,
            content_type = 'text/csv; charset=utf-8',
            bytes_written = $4, rows_written = $5,
            expires_at = now() + make_interval(days => $6), finished_at = now()
      WHERE id = $1`,
    [job.id, storageKey, fileName, size, written, EXPORT_RETENTION_DAYS],
  );

  await notifyRequester(
    pool,
    job,
    "export_ready",
    `${dataset.label} export ready`,
    `${written.toLocaleString()} rows. Available for ${EXPORT_RETENTION_DAYS} days.`,
  );
}

/**
 * The keyset cursor from a page's last row, or null when it cannot be formed.
 *
 * Reads `__cursor` - the sort value rendered as TEXT by Postgres - and NOT the
 * dataset's own timestamp column. A `Date` here would silently truncate
 * microseconds to milliseconds and drop every row sharing that second from the
 * next page; see CURSOR_COLUMN in export-queries.ts for the whole account.
 */
function cursorFrom(_dataset: ExportDataset, row: Record<string, unknown>): Cursor | null {
  const sortValue = row[CURSOR_COLUMN];
  const id = row.id;
  if (sortValue === null || sortValue === undefined || typeof id !== "string") return null;
  return { sortValue: String(sortValue), id };
}

async function notifyRequester(
  pool: { query: PoolClient["query"] },
  job: JobRow,
  kind: "export_ready" | "export_failed",
  title: string,
  body: string,
): Promise<void> {
  // `linkPath` carries NO `/admin` prefix. The console is served under that
  // basePath in production and `next/link` adds it; a stored path that already
  // says `/admin/...` is prefixed twice and 404s. Invisible in local dev, which
  // runs with no basePath - and it has shipped before.
  await pool
    .query(
      `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        job.org_id,
        job.requested_by_user_id,
        kind,
        title.slice(0, 200),
        body.slice(0, 1000),
        `/owner/account/data?job=${job.id}`,
      ],
    )
    .catch((err: unknown) => {
      // A notification that cannot be written must not undo a finished export.
      // The file is on S3 and the row says 'ready'; the bell is the cosmetic
      // half. Logged rather than swallowed silently, because a 23514 here is
      // how notification-kind drift announces itself.
      console.error(`export ${job.id}: notification (${kind}) failed:`, err);
    });
}

/** Backpressure-aware write - resolves once the stream has actually taken it. */
function write(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  return streamPipeline(Readable.from([chunk]), stream, { end: false });
}
