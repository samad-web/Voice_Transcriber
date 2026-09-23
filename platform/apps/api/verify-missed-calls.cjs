/*
 * Missed calls (migration 0133) end to end against a real database: the
 * handset's POST /v1/calls/missed, the upload path's new number key and
 * duration clamp, the call log's Missed filter, and call insights' call-back
 * figures - each through the REAL compiled controller or query builder, never a
 * paraphrase of their SQL (a paraphrase only verifies the paraphrase).
 *
 * Nothing persists. It seeds a throwaway org inside ONE transaction, runs every
 * request as `aura_app` with `app.org_id` and the org's TimeZone set exactly as
 * withOrgContext does, and rolls the whole thing back. It must connect as a
 * role that may create rows and `SET ROLE aura_app` (the local `aura`
 * superuser does). Never point it at production.
 *
 *   pnpm --filter @aura/api build        (or: tsc -p tsconfig.build.json --outDir <dir>)
 *   DATABASE_URL=postgres://aura:<pw>@localhost:5433/callintel node apps/api/verify-missed-calls.cjs
 *   VERIFY_DIST=<dir> picks a build other than ./dist.
 */
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { Client } = require("pg");
const { phoneMatchDigits } = require("@aura/shared");

const DIST = process.env.VERIFY_DIST ?? "./dist";
const { CallsController } = require(join(__dirname, DIST, "modules/calls/calls.controller"));
const { OwnerCallsController } = require(join(__dirname, DIST, "modules/owner/owner-calls.controller"));
const { callInsightsBatch, assembleCallInsights } = require(join(__dirname, DIST, "modules/owner/call-insights.query"));

// The follow-ups (0134) live in the worker, not the API - `pnpm --filter
// @aura/worker build` first, or VERIFY_WORKER_DIST for a build elsewhere.
const WORKER_DIST = process.env.VERIFY_WORKER_DIST ?? join(__dirname, "../worker/dist");
const { createLeadFromMissedCall } = require(join(WORKER_DIST, "pipeline/missed-call-leads"));

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`);
  }
}
const sha = (s) => createHash("sha256").update(s).digest("hex");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  if (/supabase|pooler|sirahagents|187\.127/i.test(url)) throw new Error("refusing to run against what looks like production");
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("BEGIN");

  try {
    // ── Seed, as the connecting superuser ──────────────────────────────────
    const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
    const [org] = await q(
      `INSERT INTO organizations (name, reporting_timezone, enabled_modules, store_full_number)
       VALUES ('Verify Missed Calls', 'Asia/Kolkata', ARRAY['aura','crm','call_intel'], false) RETURNING id`,
    );
    const orgId = org.id;
    const [ws] = await q(`INSERT INTO workspaces (org_id, name) VALUES ($1, 'Sales') RETURNING id`, [orgId]);
    const [inst] = await q(`INSERT INTO instances (org_id, workspace_id, name) VALUES ($1, $2, 'Main') RETURNING id`, [orgId, ws.id]);
    // A console login for Priya, so section 9 can prove the missed-call
    // notification actually reaches somebody rather than being silently
    // skipped as "nobody to tell" - the same case an unbound telecaller is.
    const [priyaUser] = await q(`INSERT INTO users (email, name) VALUES ('priya.verify@example.invalid', 'Priya') RETURNING id`);
    const [priya] = await q(`INSERT INTO telecallers (org_id, display_name, user_id) VALUES ($1, 'Priya', $2) RETURNING id`, [orgId, priyaUser.id]);
    const [dev] = await q(
      `INSERT INTO devices (org_id, instance_id, public_key, label, telecaller_id, status)
       VALUES ($1, $2, 'verify-key', 'Handset 1', $3, 'active') RETURNING id`,
      [orgId, inst.id, priya.id],
    );

    // Everything below runs as a request would.
    await client.query("SET LOCAL ROLE aura_app");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await client.query(
      `SELECT set_config('TimeZone', COALESCE((SELECT reporting_timezone FROM organizations WHERE id = $1::uuid), 'Asia/Kolkata'), true)`,
      [orgId],
    );
    const db = { withOrg: async (_org, fn) => fn(client) };
    const s3 = {
      createMultipartUpload: async () => ({ uploadId: "verify-upload", partUrls: ["https://example.invalid/p1"], partSizeBytes: 5_242_880 }),
    };
    const calls = new CallsController(db, s3);
    const owner = new OwnerCallsController(db, s3, {});
    const req = { device: { deviceId: dev.id, orgId } };

    // ── 1. The handset's batch ─────────────────────────────────────────────
    console.log("POST /calls/missed");
    // All IST: 10 Jun 10:00, 11 Jun 11:00, 12 Jun 12:00 (withheld), 13 Jun 09:00.
    const batch = [
      { idempotencyKey: "missed-1", startedAt: "2026-06-10T04:30:00.000Z", reason: "unanswered", remoteNumber: "+91 98765 43210", remoteName: "Ravi Kumar" },
      { idempotencyKey: "missed-2", startedAt: "2026-06-11T05:30:00Z", reason: "declined", remoteNumber: "9876501234" },
      { idempotencyKey: "missed-3", startedAt: "2026-06-12T06:30:00.000Z", reason: "unanswered" },
      { idempotencyKey: "missed-4", startedAt: "2026-06-13T03:30:00.000Z", reason: "voicemail", remoteNumber: "09123456789" },
      // The same entry twice in one batch - ON CONFLICT must absorb it.
      { idempotencyKey: "missed-1", startedAt: "2026-06-10T04:30:00.000Z", reason: "unanswered", remoteNumber: "+91 98765 43210" },
    ];
    check("first send: four new, one in-batch duplicate", await calls.missed(req, { calls: batch }), { accepted: 4, duplicates: 1, skipped: 0 });
    check("replay of the whole batch is a no-op", await calls.missed(req, { calls: batch }), { accepted: 0, duplicates: 5, skipped: 0 });

    const rows = await q(
      `SELECT idempotency_key, direction, duration_s, status, missed_reason, consent_status, audio_source_used,
              remote_name, remote_number_prefix, remote_number_last3, remote_number_hash, remote_number_key,
              remote_number_full, telecaller_id, workspace_id,
              (SELECT count(*) FROM recordings r WHERE r.call_id = c.id)::int AS recordings
         FROM calls c WHERE device_id = $1 ORDER BY started_at`,
      [dev.id],
    );
    check("rows written", rows.length, 4);
    check(
      "each is incoming, 0 s, NO_AUDIO, from the call log, with no recording",
      rows.map((r) => [r.direction, r.duration_s, r.status, r.audio_source_used, r.consent_status, r.recordings]),
      Array(4).fill(["incoming", 0, "NO_AUDIO", "call_log", "not_required", 0]),
    );
    check("reasons kept", rows.map((r) => r.missed_reason), ["unanswered", "declined", "unanswered", "voicemail"]);
    check("attributed to the handset's telecaller and workspace", rows.every((r) => r.telecaller_id === priya.id && r.workspace_id === ws.id), true);
    check("number fragments for +91 98765 43210", [rows[0].remote_number_prefix, rows[0].remote_number_last3, rows[0].remote_name], ["91987", "210", "Ravi Kumar"]);
    check("hash is the raw digits, as it always was", rows[0].remote_number_hash, sha("919876543210"));
    check("key is the last ten digits", rows[0].remote_number_key, sha("9876543210"));
    check("full number withheld - the org did not opt in", rows[0].remote_number_full, null);
    check("a withheld caller has no number at all", [rows[2].remote_number_hash, rows[2].remote_number_key], [null, null]);

    // ── 2. The schema holds a missed row's shape ───────────────────────────
    console.log("constraints");
    await client.query("SAVEPOINT shape");
    let shapeError = null;
    try {
      await client.query(`UPDATE calls SET duration_s = 30 WHERE device_id = $1 AND idempotency_key = 'missed-1'`, [dev.id]);
    } catch (err) {
      shapeError = err.constraint;
    }
    await client.query("ROLLBACK TO SAVEPOINT shape");
    check("a missed call cannot be turned into an answered one", shapeError, "calls_missed_reason_shape_check");

    // ── 3. The upload path: same key across formats, and the 0 s clamp ─────
    console.log("POST /calls (upload path)");
    const upload = (over) =>
      calls.create(req, {
        idempotencyKey: `up-${Math.random()}`,
        direction: "outgoing",
        startedAt: "2026-06-10T04:55:00.000Z",
        durationS: 120,
        audioSourceUsed: "OEM · samsung",
        sha256: "a".repeat(64),
        bytes: 1000,
        consentPlayed: true,
        ...over,
      });
    // Rang Ravi back 25 minutes later, dialled in the NATIONAL form.
    await upload({ remoteNumber: "9876543210" });
    // The 11 Jun caller rang again at 15:00 IST and got through.
    await upload({ direction: "incoming", startedAt: "2026-06-11T09:30:00.000Z", durationS: 60, remoteNumber: "+91 98765 01234" });
    // A pick-up-and-drop the handset rounded to 0 s - answered, so never "missed".
    const drop = await upload({ direction: "incoming", startedAt: "2026-06-14T06:00:00.000Z", durationS: 0, remoteNumber: "9000011111" });
    const [dropRow] = await q(`SELECT duration_s, remote_number_key FROM calls WHERE id = $1`, [drop.callId]);
    check("an answered incoming call is stored as at least 1 s", dropRow.duration_s, 1);
    check("the upload path writes the same key", dropRow.remote_number_key, sha("9000011111"));

    // A row from before 0133: hash only, no key - the fallback branch.
    await q(
      `INSERT INTO calls (org_id, workspace_id, device_id, direction, started_at, duration_s, status, remote_number_hash, remote_number_last3)
       VALUES ($1, $2, $3, 'incoming', '2026-06-15T05:00:00Z', 0, 'COMPLETE', $4, '555'),
              ($1, $2, $3, 'outgoing', '2026-06-15T05:30:00Z', 45, 'COMPLETE', $4, '555')`,
      [orgId, ws.id, dev.id, sha("8888855555")],
    );

    // ── 4. The call log's Missed filter ────────────────────────────────────
    console.log("GET /owner/calls?missed=");
    const list = (missed) => owner.list(orgId, { missed, from: "2026-06-01", to: "2026-06-30" });
    const all = await list("all");
    check("all missed", all.total, 5);
    const waiting = await list("waiting");
    check("not called back: only the voicemail caller (withheld has no number)", waiting.calls.map((c) => c.remote_number_last3), ["789"]);
    const returned = await list("returned");
    check("recovered", returned.total, 3);
    const byLast3 = Object.fromEntries(all.calls.map((c) => [c.remote_number_last3 ?? "none", c]));
    check("Ravi was called back by us - matched across +91 and national form", byLast3["210"].return_direction, "outgoing");
    check("…25 minutes later", (Date.parse(byLast3["210"].returned_at) - Date.parse("2026-06-10T04:30:00Z")) / 60000, 25);
    check("the declined caller got through on their own", byLast3["234"].return_direction, "incoming");
    check("a pre-0133 row falls back to the hash", byLast3["555"].return_direction, "outgoing");
    check("the withheld caller has no number to ring", [byLast3.none.has_number, byLast3.none.returned_at], [false, null]);
    check("rows carry their reason", byLast3["789"].missed_reason, "voicemail");
    // 4 missed + 3 uploads + the 2 pre-0133 rows.
    check("an unfiltered log still lists everything", (await owner.list(orgId, { from: "2026-06-01", to: "2026-06-30" })).total, 9);

    // ── 5. Call insights ───────────────────────────────────────────────────
    console.log("call insights");
    const results = await client.query(callInsightsBatch({ kind: "fixed", from: "2026-06-01", to: "2026-06-30" }));
    const report = assembleCallInsights(results, new Date("2026-07-01T00:00:00Z"));
    check("headline missed", report.current.missed, 5);
    check("callbacks.missed agrees with the headline", report.callbacks.missed, report.current.missed);
    check(
      "call-back figures",
      [report.callbacks.noNumber, report.callbacks.returned, report.callbacks.calledBack, report.callbacks.withinHour, report.callbacks.medianMinutes, report.callbacks.waitingCallers],
      // Returns at 25 min (ours), 240 min (theirs), 30 min (ours, legacy). Median 30.
      [1, 3, 2, 2, 30, 1],
    );
    check(
      "the waiting list",
      report.callbacks.waiting.map((w) => [w.contact, w.attempts, w.telecaller]),
      [["09123…789", 1, "Priya"]],
    );
    check("answered excludes the pick-up-and-drop from missed", report.current.answered, 2);
    check("the waiting list never carries a key or hash", JSON.stringify(report.callbacks).match(/[0-9a-f]{64}/), null);

    // ── 6. Billing and plan usage leave missed calls out ───────────────────
    const [usage] = await q(
      `SELECT count(*) FILTER (WHERE status <> 'NO_AUDIO')::int AS billable, count(*)::int AS all_rows FROM calls`,
    );
    check("four missed rows are not usage", usage.all_rows - usage.billable, 4);

    // ── 7. RLS: another org sees none of it ────────────────────────────────
    await client.query("SELECT set_config('app.org_id', $1, true)", ["00000000-0000-4000-8000-00000000dead"]);
    const [other] = await q(`SELECT count(*)::int AS n FROM calls WHERE device_id = $1`, [dev.id]);
    check("RLS confines missed calls to their org", other.n, 0);

    // ── 8. The migration's backfill agrees with phoneMatchDigits ───────────
    console.log("0133 backfill");
    await client.query("RESET ROLE");
    const cases = ["919876543210", "09876543210", "04412345678", "1234567", "0000123"];
    for (const full of cases) {
      await q(
        `INSERT INTO calls (org_id, workspace_id, device_id, direction, started_at, duration_s, status, remote_number_full, idempotency_key)
         VALUES ($1, $2, $3, 'outgoing', now(), 10, 'COMPLETE', $4, $5)`,
        [orgId, ws.id, dev.id, full, `backfill-${full}`],
      );
    }
    const migration = readFileSync(join(__dirname, "../../packages/db/migrations/0133_missed_calls.sql"), "utf8");
    const backfill = migration.slice(migration.indexOf("UPDATE calls c"), migration.indexOf(";", migration.indexOf("UPDATE calls c")));
    await client.query(backfill);
    const keyed = await q(
      `SELECT remote_number_full, remote_number_key FROM calls WHERE idempotency_key LIKE 'backfill-%' ORDER BY idempotency_key`,
      [],
    );
    for (const row of keyed) {
      const expected = phoneMatchDigits(row.remote_number_full);
      check(`backfill key for ${row.remote_number_full}`, row.remote_number_key, expected ? sha(expected) : null);
    }

    // ── 9. Follow-ups (migration 0134) ──────────────────────────────────────
    console.log("0134 follow-ups");
    await client.query("SET LOCAL ROLE aura_app");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);

    // An outgoing attempt that rang out - direction and reason travel
    // together, and the shape check backs the same pairing up server-side.
    const noAnswer = [
      { idempotencyKey: "no-answer-1", startedAt: "2026-06-16T04:00:00.000Z", direction: "outgoing", reason: "no_answer", remoteNumber: "9812340000" },
    ];
    check("an outgoing attempt is accepted", await calls.missed(req, { calls: noAnswer }), { accepted: 1, duplicates: 0, skipped: 0 });
    const [outgoingRow] = await q(
      `SELECT direction, duration_s, status, missed_reason FROM calls WHERE device_id = $1 AND idempotency_key LIKE '%no-answer-1'`,
      [dev.id],
    );
    check(
      "stored as outgoing, 0 s, NO_AUDIO, no_answer",
      [outgoingRow.direction, outgoingRow.duration_s, outgoingRow.status, outgoingRow.missed_reason],
      ["outgoing", 0, "NO_AUDIO", "no_answer"],
    );

    await client.query("SAVEPOINT reason_shape");
    let reasonShapeError = null;
    try {
      await client.query(
        `UPDATE calls SET missed_reason = 'no_answer' WHERE device_id = $1 AND idempotency_key LIKE '%missed-1'`,
        [dev.id],
      );
    } catch (err) {
      reasonShapeError = err.constraint;
    }
    await client.query("ROLLBACK TO SAVEPOINT reason_shape");
    check("no_answer cannot be given to an INCOMING missed call", reasonShapeError, "calls_missed_reason_shape_check");

    const insightsAfter = await client.query(callInsightsBatch({ kind: "fixed", from: "2026-06-01", to: "2026-06-30" }));
    const reportAfter = assembleCallInsights(insightsAfter, new Date("2026-07-01T00:00:00Z"));
    check("an outgoing attempt never joins the missed-inbound figure", reportAfter.current.missed, 5);

    // A genuinely unknown caller - nobody in this org has this number yet.
    await calls.missed(req, {
      calls: [{ idempotencyKey: "unknown-1", startedAt: "2026-06-16T05:00:00.000Z", reason: "unanswered", remoteNumber: "9812345678", remoteName: "New Caller" }],
    });
    const [unknownCall] = await q(
      `SELECT id, lead_id FROM calls WHERE device_id = $1 AND idempotency_key LIKE '%unknown-1'`,
      [dev.id],
    );
    check("the new missed call starts unlinked", unknownCall.lead_id, null);

    const created = await createLeadFromMissedCall(client, orgId, unknownCall.id);
    check("createLeadFromMissedCall reports it created a lead", created, true);

    const [lead] = await q(
      `SELECT id, stage, status, temperature, temperature_source, source_channel,
              telecaller_id, assigned_telecaller_id, contact_number_hash
         FROM leads WHERE contact_number_hash = $1`,
      [sha("9812345678")],
    );
    check(
      "thin, hot, entry-stage, attributed to the telecaller whose handset missed it",
      [lead.stage, lead.status, lead.temperature, lead.temperature_source, lead.source_channel, lead.telecaller_id, lead.assigned_telecaller_id],
      ["new", "open", "hot", "auto", "missed_call", priya.id, priya.id],
    );

    const [linkedCall] = await q(`SELECT lead_id, lead_link_source FROM calls WHERE id = $1`, [unknownCall.id]);
    check("the call is now linked, automatically", linkedCall, { lead_id: lead.id, lead_link_source: "auto" });

    const [task] = await q(
      `SELECT title, priority, assignee_user_id, (due_on = CURRENT_DATE) AS due_today FROM tasks WHERE assignee_user_id = $1`,
      [priyaUser.id],
    );
    check("a due-today, high-priority callback task lands on the telecaller's own list", task && [task.title.startsWith("Call back"), task.priority, task.due_today], [true, "high", true]);

    const [notif] = await q(
      `SELECT kind, dedupe_key FROM notifications WHERE user_id = $1 AND kind = 'missed_call'`,
      [priyaUser.id],
    );
    check("the telecaller is told, deduped on this call", notif && notif.dedupe_key, `missed_call:${unknownCall.id}`);

    // A replay of the same sweep tick (or an overlapping one) must not create
    // a second lead, a second task or a second bell for the same call.
    const createdAgain = await createLeadFromMissedCall(client, orgId, unknownCall.id);
    check("re-running the sweep on an already-linked call does nothing", createdAgain, false);
    const [leadCountAfter] = await q(`SELECT count(*)::int AS n FROM leads WHERE contact_number_hash = $1`, [sha("9812345678")]);
    check("still exactly one lead for this number", leadCountAfter.n, 1);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
