#!/usr/bin/env node
/**
 * The two things unit tests cannot answer, against the real provider.
 *
 * (2) WHAT DOES SARVAM RETURN WITH withDiarization:false? Migration 0083 makes
 *     that the default for new instances and the whole 33% saving depends on it,
 *     but the code has never once called it that way. Without diarization the
 *     response has no `diarized_transcript`, so `toAsrResult` falls through to
 *     the `timestamps.chunks` branch - a path that may be close to dead code.
 *     If that assumption is wrong, transcripts come back as one blob and the
 *     console's transcript view degrades for every instance on the cheap tier.
 *
 * (3) DOES THE SILENCE TRIM EAT SPEECH? The -35dB / 1s threshold was chosen
 *     against synthetic digital silence, which is -infinity dB. Real phone audio
 *     has a noise floor. Trimming too little is harmless; trimming too much
 *     removes words, and it does so SILENTLY - it would surface weeks later as
 *     "the AI is getting worse", not as an error.
 *
 * Costs three ASR calls on the configured account. Run with the local stack up.
 */
const { Client } = require("pg");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

const DB = process.env.DATABASE_URL ?? "postgresql://aura:aura_dev_password@127.0.0.1:5433/callintel";
const BUCKET = process.env.S3_BUCKET ?? "aura-recordings";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
  region: "ap-south-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "aura_minio", secretAccessKey: "aura_minio_password" },
});

function describeResult(label, r) {
  const words = (r.text ?? "").trim().split(/\s+/).filter(Boolean).length;
  const speakers = new Set((r.segments ?? []).map((s) => s.speaker));
  console.log(
    `  ${label.padEnd(28)} segments=${String(r.segments.length).padStart(3)}  ` +
      `speakers=${[...speakers].join("/") || "-"}  diarized=${r.diarized}  ` +
      `words=${words}  lang=${r.language}`,
  );
  return { words, segments: r.segments.length, speakers: speakers.size, text: r.text ?? "" };
}

/** Jaccard overlap of word sets - how much content survived the trim. */
function overlap(a, b) {
  const A = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const B = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  let hit = 0;
  for (const w of B) if (A.has(w)) hit++;
  return B.size ? hit / B.size : 0;
}

async function main() {
  const { startSarvamAsrJob, collectSarvamAsrJob } = require("./dist/pipeline/asr-sarvam");
  const { prepareAudioForAsr } = require("./dist/pipeline/audio-prep");

  const db = new Client({ connectionString: DB });
  await db.connect();
  const {
    rows: [rec],
  } = await db.query(
    `SELECT r.s3_key, c.duration_s FROM recordings r JOIN calls c ON c.id = r.call_id
      WHERE c.duration_s BETWEEN 25 AND 80 AND c.status = 'COMPLETE'
      ORDER BY c.duration_s LIMIT 1`,
  );
  await db.end();
  if (!rec) throw new Error("no suitable real recording in the local bucket");

  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: rec.s3_key }));
  const original = Buffer.from(await obj.Body.transformToByteArray());
  console.log(`\nrecording: ${rec.s3_key}`);
  console.log(`duration:  ${rec.duration_s}s, ${original.length} bytes\n`);

  console.log("── (3) what the silence trim does to REAL audio ───────────");
  const prep = await prepareAudioForAsr(original, "threshold-probe", null);
  const kept = prep.seconds ?? rec.duration_s;
  const cut = Math.round(((rec.duration_s - kept) / rec.duration_s) * 100);
  console.log(`  ${rec.duration_s}s → ${kept.toFixed(1)}s  (${cut}% removed)  ${prep.reason}\n`);

  const run = async (label, audio, diarize) => {
    const jobId = await startSarvamAsrJob(audio, `probe-${label}`, { diarize });
    for (let i = 0; i < 60; i++) {
      const out = await collectSarvamAsrJob(jobId);
      if (out.state === "done") return describeResult(label, out.result);
      if (out.state === "failed") throw new Error(`${label}: ${out.reason}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error(`${label}: job never finished`);
  };

  console.log("── (2) response shape, diarized vs plain ──────────────────");
  const diar = await run("original, diarized", original, true);
  const plain = await run("original, PLAIN", original, false);
  const trimmed = await run("trimmed, PLAIN", prep.audio, false);

  console.log("\n── verdict ────────────────────────────────────────────────");
  const ok = (l, c, d = "") =>
    console.log(`  ${c ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${l}${d ? ` — ${d}` : ""}`);

  ok("plain tier still returns a transcript", plain.words > 0, `${plain.words} words`);
  ok(
    "plain tier still returns SEGMENTS (chunk fallback works)",
    plain.segments > 1,
    `${plain.segments} segments`,
  );
  ok("plain tier reports diarized=false", plain.speakers <= 1);
  ok(
    "plain transcript matches the diarized one",
    overlap(diar.text, plain.text) > 0.9,
    `${Math.round(overlap(diar.text, plain.text) * 100)}% word overlap`,
  );
  ok(
    "the TRIM did not eat speech",
    overlap(plain.text, trimmed.text) > 0.9,
    `${Math.round(overlap(plain.text, trimmed.text) * 100)}% of trimmed words appear in the untrimmed read`,
  );
  ok(
    "the trim is worth doing",
    cut >= 5,
    `${cut}% of billed audio removed`,
  );
  console.log("");
}

main().catch((e) => {
  console.error("\nPROBE ERROR:", e.message ?? e);
  process.exit(1);
});
