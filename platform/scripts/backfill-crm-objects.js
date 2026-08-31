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
 * that lands (a later, separate milestone) - backfill and live projection
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
let projectCallToInteraction;
try {
  ({ projectLeadToCrm, projectCallToInteraction } = require(crmObjectsModule));
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
      // ── Pass 2: the rest of the timeline (A2) ──────────────────────────
      // projectLeadToCrm only knows a lead's first and last call, so pass 1
      // has already placed those two. Every OTHER call from the same number
      // is reached here, by matching the hash the contact was deduped on.
      //
      // Deliberately keyed on the contact rather than walking `calls` blind:
      // a call from a number that never qualified as a lead has no CRM object
      // to attach to, and inventing one here would quietly widen what counts
      // as a contact - which is the cutover's decision to make, not the
      // backfill's.
      const { rows: contacts } = await client.query(
        `SELECT id, phone_hash FROM contacts
          WHERE phone_hash IS NOT NULL AND status <> 'merged'`,
      );

      let timelineCreated = 0;
      let timelineSkipped = 0;
      for (const contact of contacts) {
        // The deal to attach these to: the one this contact already owns.
        // LIMIT 1 because a contact can own several (one per source lead) and
        // a historical call cannot be attributed to a particular one - the
        // contact timeline is the honest home for it either way.
        const {
          rows: [deal],
        } = await client.query(
          `SELECT id FROM deals WHERE contact_id = $1 ORDER BY created_at ASC LIMIT 1`,
          [contact.id],
        );
        const { rows: calls } = await client.query(
          `SELECT id FROM calls WHERE remote_number_hash = $1 ORDER BY started_at ASC`,
          [contact.phone_hash],
        );
        for (const call of calls) {
          try {
            const result = await projectCallToInteraction(
              client,
              org.id,
              call.id,
              contact.id,
              deal ? deal.id : null,
            );
            if (result === "created") timelineCreated++;
          } catch (err) {
            timelineSkipped++;
            console.error(`  call ${call.id}: ${err.message}`);
          }
        }
      }

      return {
        scanned: leads.length,
        contactsCreated,
        dealsCreated,
        updated,
        skipped,
        timelineCreated,
        timelineSkipped,
      };
    });

    console.log(
      `${org.name}: ${summary.scanned} lead(s) → ${summary.dealsCreated} new deal(s) ` +
        `(${summary.contactsCreated} contact upserts), ${summary.updated} updated, ${summary.skipped} skipped; ` +
        `timeline: ${summary.timelineCreated} new interaction(s), ${summary.timelineSkipped} failed`,
    );
  }

  await closeAllPools();
}

main().catch(async (err) => {
  console.error(err);
  await closeAllPools().catch(() => {});
  process.exit(1);
});
