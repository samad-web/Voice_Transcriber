/**
 * Repair what merges did BEFORE merges moved everything (doc 23, D4).
 *
 * Until migration 0105 a merge repointed `deals` and nothing else, so every
 * other row that named the merged-away record - its timeline, tasks, threads,
 * quotations, invoices, journeys, tags, custom fields - is still attached to a
 * tombstone nobody can open. And because a merged contact kept its phone
 * number, the next call from that number could create a NEW contact: the
 * duplicate the operator had just merged, back again.
 *
 * This script does two things, and by default only REPORTS them:
 *
 *   1. Moves every reference off a merged record onto the live end of its merge
 *      chain, through the SAME repointReferences() the API's merge now calls -
 *      so a repaired merge and a fresh one leave identical data. Where the
 *      merge is still inside its revert window, the moves are added to that
 *      merge's merge_log row, so reverting it still undoes all of it.
 *
 *   2. Queues each recreated duplicate - a live contact sharing a phone number
 *      with a tombstone whose survivor is someone else - into Duplicates for a
 *      person to review. It never merges anything itself (doc 23, X7).
 *
 * DRY RUN BY DEFAULT. Nothing is written without --apply. On production, run
 * the dry run first, read the counts, and get an explicit go-ahead before
 * --apply: it rewrites customer data across every table listed in
 * merge-references.ts.
 *
 *   pnpm --filter @aura/api build           # the repoint logic lives in the API
 *   node scripts/repair-merged-references.js                  # dry run, every active org
 *   node scripts/repair-merged-references.js <org-uuid>       # dry run, one org
 *   node scripts/repair-merged-references.js --apply [org]    # write
 *
 * Safe to re-run: a repaired record has nothing left to move, and a queued
 * duplicate pair is skipped by duplicate_matches' own unique pair.
 */
const path = require("node:path");

const { withOrgContext, getAdminPool, closeAllPools } = require("../packages/db/dist/index.js");

const referencesModule = path.join(__dirname, "../apps/api/dist/modules/merge/merge-references.js");
let MERGE_REFERENCES;
let repointReferences;
try {
  ({ MERGE_REFERENCES, repointReferences } = require(referencesModule));
} catch {
  console.error(`cannot load ${referencesModule}\nRun: pnpm --filter @aura/api build`);
  process.exit(1);
}

const TABLE = { contact: "contacts", account: "accounts" };
const MAX_HOPS = 10;

/** The live record at the end of a merge chain, or null if the chain is broken. */
async function liveEnd(client, table, startId) {
  let id = startId;
  for (let hop = 0; id && hop < MAX_HOPS; hop++) {
    const {
      rows: [row],
    } = await client.query(`SELECT id, status, merged_into_id FROM ${table} WHERE id = $1`, [id]);
    if (!row) return null;
    if (row.status !== "merged") return row.id;
    id = row.merged_into_id;
  }
  return null;
}

/** How many rows still point at a merged record, per `table.column`. */
async function strandedCounts(client, objectType) {
  const counts = {};
  for (const ref of MERGE_REFERENCES[objectType]) {
    const {
      rows: [row],
    } = await client.query(
      `SELECT count(*)::int AS n
         FROM ${ref.table} x
         JOIN ${TABLE[objectType]} m ON m.id = x.${ref.column}
        WHERE m.status = 'merged'`,
    );
    if (row.n > 0) counts[`${ref.table}.${ref.column}`] = row.n;
  }
  return counts;
}

/** Live contacts sharing a number with a tombstone that merged into someone else. */
async function recreatedDuplicates(client) {
  const { rows } = await client.query(
    `SELECT DISTINCT live.id AS live_id, dead.merged_into_id AS merged_into
       FROM contacts live
       JOIN contacts dead
         ON dead.org_id = live.org_id AND dead.phone_hash = live.phone_hash
      WHERE dead.status = 'merged' AND live.status <> 'merged'
        AND dead.merged_into_id IS NOT NULL AND live.id <> dead.merged_into_id`,
  );
  return rows;
}

async function repairOrg(orgId, apply) {
  return withOrgContext(orgId, async (client) => {
    const report = { stranded: {}, repointed: {}, duplicatesFound: 0, duplicatesQueued: 0, brokenChains: 0 };

    for (const objectType of ["contact", "account"]) {
      report.stranded[objectType] = await strandedCounts(client, objectType);
      if (!apply) continue;

      const { rows: tombstones } = await client.query(
        `SELECT id, merged_into_id FROM ${TABLE[objectType]}
          WHERE status = 'merged' ORDER BY updated_at ASC`,
      );
      for (const tomb of tombstones) {
        const survivor = await liveEnd(client, TABLE[objectType], tomb.merged_into_id);
        if (!survivor) {
          report.brokenChains++;
          console.error(`  ${objectType} ${tomb.id}: merge chain does not end at a live record - left alone`);
          continue;
        }
        const { reassigned, dropped } = await repointReferences(client, objectType, survivor, tomb.id);
        const moved = Object.values(reassigned).reduce((n, ids) => n + ids.length, 0);
        if (moved === 0 && Object.keys(dropped).length === 0) continue;

        for (const [key, ids] of Object.entries(reassigned)) {
          report.repointed[key] = (report.repointed[key] ?? 0) + ids.length;
        }

        // Fold the moves into the merge's own log while it can still be
        // reverted, so a revert undoes the repair too.
        await client.query(
          `UPDATE merge_log
              SET reassigned_refs = reassigned_refs || $2::jsonb,
                  dropped_refs    = dropped_refs    || $3::jsonb
            WHERE id = (
              SELECT id FROM merge_log
               WHERE victim_id = $1 AND reverted_at IS NULL AND revert_deadline_at > now()
               ORDER BY performed_at DESC LIMIT 1)`,
          [tomb.id, JSON.stringify(reassigned), JSON.stringify(dropped)],
        );
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'system', 'repair-merged-references', 'merge.repair_references', $2, $3, $4::jsonb)`,
          [
            orgId,
            objectType,
            survivor,
            JSON.stringify({
              victimId: tomb.id,
              moved: Object.fromEntries(Object.entries(reassigned).map(([k, ids]) => [k, ids.length])),
            }),
          ],
        );
      }
    }

    const duplicates = await recreatedDuplicates(client);
    report.duplicatesFound = duplicates.length;
    if (apply) {
      for (const dup of duplicates) {
        const survivor = await liveEnd(client, "contacts", dup.merged_into);
        if (!survivor || survivor === dup.live_id) continue;
        const [a, b] = [dup.live_id, survivor].sort();
        const { rowCount } = await client.query(
          `INSERT INTO duplicate_matches (org_id, object_type, record_a_id, record_b_id, match_reason, score)
           VALUES ($1, 'contact', $2, $3, 'phone', 1)
           ON CONFLICT (org_id, object_type, record_a_id, record_b_id) DO NOTHING`,
          [orgId, a, b],
        );
        report.duplicatesQueued += rowCount ?? 0;
      }
    }
    return report;
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const only = process.argv.slice(2).find((arg) => !arg.startsWith("--"));

  const { rows: orgs } = await getAdminPool().query(
    only
      ? "SELECT id, name FROM organizations WHERE id = $1"
      : "SELECT id, name FROM organizations WHERE status = 'active' ORDER BY created_at",
    only ? [only] : [],
  );
  if (orgs.length === 0) {
    console.error(only ? `no organization ${only}` : "no active organizations");
    process.exit(1);
  }

  console.log(apply ? "APPLYING repairs" : "DRY RUN - nothing will be written (pass --apply to write)");
  for (const org of orgs) {
    const report = await repairOrg(org.id, apply);
    console.log(`\n${org.name} (${org.id})`);
    console.log("  still attached to merged records:", JSON.stringify(report.stranded));
    if (apply) {
      console.log("  repointed:", JSON.stringify(report.repointed));
      if (report.brokenChains > 0) console.log(`  broken merge chains left alone: ${report.brokenChains}`);
    }
    console.log(
      `  recreated duplicates: ${report.duplicatesFound}` +
        (apply ? ` (${report.duplicatesQueued} newly queued for review)` : ""),
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
