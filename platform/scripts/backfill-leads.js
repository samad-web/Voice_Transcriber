/**
 * Backfill the lead pipeline from calls that were processed before leads
 * existed.
 *
 * The worker projects a lead as part of the pipeline, so only calls completed
 * after that shipped have one. A customer onboarded earlier would open their
 * board to an empty pipeline despite months of history - this replays the same
 * projection over their finished calls.
 *
 * Safe to re-run: upsertLead dedupes on the counterparty number and recomputes
 * call_count from the calls table, so a second pass changes nothing.
 *
 *   pnpm --filter @aura/worker build      # the projection lives in the worker
 *   node scripts/backfill-leads.js                 # every active org
 *   node scripts/backfill-leads.js <org-uuid>      # one tenant
 */
const path = require("node:path");

const { withOrgContext, getAdminPool, closeAllPools } = require("../packages/db/dist/index.js");

const leadsModule = path.join(__dirname, "../apps/worker/dist/pipeline/leads.js");
let upsertLead;
try {
  ({ upsertLead } = require(leadsModule));
} catch {
  console.error(
    `cannot load ${leadsModule}\nRun: pnpm --filter @aura/worker build`,
  );
  process.exit(1);
}

async function main() {
  const only = process.argv[2];
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

  for (const org of orgs) {
    // One transaction per org rather than per call: the projection is a single
    // upsert, and a partial backfill is easier to reason about at org grain.
    const summary = await withOrgContext(org.id, async (client) => {
      const { rows: calls } = await client.query(
        `SELECT c.id FROM calls c
          WHERE c.status = 'COMPLETE'
            AND EXISTS (SELECT 1 FROM call_facts f WHERE f.call_id = c.id)
          ORDER BY c.started_at ASC`,
      );

      let created = 0;
      let updated = 0;
      let skipped = 0;
      for (const call of calls) {
        try {
          const result = await upsertLead(client, org.id, call.id);
          if (!result.leadId) skipped++;
          else if (result.created) created++;
          else updated++;
        } catch (err) {
          skipped++;
          console.error(`  call ${call.id}: ${err.message}`);
        }
      }
      return { scanned: calls.length, created, updated, skipped };
    });

    console.log(
      `${org.name}: ${summary.scanned} completed call(s) → ${summary.created} new lead(s), ` +
        `${summary.updated} updated, ${summary.skipped} not qualified`,
    );
  }

  await closeAllPools();
}

main().catch(async (err) => {
  console.error(err);
  await closeAllPools().catch(() => {});
  process.exit(1);
});
