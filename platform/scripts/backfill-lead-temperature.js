/**
 * Rate the leads that already existed when migration 0083 shipped.
 *
 * The worker rates a lead as it projects it, so only leads touched by a call
 * AFTER 0083 get one. Everything already on the board would sit unrated -
 * which, on a tenant with three hundred leads and no new calls this week, is
 * indistinguishable from the feature not working. This replays the same
 * derivation over the call each lead already points at.
 *
 * ── WHY A SCRIPT AND NOT SQL IN THE MIGRATION ─────────────────────────────
 *
 * `deriveLeadTemperature` is thirty lines of precedence rules - a polite
 * refusal outranks positive sentiment, a named figure outranks a neutral
 * outcome - and every one of them is unit-tested in packages/shared. Writing
 * that a second time as a CASE expression inside a migration would mean two
 * definitions of "hot" that agree only until someone edits one. So the
 * migration adds the column and this reads the real function.
 *
 * Safe to re-run, and safe to run while the worker is live:
 *   - only rows still marked `temperature_source = 'auto'` are considered, so
 *     a rating somebody chose in the console is never touched;
 *   - only rows with no rating yet are written, so a second pass is a no-op
 *     and a rating a live call set in the meantime is left alone;
 *   - a lead whose call said nothing either way is skipped, not blanked.
 *
 *   pnpm --filter @aura/shared build
 *   node scripts/backfill-lead-temperature.js --dry-run     # count only
 *   node scripts/backfill-lead-temperature.js               # every active org
 *   node scripts/backfill-lead-temperature.js <org-uuid>    # one tenant
 */
const path = require("node:path");

const { withOrgContext, getAdminPool, closeAllPools } = require("../packages/db/dist/index.js");

const sharedModule = path.join(__dirname, "../packages/shared/dist/index.js");
let deriveLeadTemperature;
try {
  ({ deriveLeadTemperature } = require(sharedModule));
} catch {
  console.error(`cannot load ${sharedModule}\nRun: pnpm --filter @aura/shared build`);
  process.exit(1);
}
if (typeof deriveLeadTemperature !== "function") {
  console.error("@aura/shared has no deriveLeadTemperature - is the build stale?");
  process.exit(1);
}

/**
 * The signals for one lead, read from the last call attached to it.
 *
 * `last_call_id` rather than the newest call to that number: it is the call
 * the lead's own summary and facts came from, so the rating describes the
 * same conversation the rest of the card does.
 */
const SELECT_LEADS = `
  SELECT l.id,
         l.value_num,
         t.intelligence ->> 'outcome'   AS outcome,
         t.intelligence ->> 'sentiment' AS sentiment
    FROM leads l
    LEFT JOIN transcripts t ON t.call_id = l.last_call_id
   WHERE l.temperature IS NULL
     AND l.temperature_source = 'auto'`;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const only = args.find((a) => !a.startsWith("--"));

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

  let totalRated = 0;
  let totalSkipped = 0;

  for (const org of orgs) {
    const counts = { hot: 0, medium: 0, cold: 0, skipped: 0 };

    await withOrgContext(org.id, async (client) => {
      const { rows } = await client.query(SELECT_LEADS);

      for (const lead of rows) {
        const temperature = deriveLeadTemperature({
          outcome: lead.outcome,
          sentiment: lead.sentiment,
          // value_num arrives from pg as a string for numeric columns.
          valueNum: lead.value_num === null ? null : Number(lead.value_num),
        });
        if (!temperature) {
          counts.skipped += 1;
          continue;
        }
        counts[temperature] += 1;
        if (dryRun) continue;

        // The WHERE repeats both guards. Between the SELECT above and this
        // UPDATE the worker may have rated the lead itself, or somebody may
        // have chosen a rating in the console; either way theirs wins.
        await client.query(
          `UPDATE leads SET temperature = $2
            WHERE id = $1 AND temperature IS NULL AND temperature_source = 'auto'`,
          [lead.id, temperature],
        );
      }
    });

    const rated = counts.hot + counts.medium + counts.cold;
    totalRated += rated;
    totalSkipped += counts.skipped;
    console.log(
      `${org.name}: ${rated} rated ` +
        `(${counts.hot} hot, ${counts.medium} medium, ${counts.cold} cold), ` +
        `${counts.skipped} left unrated`,
    );
  }

  console.log(
    `\n${dryRun ? "[dry run] would rate" : "rated"} ${totalRated} lead(s); ` +
      `${totalSkipped} had nothing to go on.`,
  );
}

main()
  .then(closeAllPools)
  .catch(async (err) => {
    console.error(err);
    await closeAllPools();
    process.exit(1);
  });
