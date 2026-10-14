/**
 * Make the next migration number a fact rather than a guess (doc 49 P7-D).
 *
 *   node scripts/check-migrations.js          # CI: fail on a duplicate, a gap, a bad name
 *   node scripts/check-migrations.js --next    # just print the next free number
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 *
 * On 2026-10-14 the migration directory had eight holes: 164, 167-169, 183,
 * 189-191. Some of that is the known production/local ledger divergence
 * (`crm-integrity-fixes`, `branch-divergence-crm`), and all of it is harmless
 * on its own. The practical effect is not: **nobody can tell by looking**
 * whether a number is free, renumbered, or lost.
 *
 * Picking the next migration number is something this project does weekly, and
 * it was being done by `ls | tail -1` plus hope - or, worse, by running a query
 * against production. Two people working in parallel both pick the same
 * number, and the second one's migration never runs because `migrate.js`
 * records applied migrations BY FILENAME: a duplicate number with a different
 * name applies twice, and a duplicate number with the same name silently
 * applies once.
 *
 * ── WHY THE HOLES ARE AN ALLOWLIST AND NOT AN ERROR ─────────────────────────
 *
 * They are real history and they cannot be filled - renumbering would change
 * the filenames `schema_migrations` already holds on production, and a
 * migration runner that keys on filename would then re-run everything after
 * the rename. So they are DECLARED here, in a list a human had to edit, which
 * means a NEW hole fails CI while the old ones stay quiet. That is the same
 * shape `verify-rls.js`'s non-tenant allowlist uses, for the same reason: the
 * exception has to cost a reviewed edit.
 */
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "packages", "db", "migrations");

/**
 * Numbers used TWICE, which this check would otherwise fail on.
 *
 * ── 0083, AND WHY IT IS NOT SIMPLY RENAMED ──────────────────────────────────
 *
 * `0083_asr_diarization.sql` and `0083_lead_temperature.sql` are unrelated
 * migrations that both took 0083. Our own runner tolerates it - `migrate.js`
 * records applied migrations by full FILENAME, so both applied, in filename
 * order, and production's `schema_migrations` holds both names. That tolerance
 * is exactly why it went unnoticed.
 *
 * It is not harmless, and the harm is in the mirror. `sync-supabase-migrations`
 * derives a Supabase version from the NUMBER alone, so both files map to
 * version `20260101000083` - and the Supabase CLI keys its own ledger by
 * version, not by filename. `supabase db push` against that directory cannot
 * apply both.
 *
 * The obvious fix - renumber one to the next free number - is the risky one,
 * and that is the whole reason this entry exists instead. `migrate.js` keys on
 * filename, so a rename makes production's recorded
 * `0083_lead_temperature.sql` match no file, and the renamed migration RE-RUNS
 * on the next deploy. That migration backfills `leads.temperature`, so
 * re-running it is a data write against four live tenants. It needs a
 * deliberate ledger update in the same window - not a tooling commit doing it
 * on the way past.
 *
 * So: declared here, so a NEW duplicate still fails CI, and reported loudly by
 * the sync script where somebody will see it before pushing. Written up in
 * platform/README.md with both options and their costs.
 */
const KNOWN_DUPLICATES = new Map([
  [
    83,
    "0083_asr_diarization.sql + 0083_lead_temperature.sql - pre-existing. Our runner " +
      "keys on filename so both applied; the Supabase MIRROR collides on version " +
      "20260101000083. Renumbering re-runs a data backfill on live tenants, so it needs " +
      "a deliberate ledger update. See platform/README.md.",
  ],
]);

/**
 * Numbers that are legitimately absent, with why.
 *
 * Adding to this list is how somebody says "this gap is history, not a
 * mistake". Removing a number from it is how a gap becomes available again -
 * which it is NOT, for any of these, because production's `schema_migrations`
 * may still name a file that once used it.
 */
const KNOWN_GAPS = new Map([
  [164, "renumbered during the CRM branch merge (branch-divergence-crm)"],
  [167, "renumbered during the CRM branch merge"],
  [168, "renumbered during the CRM branch merge"],
  [169, "renumbered during the CRM branch merge"],
  [183, "superseded before it was ever applied"],
  [189, "superseded before it was ever applied"],
  [190, "superseded before it was ever applied"],
  [191, "superseded before it was ever applied"],
]);

function main() {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const problems = [];
  const byNumber = new Map();
  const duplicatesSeen = new Set();

  for (const file of files) {
    const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!m) {
      // The name is load-bearing in three places: `migrate.js` orders by it and
      // records it verbatim, `sync-supabase-migrations.js` derives the Supabase
      // timestamp from the number, and `check-tenancy.js` greps it. A name this
      // regex rejects breaks at least one of them, usually silently.
      problems.push(`${file}: must be named NNNN_lower_snake_case.sql`);
      continue;
    }
    const n = Number(m[1]);
    if (byNumber.has(n)) {
      if (KNOWN_DUPLICATES.has(n)) {
        duplicatesSeen.add(n);
      } else {
        problems.push(
          `duplicate number ${m[1]}: ${byNumber.get(n)} and ${file}.\n` +
            "    migrate.js records applied migrations BY FILENAME, so two files sharing a\n" +
            "    number both apply - in filename order, with no relationship between them -\n" +
            "    while sync-supabase-migrations maps both to ONE Supabase version, which the\n" +
            "    Supabase CLI cannot apply twice. Renumber the newer file to the next free\n" +
            "    number BEFORE it is applied anywhere.",
        );
      }
      continue;
    }
    byNumber.set(n, file);
  }

  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  if (numbers.length === 0) {
    console.error("no migrations found - is this running from the repo root?");
    process.exit(1);
  }

  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  const present = new Set(numbers);

  const unexplained = [];
  for (let n = first; n <= last; n++) {
    if (present.has(n)) continue;
    if (KNOWN_GAPS.has(n)) continue;
    unexplained.push(n);
  }
  if (unexplained.length > 0) {
    problems.push(
      `unexplained gap(s): ${unexplained.map((n) => String(n).padStart(4, "0")).join(", ")}.\n` +
        "    Either a migration was deleted, or a number was skipped. If the gap is\n" +
        "    deliberate, add it to KNOWN_GAPS in this file with a reason - an exception\n" +
        "    should cost a reviewed edit, not a silent pass.",
    );
  }

  // A gap declared but not actually absent means the list has rotted - the
  // migration was added later and the entry is now a lie.
  const stale = [...KNOWN_GAPS.keys()].filter((n) => present.has(n));
  if (stale.length > 0) {
    problems.push(
      `KNOWN_GAPS claims ${stale.join(", ")} are absent, but ${stale
        .map((n) => byNumber.get(n))
        .join(", ")} exist(s). Remove the stale entries.`,
    );
  }

  const next = String(last + 1).padStart(4, "0");

  if (process.argv.includes("--next")) {
    console.log(next);
    process.exit(problems.length > 0 ? 1 : 0);
  }

  console.log(`${numbers.length} migration(s), ${String(first).padStart(4, "0")} → ${String(last).padStart(4, "0")}`);
  console.log(`next free number: ${next}`);
  if (KNOWN_GAPS.size > 0) {
    console.log(
      `intentionally absent: ${[...KNOWN_GAPS.keys()]
        .map((n) => String(n).padStart(4, "0"))
        .join(", ")}`,
    );
  }

  for (const n of duplicatesSeen) {
    console.log(`known duplicate ${String(n).padStart(4, "0")}: ${KNOWN_DUPLICATES.get(n)}`);
  }
  // A declared duplicate that is no longer duplicated means the list has
  // rotted, and a stale exception is an exception that silently covers the next
  // real one.
  const unusedDupes = [...KNOWN_DUPLICATES.keys()].filter((n) => !duplicatesSeen.has(n));
  if (unusedDupes.length > 0) {
    problems.push(
      `KNOWN_DUPLICATES claims ${unusedDupes.join(", ")} is duplicated and it is not. ` +
        "If it was renumbered, remove the entry.",
    );
  }

  if (problems.length > 0) {
    console.error("");
    for (const p of problems) console.error(`  FAIL  ${p}`);
    console.error("");
    process.exit(1);
  }
  console.log("numbering OK");
}

main();
