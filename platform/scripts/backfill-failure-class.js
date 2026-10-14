/**
 * Give every historical failure a `failure_class`, so the console stops telling
 * customers their recordings are unreadable for a failure that was ours.
 *
 *   node scripts/backfill-failure-class.js                 # count, change nothing
 *   node scripts/backfill-failure-class.js --apply
 *
 * ── WHY THIS IS NEEDED (doc 49 P12, item 2) ─────────────────────────────────
 *
 * Migration 0201 adds `calls.failure_class` as NULLABLE, so every call that
 * failed before it was applied has NULL - and `pipelineStage()` renders NULL
 * exactly as it rendered everything before: "Speech recognition could not read
 * this recording." For the 2,792 calls that failed because an ASR vendor's
 * account was empty, that sentence is three untruths in a row, and fixing the
 * code without fixing the history leaves every one of those rows still saying
 * it.
 *
 * ── WHY IT CLASSIFIES WITH THE SAME FUNCTION THE PIPELINE USES ──────────────
 *
 * It would be shorter to write `UPDATE calls SET failure_class = 'platform'
 * WHERE error_message LIKE '%insufficient_quota%'`, which is what the plan
 * suggests, and for the 2,792 known rows it is the same answer. It is the wrong
 * shape anyway: the backlog is not only the 402s. There are ~1,600 other failed
 * rows, and a hand-written LIKE would leave those NULL - which means still
 * telling a customer their recording is defective whenever it was in fact a
 * timeout, a storage error or a rate limit.
 *
 * So this reads `error_message` and runs it through `classifyFailure`, the one
 * function the pipeline now uses. Two consequences worth stating:
 *
 *   * the history and the present agree BY CONSTRUCTION, rather than by two
 *     people having reasoned the same way on different days; and
 *   * because the classifier defaults unrecognised errors to `platform`, an
 *     old error nobody has diagnosed is filed as OURS. That is the deliberate
 *     direction: defaulting to "ours" costs a triage row, defaulting to
 *     "theirs" costs a customer's trust in their own equipment.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *
 * Dry by default. Writes only `failure_class` and `failure_reason_code`, and
 * only on rows where `failure_class IS NULL` - so it is re-runnable, it can
 * never disagree with a value the live pipeline has since written, and it
 * touches no status, no attempt counter, no `next_attempt_at` and nothing a
 * customer can see other than the sentence it exists to correct.
 *
 * It raises NO escalation tickets. 0201's de-dupe would hold the 2,792 old 402s
 * to one row per (org, reason), but a ticket opened today about an incident
 * that ended today is noise on a board that is about to be used for real.
 */
const { Client } = require("pg");

const APPLY = process.argv.includes("--apply");
const URL =
  process.env.DATABASE_URL ?? "postgresql://aura:aura_dev_password@localhost:55432/callintel";
/** How many rows per transaction. Keeps any lock short on a live database. */
const BATCH = Number(process.env.BACKFILL_BATCH ?? 500);

/**
 * The classifier, from the BUILT package.
 *
 * Required by path rather than by name: `scripts/` is not a workspace package,
 * so a bare `require("@aura/shared")` does not resolve from here. Compiled
 * CommonJS, so it needs `pnpm --filter @aura/shared build` to be current - and
 * that is the point of using it rather than re-implementing the rules: a
 * backfill that disagrees with the live pipeline is worse than no backfill,
 * because the disagreement is invisible and permanent.
 */
function loadClassifier() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../packages/shared/dist/provider-failures.js");
    if (typeof mod.classifyFailure !== "function") throw new Error("no classifyFailure export");
    return mod.classifyFailure;
  } catch (err) {
    console.error(
      "could not load the classifier from packages/shared/dist - run\n" +
        "  pnpm --filter @aura/shared build\n" +
        String(err.message ?? err),
    );
    process.exit(1);
  }
}

/**
 * The pipeline stage a FAILED_* status names, in the vocabulary
 * `classifyFailure` expects. The classifier uses it only for the client
 * sentence and the operator summary, but a wrong stage there would read oddly
 * on a support ticket, so it is mapped rather than guessed.
 */
const STAGE_OF = {
  FAILED_TRANSCODE: "TRANSCODE",
  FAILED_ASR: "ASR",
  FAILED_ANALYZE: "ANALYZE",
  FAILED_CRM: "CRM",
  FAILED_UPLOAD: "UPLOAD",
};

async function main() {
  const classifyFailure = loadClassifier();
  const client = new Client({ connectionString: URL });
  await client.connect();

  const {
    rows: [{ n: pending }],
  } = await client.query(
    `SELECT count(*)::int AS n FROM calls
      WHERE status LIKE 'FAILED_%' AND failure_class IS NULL`,
  );
  console.log(`\n${pending} failed call(s) carry no failure_class.`);
  if (pending === 0) {
    await client.end();
    return;
  }

  // What the classifier makes of the history, before anything is written.
  const { rows: sample } = await client.query(
    `SELECT status, error_message, count(*)::int AS n
       FROM calls
      WHERE status LIKE 'FAILED_%' AND failure_class IS NULL
      GROUP BY 1, 2
      ORDER BY n DESC`,
  );
  const tally = new Map();
  for (const row of sample) {
    const stage = STAGE_OF[row.status] ?? "ASR";
    const c = classifyFailure(stage, row.error_message ?? "");
    const key = `${c.failureClass}/${c.reason ?? "-"}`;
    tally.set(key, (tally.get(key) ?? 0) + row.n);
  }
  console.log("\nwhat the classifier makes of them:");
  for (const [key, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${key}`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN - nothing written. Re-run with --apply.\n");
    await client.end();
    return;
  }

  let done = 0;
  for (;;) {
    // Re-read each batch rather than paging an offset: the predicate shrinks as
    // rows are classified, so an offset would skip rows after the first batch.
    const { rows } = await client.query(
      `SELECT id, status, error_message FROM calls
        WHERE status LIKE 'FAILED_%' AND failure_class IS NULL
        ORDER BY started_at
        LIMIT $1`,
      [BATCH],
    );
    if (rows.length === 0) break;

    await client.query("BEGIN");
    try {
      for (const row of rows) {
        const stage = STAGE_OF[row.status] ?? "ASR";
        const c = classifyFailure(stage, row.error_message ?? "");
        await client.query(
          // The NULL guard is repeated here, not only in the SELECT: between
          // the read and the write the live pipeline may have classified this
          // very row, and its verdict is the current one.
          `UPDATE calls SET failure_class = $2, failure_reason_code = $3
            WHERE id = $1 AND failure_class IS NULL`,
          [row.id, c.failureClass, c.reason],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    done += rows.length;
    console.log(`  classified ${done}/${pending}`);
  }

  const { rows: after } = await client.query(
    `SELECT failure_class, failure_reason_code, count(*)::int AS n
       FROM calls WHERE status LIKE 'FAILED_%'
      GROUP BY 1, 2 ORDER BY n DESC`,
  );
  console.log("\nfinal distribution:");
  for (const r of after) {
    console.log(
      `  ${String(r.n).padStart(6)}  ${r.failure_class ?? "NULL"}/${r.failure_reason_code ?? "-"}`,
    );
  }
  console.log("");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
