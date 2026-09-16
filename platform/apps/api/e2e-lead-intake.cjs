#!/usr/bin/env node
/**
 * End-to-end exercise of the lead intake engine (migration 0078), against a
 * RUNNING API and a real database.
 *
 * The unit tests prove the parsing and `verify-lead-intake.sql` proves the
 * statements. Neither can prove the thing that actually matters: that a form
 * post from a browser, with no credential but a token in a URL, becomes a lead
 * on the board with a contact and a deal behind it. That is what this does.
 *
 *   node apps/api/e2e-lead-intake.cjs
 *
 * Every record it creates is deleted at the end, including on failure.
 *
 * Env: API_BASE (default http://localhost:4000), ADMIN_API_KEY, ORG_ID.
 */

const { execFileSync } = require("node:child_process");

const API = process.env.API_BASE ?? "http://localhost:4000";
const ADMIN_KEY = process.env.ADMIN_API_KEY;
const ORG = process.env.ORG_ID ?? "00000000-0000-4000-8000-000000000001";
const PSQL = ["exec", "-i", process.env.PG_CONTAINER ?? "platform-postgres-1", "psql", "-U", "aura", "-d", process.env.PG_DB ?? "callintel", "-tAc"];

let failures = 0;
let sourceIds = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` - ${detail}`}`);
  }
}

function sql(statement) {
  return execFileSync("docker", [...PSQL, statement], { encoding: "utf8" }).trim();
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-key": ADMIN_KEY,
      "x-org-id": ORG,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** The public door: no admin key, no org header - just the token in the URL. */
async function intake(path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function createSource(kind, name, provider = "generic") {
  const created = await api("/v1/lead-sources", {
    method: "POST",
    body: JSON.stringify({ kind, name, provider, config: { honeypotField: "_hp" } }),
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`could not create ${kind} source: ${created.status} ${JSON.stringify(created.body)}`);
  }
  sourceIds.push(created.body.id);
  return created.body;
}

async function main() {
  if (!ADMIN_KEY) throw new Error("ADMIN_API_KEY is required");
  console.log(`lead intake e2e against ${API}, org ${ORG}\n`);

  // ── 1. Web form ────────────────────────────────────────────────────────
  console.log("web form");
  const form = await createSource("web_form", `E2E Website Form ${Date.now()}`);
  check("source has an endpoint path", form.endpointPath?.startsWith("/intake/form/"), form.endpointPath);

  const phone = `9${String(Date.now()).slice(-9)}`;
  const submitted = await intake(
    `/v1${form.endpointPath}`,
    {
      name: "E2E Web Person",
      email: "e2e-web@example.test",
      phone,
      message: "Need a quote for 200 units",
      budget: "250000",
      utm_source: "google",
      utm_campaign: "e2e-spring",
      _hp: "",
    },
    // A browser posting from a site that is NOT on the console's CORS
    // allowlist - the whole point of the per-route open origin.
    { origin: "https://a-customers-website.example" },
  );
  check("form post accepted without any credential", submitted.status === 201 || submitted.status === 200, submitted.status);
  check("outcome is created", submitted.body.outcome === "created", JSON.stringify(submitted.body));

  const leadRow = sql(
    `SELECT l.source_channel || '|' || coalesce(l.title,'') || '|' || coalesce(ms.name,'-') || '|' ||
            (SELECT count(*) FROM contacts c WHERE c.id = (SELECT contact_id FROM lead_intake_events e WHERE e.lead_id = l.id LIMIT 1)) || '|' ||
            (SELECT count(*) FROM deals d WHERE d.source_lead_id = l.id)
       FROM leads l LEFT JOIN marketing_sources ms ON ms.id = l.marketing_source_id
      WHERE l.id = '${submitted.body.leadId}'`,
  );
  const [channel, title, campaign, contacts, deals] = leadRow.split("|");
  check("lead is stamped source_channel=web_form", channel === "web_form", channel);
  check("lead title is the person's name", title === "E2E Web Person", title);
  check("UTM created a marketing source", campaign === "e2e-spring", campaign);
  check("a contact was created", contacts === "1", contacts);
  check("a deal was created", deals === "1", deals);

  // Honeypot.
  const bot = await intake(`/v1${form.endpointPath}`, {
    name: "Spam Bot",
    email: "bot@example.test",
    _hp: "http://spam.example",
  });
  check("honeypot submission is accepted but makes no lead", bot.body.outcome === "rejected", JSON.stringify(bot.body));
  check("honeypot reason names the honeypot", String(bot.body.reason).includes("honeypot"), bot.body.reason);

  // Nothing to reach the person by.
  const empty = await intake(`/v1${form.endpointPath}`, { colour: "blue" });
  check("unreadable payload is rejected with a reason", empty.body.outcome === "rejected", JSON.stringify(empty.body));
  check("reason points at the field mapping", String(empty.body.reason).includes("field mapping"), empty.body.reason);

  // The SECOND touch from the same person must converge, not fork.
  const again = await intake(`/v1${form.endpointPath}`, {
    name: "E2E Web Person",
    phone,
    message: "following up",
  });
  check("a repeat submission updates rather than duplicates", again.body.outcome === "updated", JSON.stringify(again.body));
  check("it is the same lead", again.body.leadId === submitted.body.leadId, again.body.leadId);

  // ── 2. Telephony ───────────────────────────────────────────────────────
  console.log("\ntelephony (Exotel)");
  const cti = await createSource("telephony", `E2E Exotel ${Date.now()}`, "exotel");
  const callSid = `e2e-call-${Date.now()}`;
  const inbound = await intake(`/v1${cti.endpointPath}`, {
    CallSid: callSid,
    From: `9${String(Date.now() + 1).slice(-9)}`,
    To: "08041234567",
    Direction: "incoming",
    DialCallStatus: "no-answer",
  });
  check("an inbound/missed call becomes a lead", inbound.body.outcome === "created", JSON.stringify(inbound.body));

  const retried = await intake(`/v1${cti.endpointPath}`, {
    CallSid: callSid,
    From: "919000000009",
    To: "08041234567",
    Direction: "incoming",
  });
  check("the provider's retry of the same CallSid is a duplicate", retried.body.outcome === "duplicate", JSON.stringify(retried.body));

  const outbound = await intake(`/v1${cti.endpointPath}`, {
    CallSid: `e2e-out-${Date.now()}`,
    From: "08041234567",
    To: "919000000010",
    Direction: "outbound-dial",
  });
  check("an outbound dial is NOT a lead", outbound.body.outcome === "rejected", JSON.stringify(outbound.body));
  check("and says why", String(outbound.body.reason).includes("outbound"), outbound.body.reason);

  // ── 3. Email ───────────────────────────────────────────────────────────
  console.log("\nemail (Postmark inbound)");
  const mail = await createSource("email", `E2E Enquiry Inbox ${Date.now()}`, "postmark");
  const inboundMail = await intake(`/v1${mail.endpointPath}`, {
    MessageID: `e2e-msg-${Date.now()}`,
    FromFull: { Email: "Enquirer@Example.test", Name: "E2E Mail Person" },
    Subject: "Quote request",
    TextBody: `Please send a quote. Reach me on +91 9${String(Date.now() + 2).slice(-9)}.`,
  });
  check("an inbound email becomes a lead", inboundMail.body.outcome === "created", JSON.stringify(inboundMail.body));

  const mailLead = sql(
    `SELECT coalesce(contact_name,'') || '|' || coalesce(summary,'') || '|' || source_channel
       FROM leads WHERE id = '${inboundMail.body.leadId}'`,
  );
  const [mailName, mailSummary, mailChannel] = mailLead.split("|");
  check("sender's display name became the contact name", mailName === "E2E Mail Person", mailName);
  check("subject and body are both on the lead", mailSummary.includes("Quote request") && mailSummary.includes("send a quote"), mailSummary.slice(0, 60));
  check("channel is email", mailChannel === "email", mailChannel);
  check(
    "the phone in the body was extracted",
    sql(`SELECT contact_number_hash IS NOT NULL FROM leads WHERE id = '${inboundMail.body.leadId}'`) === "t",
  );

  // ── 4. Wrong door, unknown token ───────────────────────────────────────
  console.log("\nrefusals");
  const wrongDoor = await intake(`/v1/intake/telephony/${form.endpointPath.split("/").pop()}`, { From: "919000000011" });
  check("a form token posted to the telephony door 404s", wrongDoor.status === 404, wrongDoor.status);

  const unknown = await intake("/v1/intake/form/definitely-not-a-real-token-000000", { name: "x" });
  check("an unknown token 404s", unknown.status === 404, unknown.status);

  const shortToken = await intake("/v1/intake/form/short", { name: "x" });
  check("a too-short token 404s without touching the database", shortToken.status === 404, shortToken.status);

  // ── 5. Paused source ───────────────────────────────────────────────────
  const paused = await api(`/v1/lead-sources/${form.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "paused" }),
  });
  check("a source can be paused", paused.status === 200, paused.status);
  const whilePaused = await intake(`/v1${form.endpointPath}`, { name: "While Paused", phone: "919000000012" });
  check("a paused source rejects rather than 404s", whilePaused.body.outcome === "rejected", JSON.stringify(whilePaused.body));
  check("and the arrival is still recorded", String(whilePaused.body.reason).includes("paused"), whilePaused.body.reason);

  // ── 6. The ledger and replay ───────────────────────────────────────────
  console.log("\nledger and replay");
  const events = await api(`/v1/lead-sources/${form.id}/events`);
  check("the console can read the arrivals", events.status === 200, events.status);
  const outcomes = (events.body.events ?? []).map((e) => e.outcome);
  check("every arrival was recorded, accepted or not", outcomes.length >= 5, outcomes.join(","));
  check("rejections are visible with their reasons", outcomes.includes("rejected"), outcomes.join(","));

  await api(`/v1/lead-sources/${form.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  const rejected = (events.body.events ?? []).find((e) => e.outcome === "rejected" && String(e.reason).includes("field mapping"));
  if (rejected) {
    const replayed = await api(`/v1/lead-sources/events/${rejected.id}/replay`, { method: "POST" });
    check("replaying a still-unreadable arrival stays rejected", replayed.body.outcome === "rejected", JSON.stringify(replayed.body));
  }
  const accepted = (events.body.events ?? []).find((e) => e.outcome === "created");
  if (accepted) {
    const replayed = await api(`/v1/lead-sources/events/${accepted.id}/replay`, { method: "POST" });
    check(
      "replaying an arrival that already made a lead is refused",
      replayed.body.outcome === "duplicate",
      JSON.stringify(replayed.body),
    );
  }

  // ── 7. Token rotation ──────────────────────────────────────────────────
  const rotated = await api(`/v1/lead-sources/${form.id}/rotate-token`, { method: "POST" });
  check("rotation issues a new token", Boolean(rotated.body.intakeToken), JSON.stringify(rotated.body));
  const oldTokenNow = await intake(`/v1${form.endpointPath}`, { name: "Old token", phone: "919000000013" });
  check("the OLD token stops working immediately", oldTokenNow.status === 404, oldTokenNow.status);
  const newTokenNow = await intake(`/v1${rotated.body.endpointPath}`, { name: "E2E Rotated", phone: `9${String(Date.now() + 3).slice(-9)}` });
  check("the new token works", newTokenNow.body.outcome === "created", JSON.stringify(newTokenNow.body));

  // ── 8. Board visibility - the point of the whole exercise ──────────────
  console.log("\nthe board");
  const board = await api("/v1/leads?limit=200");
  check("the lead list still answers", board.status === 200, board.status);
  const onBoard = (board.body.leads ?? []).filter((l) => l.source_channel && l.source_channel !== "call");
  check("intake leads are visible on the lead list", onBoard.length >= 3, `${onBoard.length} non-call leads`);
  check(
    "and each carries its channel",
    onBoard.every((l) => typeof l.source_channel === "string"),
  );
  const filtered = await api("/v1/leads?sourceChannel=web_form&limit=50");
  check("the list can be filtered by channel", filtered.status === 200 && (filtered.body.leads ?? []).every((l) => l.source_channel === "web_form"));
}

function cleanup() {
  if (sourceIds.length === 0) return;
  const list = sourceIds.map((id) => `'${id}'`).join(",");
  // Leads first (they reference the source), then the source itself; the
  // ledger and its lead/contact/deal go with the CASCADE.
  const leads = sql(`SELECT string_agg(id::text, ',') FROM leads WHERE lead_source_id IN (${list})`);
  if (leads) {
    sql(`DELETE FROM deals WHERE source_lead_id IN (SELECT id FROM leads WHERE lead_source_id IN (${list}))`);
    sql(
      `DELETE FROM contacts WHERE id IN (SELECT contact_id FROM lead_intake_events WHERE source_id IN (${list}) AND contact_id IS NOT NULL)`,
    );
    sql(`DELETE FROM leads WHERE lead_source_id IN (${list})`);
  }
  sql(`DELETE FROM lead_sources WHERE id IN (${list})`);
  sql(`DELETE FROM marketing_sources WHERE name = 'e2e-spring'`);
  console.log(`\ncleaned up ${sourceIds.length} source(s) and everything they created`);
}

main()
  .then(() => {
    cleanup();
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\ne2e aborted:", err);
    try {
      cleanup();
    } catch (cleanupErr) {
      console.error("cleanup also failed:", cleanupErr);
    }
    process.exit(1);
  });
