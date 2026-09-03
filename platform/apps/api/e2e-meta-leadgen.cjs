#!/usr/bin/env node
/**
 * Prove the fix that migration 0078 exists for: a Facebook lead ad reaching
 * the LEAD BOARD.
 *
 * Since 0063 the Meta webhook created a contact and a deal and NO `leads` row,
 * and `/owner/board` and `/owner/leads` read `leads` - so every Meta lead ever
 * captured was invisible on the two pages an owner actually works in. That is
 * not a claim a unit test can settle, because it depends on Graph, on the
 * webhook signature, on the org resolution and on the write path all agreeing.
 *
 * So this stands up a stub Graph API (META_GRAPH_BASE_URL is overridable for
 * exactly this reason), inserts a Page connection, posts a properly signed
 * leadgen webhook, and then asks the database the only question that matters:
 * is there a row on `leads`?
 *
 *   node apps/api/e2e-meta-leadgen.cjs
 *
 * Requires the API to be running with META_APP_SECRET and META_GRAPH_BASE_URL
 * pointing at this script's stub port. Everything it creates is deleted at the
 * end, including on failure.
 */

const { createHmac } = require("node:crypto");
const { createServer } = require("node:http");
const { execFileSync } = require("node:child_process");
const { encryptSecret } = require("@aura/db");

const API = process.env.API_BASE ?? "http://localhost:4000";
const ORG = process.env.ORG_ID ?? "00000000-0000-4000-8000-000000000001";
const APP_SECRET = process.env.META_APP_SECRET ?? "e2e-meta-app-secret";
const STUB_PORT = Number(process.env.META_STUB_PORT ?? 4599);
const PAGE_ID = `e2e-page-${Date.now()}`;
const LEADGEN_ID = `e2e-leadgen-${Date.now()}`;
const PSQL = ["exec", "-i", process.env.PG_CONTAINER ?? "platform-postgres-1", "psql", "-U", "aura", "-d", process.env.PG_DB ?? "callintel", "-tAc"];

let failures = 0;

function check(name, condition, detail) {
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` - ${detail}`}`);
  }
}

function sql(statement) {
  return execFileSync("docker", [...PSQL, statement], { encoding: "utf8" }).trim();
}

/** Graph's answer for the leadgen node, in Meta's own `field_data` shape. */
const STUB_LEAD = {
  id: LEADGEN_ID,
  created_time: new Date().toISOString(),
  form_id: "e2e-form",
  campaign_name: "E2E Spring Campaign",
  ad_name: "E2E Ad",
  field_data: [
    { name: "full_name", values: ["E2E Meta Person"] },
    { name: "email", values: ["e2e-meta@example.test"] },
    { name: "phone_number", values: [`+91 9${String(Date.now()).slice(-9)}`] },
    { name: "what_do_you_need", values: ["A 3D website for our showroom"] },
  ],
};

function startStubGraph() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(STUB_LEAD));
    });
    server.listen(STUB_PORT, () => resolve(server));
  });
}

async function main() {
  console.log(`meta leadgen e2e against ${API}, stub graph on :${STUB_PORT}\n`);
  const stub = await startStubGraph();

  try {
    sql(
      `INSERT INTO meta_connections (org_id, page_id, page_name, access_token, status)
       VALUES ('${ORG}', '${PAGE_ID}', 'E2E Page', '${encryptSecret("stub-page-token").replace(/'/gu, "''")}', 'connected')`,
    );

    const body = JSON.stringify({
      object: "page",
      entry: [{ id: PAGE_ID, changes: [{ field: "leadgen", value: { leadgen_id: LEADGEN_ID, page_id: PAGE_ID, form_id: "e2e-form" } }] }],
    });
    const signature = `sha256=${createHmac("sha256", APP_SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`;

    const res = await fetch(`${API}/v1/meta/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body,
    });
    check("webhook answers 2xx", res.ok, res.status);

    // The handler processes the lead without blocking its own response, which
    // is correct for a provider that retries - so give it a moment to land.
    await new Promise((r) => setTimeout(r, 1500));

    const claimed = sql(`SELECT count(*) FROM meta_leadgen_events WHERE leadgen_id = '${LEADGEN_ID}'`);
    check("the leadgen event was claimed", claimed === "1", claimed);

    // THE POINT OF THE WHOLE MIGRATION.
    const leadRow = sql(
      `SELECT l.id || '|' || l.source_channel || '|' || coalesce(l.contact_name,'') || '|' ||
              coalesce(ls.name,'-') || '|' || coalesce(l.summary,'')
         FROM leads l
         LEFT JOIN lead_sources ls ON ls.id = l.lead_source_id
        WHERE l.id = (SELECT lead_id FROM lead_intake_events WHERE external_id = '${LEADGEN_ID}')`,
    );
    check("a LEADS row exists for the ad lead", leadRow.length > 0, "(this is the bug 0078 fixes)");

    if (leadRow) {
      const [leadId, channel, name, sourceName, summary] = leadRow.split("|");
      check("stamped source_channel=meta_ads", channel === "meta_ads", channel);
      check("carries the person's name", name === "E2E Meta Person", name);
      check("attributed to a managed lead source", sourceName === "Facebook Lead Ads", sourceName);
      check("the form answer is on the lead", summary.includes("3D website"), summary.slice(0, 60));

      const projected = sql(
        `SELECT (SELECT count(*) FROM contacts c
                  WHERE c.id = (SELECT contact_id FROM lead_intake_events
                                 WHERE external_id = '${LEADGEN_ID}')) || '|' ||
                (SELECT count(*) FROM deals d WHERE d.source_lead_id = '${leadId}')`,
      );
      const [contacts, deals] = projected.split("|");
      check("a contact was created", contacts === "1", contacts);
      check("a deal was created", deals === "1", deals);

      const linked = sql(
        `SELECT (contact_id IS NOT NULL) || '|' || (deal_id IS NOT NULL) FROM meta_leadgen_events WHERE leadgen_id = '${LEADGEN_ID}'`,
      );
      check("meta_leadgen_events still points at the contact and deal", linked === "true|true", linked);
    }

    // Meta retries aggressively; a second delivery must not make a second lead.
    const again = await fetch(`${API}/v1/meta/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body,
    });
    check("a redelivery answers 2xx", again.ok, again.status);
    await new Promise((r) => setTimeout(r, 1000));
    const leadCount = sql(`SELECT count(*) FROM lead_intake_events WHERE external_id = '${LEADGEN_ID}'`);
    check("redelivery did not create a second lead", leadCount === "1", leadCount);

    // A bad signature must be silently dropped - no lead, no disclosure.
    const forged = await fetch(`${API}/v1/meta/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      body,
    });
    check("a forged signature still answers 2xx (never discloses)", forged.ok, forged.status);
  } finally {
    stub.close();
    const leadIds = sql(`SELECT string_agg(lead_id::text, ',') FROM lead_intake_events WHERE external_id = '${LEADGEN_ID}' AND lead_id IS NOT NULL`);
    if (leadIds) {
      const ids = `'${leadIds.split(",").join("','")}'`;
      sql(`DELETE FROM deals WHERE source_lead_id IN (${ids})`);
      sql(`DELETE FROM contacts WHERE source_lead_id IN (${ids})`);
      sql(`DELETE FROM leads WHERE id IN (${ids})`);
    }
    sql(`DELETE FROM marketing_sources WHERE name = 'E2E Spring Campaign'`);
    sql(`DELETE FROM meta_leadgen_events WHERE leadgen_id = '${LEADGEN_ID}'`);
    sql(`DELETE FROM lead_sources WHERE org_id = '${ORG}' AND kind = 'meta_ads' AND name = 'Facebook Lead Ads'`);
    sql(`DELETE FROM meta_connections WHERE page_id = '${PAGE_ID}'`);
    console.log("\ncleaned up the stub Page, its lead and its source");
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\ne2e aborted:", err);
    process.exit(1);
  });
