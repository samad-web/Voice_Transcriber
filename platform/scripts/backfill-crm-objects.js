/**
 * Backfill the new Contact/Deal object model (packages/db/migrations/0035-
 * 0036, CRM Phase 1 foundation) from the existing `leads` table.
 *
 * Structurally identical to backfill-leads.js, one layer up: that script
 * replays call_facts into `leads` for calls processed before leads existed;
 * this one replays `leads` into contacts/deals for leads that existed before
 * this migration did. Neither writes to the other's source table.
 *
 * Calls the SAME projectLeadToCrm() the live worker dual-write will call once
 * that lands (a later, separate milestone) — backfill and live projection
 * read from one definition and can never drift from each other.
 *
 * Safe to re-run: projectLeadToCrm dedupes contacts on (org_id, phone_hash)
 * and deals on source_lead_id, and recomputes call_count rather than
 * incrementing it, so a second pass changes nothing.
 *
 *   pnpm --filter @aura/worker build           # the projection lives in the worker
 *   node scripts/backfill-crm-objects.js                # every active org
 *   node scripts/backfill-crm-objects.js <org-uuid>      # one tenant
 */
const path = require("node:path");

const { withOrgContext, getAdminPool, closeAllPools } = require("../packages/db/dist/index.js");

const crmObjectsModule = path.join(__dirname, "../apps/worker/dist/pipeline/crm-objects.js");
let projectLeadToCrm;
try {
  ({ projectLeadToCrm } = require(crmObjectsModule));
} catch {
  console.error(`cannot load ${crmObjectsModule}\nRun: pnpm --filter @aura/worker build`);
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
    // One transaction per org, same grain backfill-leads.js uses: a partial
    // backfill is easier to reason about at org grain than at row grain.
    const summary = await withOrgContext(org.id, async (client) => {
      const { rows: leads } = await client.query(`SELECT id FROM leads ORDER BY created_at ASC`);

      let contactsCreated = 0;
      let dealsCreated = 0;
      let updated = 0;
      let skipped = 0;
      for (const lead of leads) {
        try {
          const result = await projectLeadToCrm(client, org.id, lead.id);
          if (!result.dealId) {
            skipped++;
            console.error(`  lead ${lead.id}: ${result.reason}`);
            continue;
          }
          if (result.reason === "created") dealsCreated++;
          else updated++;
          if (result.contactId) contactsCreated++;
        } catch (err) {
          skipped++;
          console.error(`  lead ${lead.id}: ${err.message}`);
        }
      }
      return { scanned: leads.length, contactsCreated, dealsCreated, updated, skipped };
    });

    console.log(
      `${org.name}: ${summary.scanned} lead(s) → ${summary.dealsCreated} new deal(s) ` +
        `(${summary.contactsCreated} contact upserts), ${summary.updated} updated, ${summary.skipped} skipped`,
    );
  }

  await closeAllPools();
}

main().catch(async (err) => {
  console.error(err);
  await closeAllPools().catch(() => {});
  process.exit(1);
});
