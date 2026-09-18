#!/usr/bin/env node
/**
 * End-to-end drive of the two-lane pipeline (A1-A5, B0-B5), against the real
 * stack: real Postgres, real RabbitMQ, real MinIO, real ffmpeg. Only the two
 * AI providers are stubbed (ASR_STUB / ANALYZE_STUB), because they are the one
 * part that costs money and the one part that was never changed.
 *
 * WHY THIS EXISTS. Every unit test in this package mocks `withOrgContext` and
 * both providers, so between them they prove the logic and nothing about the
 * system: not one call had been through the pipeline end to end. The queues in
 * particular - two of them added by A2 and A4, each on its own channel with its
 * own prefetch - had never touched a broker at all.
 *
 * It seeds a call, publishes it, and waits for the state machine to settle,
 * then asserts on what the database actually holds. Run with the worker up:
 *
 *   ASR_STUB=1 ANALYZE_STUB=1 node dist/main.js        # terminal 1
 *   node e2e-pipeline-lanes.cjs                        # terminal 2
 */
const { Client } = require("pg");
// amqplib belongs to @aura/queue, not to the worker, so resolve it from there.
const amqp = require(require.resolve("amqplib", {
  paths: [require("node:path").join(__dirname, "../../packages/queue")],
}));
const { execFileSync } = require("node:child_process");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { randomUUID } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const DB = process.env.DATABASE_URL ?? "postgresql://aura:aura_dev_password@127.0.0.1:5433/callintel";
const MQ = process.env.RABBITMQ_URL ?? "amqp://aura:aura_dev_password@127.0.0.1:5672";
const ORG = "00000000-0000-4000-8000-000000000001";
const BUCKET = process.env.S3_BUCKET ?? "aura-recordings";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: "ap-south-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "aura_minio", secretAccessKey: "aura_minio_password" },
});

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A recording with real speech-shaped audio and real silence to trim. */
function buildAudio() {
  const dir = mkdtempSync(join(tmpdir(), "aura-e2e-"));
  const p = (n) => join(dir, n);
  const ff = (args) => execFileSync("ffmpeg", ["-nostdin", "-y", "-loglevel", "error", ...args]);
  ff(["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "6", p("s1.wav")]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:r=16000", "-t", "8", p("t1.wav")]);
  ff(["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "6", p("s2.wav")]);
  require("node:fs").writeFileSync(
    p("list.txt"),
    ["s1.wav", "t1.wav", "s2.wav"].map((f) => `file '${f}'`).join("\n"),
  );
  // Concat as PCM, then encode: m4a cannot carry pcm_s16le, so `-c copy` into
  // it fails. AAC also matches what the handset actually uploads.
  ff(["-f", "concat", "-safe", "0", "-i", p("list.txt"), "-c", "copy", p("call.wav")]);
  ff(["-i", p("call.wav"), "-c:a", "aac", "-b:a", "32k", "-ar", "16000", "-ac", "1", p("call.m4a")]);
  const buf = readFileSync(p("call.m4a"));
  rmSync(dir, { recursive: true, force: true });
  return buf; // 20s total, 8s of tone
}

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();

  const { rows: ctx } = await db.query(
    `SELECT (SELECT id FROM workspaces WHERE org_id=$1 LIMIT 1) ws,
            (SELECT id FROM devices WHERE org_id=$1 LIMIT 1) dev,
            (SELECT id FROM agents WHERE org_id=$1 AND is_active AND kind='call_extractor' LIMIT 1) ag`,
    [ORG],
  );
  const { ws, dev, ag } = ctx[0];
  if (!ws || !dev || !ag) throw new Error(`Dev Org missing ws/device/agent: ${JSON.stringify(ctx[0])}`);

  const callId = randomUUID();
  const key = `${ORG}/${callId}.m4a`;
  const audio = buildAudio();
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: audio }));

  await db.query(
    `INSERT INTO calls (id, org_id, workspace_id, device_id, direction, started_at,
                        ended_at, duration_s, status, remote_number_hash,
                        remote_number_prefix, remote_number_last3, remote_name)
     VALUES ($1,$2,$3,$4,'outgoing', now() - interval '1 minute', now(), 20, 'UPLOADED',
             $5, '+9198', '321', 'E2E Caller')`,
    [callId, ORG, ws, dev, `e2e-${callId.slice(0, 8)}`],
  );
  await db.query(
    `INSERT INTO recordings (org_id, call_id, s3_key, bytes, codec) VALUES ($1,$2,$3,$4,'aac')`,
    [ORG, callId, key, audio.length],
  );

  console.log(`\nseeded call ${callId} (${audio.length} bytes, 20s: 12s silence + 8s tone)\n`);

  const conn = await amqp.connect(MQ);
  const ch = await conn.createChannel();
  await ch.assertQueue("aura.pipeline", { durable: true });
  ch.sendToQueue("aura.pipeline", Buffer.from(JSON.stringify({ callId, orgId: ORG })), {
    persistent: true,
    contentType: "application/json",
  });
  console.log("published to aura.pipeline; waiting for the state machine to settle...\n");

  const deadline = Date.now() + 90_000;
  let row;
  for (;;) {
    ({
      rows: [row],
    } = await db.query(
      "SELECT status, enrichment_status, error_message FROM calls WHERE id=$1",
      [callId],
    ));
    const settled =
      (row.status === "COMPLETE" && ["done", "skipped", "failed"].includes(row.enrichment_status)) ||
      row.status.startsWith("FAILED_");
    if (settled || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`final: status=${row.status} enrichment=${row.enrichment_status}\n`);
  if (row.error_message) console.log(`error_message: ${row.error_message}\n`);

  console.log("── the lead lane ──────────────────────────────────────────");
  check("call reached COMPLETE", row.status === "COMPLETE", row.status);
  const q = async (sql) => (await db.query(sql, [callId])).rows[0];

  const tr = await q("SELECT text, segments, intelligence, diarized FROM transcripts WHERE call_id=$1");
  check("transcript written", !!tr);
  const ai = await q("SELECT id, validation_status FROM ai_outputs WHERE call_id=$1");
  check("extraction written", !!ai, ai?.validation_status);
  const facts = await q("SELECT count(*)::int n FROM call_facts WHERE call_id=$1");
  check("call_facts projected (A5 unnest)", facts.n > 0, `${facts.n} field(s)`);
  const lead = await q(
    "SELECT id, title, summary FROM leads WHERE first_call_id=$1 OR last_call_id=$1",
  );
  check("lead created", !!lead, lead?.title);

  console.log("\n── the enrichment lane (A4) ───────────────────────────────");
  check("enrichment settled", ["done", "skipped"].includes(row.enrichment_status), row.enrichment_status);
  check("intelligence written", !!tr?.intelligence, tr?.intelligence?.summary?.slice(0, 40));
  check(
    "lead summary backfilled by the enrich lane",
    !!lead?.summary,
    lead?.summary ? `"${lead.summary.slice(0, 40)}"` : "EMPTY",
  );
  const analytics = await q("SELECT quality_score FROM call_analytics WHERE call_id=$1");
  check("call analytics written", !!analytics);
  const sync = await q("SELECT count(*)::int n FROM crm_sync_log WHERE call_id=$1");
  const conns = (
    await db.query(
      "SELECT count(*)::int n FROM crm_integrations WHERE org_id=$1 AND status='connected'",
      [ORG],
    )
  ).rows[0].n;
  // One queued send per connected integration, and NOT before enrichment
  // settled - that ordering is the whole reason dispatch moved lanes.
  check(
    "CRM dispatch released after enrichment",
    sync.n === conns,
    `${sync.n} queued for ${conns} connected integration(s)`,
  );

  console.log("\n── ASR cost controls (B0/B2/B3) ───────────────────────────");
  const allAsr = (
    await db.query(
      `SELECT kind, quantity::float q FROM usage_events WHERE ref_id=$1 AND kind LIKE 'asr_%'`,
      [callId],
    )
  ).rows;
  check(
    "exactly one ASR usage row per call",
    allAsr.length === 1,
    allAsr.map((r) => r.kind).join(", ") || "none",
  );
  const usage = allAsr[0];
  check("ASR minutes metered (B0)", !!usage, usage ? `${usage.kind} = ${usage.q.toFixed(3)} min` : "");
  check(
    "metered the TRIMMED length, not the handset's 20s (B2)",
    !!usage && usage.q < 20 / 60,
    usage ? `${(usage.q * 60).toFixed(1)}s billed vs 20s recorded` : "",
  );
  check(
    "billed on the plain tier (B1 default off)",
    usage?.kind === "asr_minutes",
    usage?.kind,
  );

  console.log("\n── queue topology (A2/A4) ─────────────────────────────────");
  for (const name of ["aura.pipeline", "aura.analyze", "aura.enrich"]) {
    const ch2 = await conn.createChannel();
    const info = await ch2.checkQueue(name);
    check(`${name} exists and is drained`, info.messageCount === 0, `${info.messageCount} pending`);
    await ch2.close();
  }

  /*
   * Scenario 2: the analyze queue itself (A2).
   *
   * Everything above took the INLINE ASR path, because no batch provider is
   * configured here - so `aura.analyze` was asserted and drained but never
   * actually carried a call. This seeds a call in the exact state the ASR
   * poller leaves behind (transcript committed, status ANALYZING) and publishes
   * it, which is the one link in the chain the first scenario cannot reach.
   */
  console.log("\n── scenario 2: the analyze queue (A2) ─────────────────────");
  const c2 = randomUUID();
  await db.query(
    `INSERT INTO calls (id, org_id, workspace_id, device_id, direction, started_at,
                        ended_at, duration_s, status, remote_number_hash,
                        remote_number_prefix, remote_number_last3, remote_name,
                        enrichment_status)
     VALUES ($1,$2,$3,$4,'incoming', now() - interval '2 minutes', now(), 45, 'ANALYZING',
             $5, '+9177', '654', 'Queue Caller', 'pending')`,
    [c2, ORG, ws, dev, `e2e-${c2.slice(0, 8)}`],
  );
  await db.query(
    `INSERT INTO transcripts (org_id, call_id, language, engine, text, segments, diarized)
     VALUES ($1,$2,'ta','e2e','the customer asked about pricing and delivery','[]'::jsonb,false)`,
    [ORG, c2],
  );
  ch.sendToQueue("aura.analyze", Buffer.from(JSON.stringify({ callId: c2, orgId: ORG })), {
    persistent: true,
    contentType: "application/json",
  });

  const d2 = Date.now() + 60_000;
  let r2;
  for (;;) {
    ({ rows: [r2] } = await db.query(
      "SELECT status, enrichment_status FROM calls WHERE id=$1",
      [c2],
    ));
    if ((r2.status === "COMPLETE" && r2.enrichment_status !== "pending") || Date.now() > d2) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check("call consumed from aura.analyze reached COMPLETE", r2.status === "COMPLETE", r2.status);
  check("and was handed on to the enrich lane", r2.enrichment_status === "done", r2.enrichment_status);
  const ai2 = (
    await db.query("SELECT count(*)::int n FROM ai_outputs WHERE call_id=$1", [c2])
  ).rows[0].n;
  check("extraction ran once", ai2 === 1, `${ai2} ai_output(s)`);

  /*
   * Scenario 3: the redelivery guard.
   *
   * RabbitMQ redelivers on a nack, a dead consumer or a broker restart. Without
   * the status check in `analyzeCall` a duplicate would re-run the provider,
   * write a second ai_outputs row and re-deliver the lead to the tenant's CRM.
   */
  console.log("\n── scenario 3: redelivery of a completed call ─────────────");
  ch.sendToQueue("aura.analyze", Buffer.from(JSON.stringify({ callId: c2, orgId: ORG })), {
    persistent: true,
    contentType: "application/json",
  });
  await new Promise((r) => setTimeout(r, 6000));
  const ai3 = (
    await db.query("SELECT count(*)::int n FROM ai_outputs WHERE call_id=$1", [c2])
  ).rows[0].n;
  check("redelivery did NOT re-run the extraction", ai3 === 1, `${ai3} ai_output(s) after replay`);
  const sync3 = (
    await db.query("SELECT count(*)::int n FROM crm_sync_log WHERE call_id=$1", [c2])
  ).rows[0].n;
  check("and did not duplicate the CRM send", sync3 === conns, `${sync3} queued`);

  await ch.close();
  await conn.close();
  await db.end();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nE2E ERROR:", err);
  process.exit(1);
});
