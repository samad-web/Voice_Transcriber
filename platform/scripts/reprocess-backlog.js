/**
 * Reprocess a backlog of calls for one instance, through the deployed API.
 *
 *   node scripts/reprocess-backlog.js --org <uuid> --status FAILED_ANALYZE,TRANSCRIPTION_OFF
 *   node scripts/reprocess-backlog.js --org <uuid> --status FAILED_ASR --dry-run
 *
 * Talks to /v1/calls and /v1/calls/:id/reprocess with the platform admin key, so
 * it goes through the same tenant guard and audit trail as the console does -
 * nothing here touches the database directly.
 *
 * WHY THIS IS NOT A ONE-LINER
 *
 * Reprocessing is not a read. Each call re-runs ASR and analyze (real provider
 * spend) and then CRM dispatch, which POSTs to the customer's real endpoint. A
 * connector with only_qualified = false pushes EVERY call, so a careless run
 * over a few hundred rows is a few hundred outbound deliveries that cannot be
 * recalled. Hence: a dry run that is the default posture, an explicit --yes, a
 * printed cost estimate, and a paced loop that does not stampede the queue.
 *
 * Env: reads API_BASE and ADMIN_API_KEY, or falls back to --api / --key flags.
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const API = (flag("api", process.env.API_BASE) ?? "").replace(/\/$/, "");
const KEY = flag("key", process.env.ADMIN_API_KEY);
const ORG = flag("org");
const STATUSES = (flag("status", "FAILED_ANALYZE") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT = Number(flag("limit", "500"));
/** Seconds between submissions. The queue is fine with a burst; the ASR provider
 *  and the customer's webhook are the things worth being polite to. */
const PACE_MS = Number(flag("pace-ms", "1500"));
const DRY = !has("yes");

if (!API || !KEY || !ORG || STATUSES.length === 0) {
  console.error(
    "usage: node scripts/reprocess-backlog.js --org <uuid> --status A,B [--api URL] [--key KEY]\n" +
      "                                        [--limit N] [--pace-ms N] [--yes]\n\n" +
      "Without --yes it lists what WOULD run and exits. API_BASE and ADMIN_API_KEY\n" +
      "can come from the environment instead of --api/--key.",
  );
  process.exit(2);
}

const headers = { "x-admin-key": KEY, "x-org-id": ORG };

async function listCalls(status) {
  const res = await fetch(`${API}/v1/calls?status=${encodeURIComponent(status)}&limit=${LIMIT}`, {
    headers,
  });
  if (!res.ok) throw new Error(`list ${status}: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  const rows = body.calls ?? body.rows ?? body;
  if (!Array.isArray(rows)) throw new Error(`list ${status}: unexpected shape`);
  return rows;
}

async function main() {
  const groups = [];
  for (const status of STATUSES) {
    const rows = await listCalls(status);
    groups.push({ status, rows });
  }

  const all = groups.flatMap((g) => g.rows);
  const seconds = all.reduce((s, c) => s + Number(c.duration_s || 0), 0);
  const hours = seconds / 3600;

  console.log(`\norg ${ORG} @ ${API}`);
  for (const g of groups) {
    const s = g.rows.reduce((a, c) => a + Number(c.duration_s || 0), 0);
    console.log(`  ${g.status.padEnd(20)} ${String(g.rows.length).padStart(4)} calls  ${(s / 3600).toFixed(2)}h`);
  }
  console.log(`  ${"TOTAL".padEnd(20)} ${String(all.length).padStart(4)} calls  ${hours.toFixed(2)}h`);
  // Rates measured 2026-07-30: Sarvam ASR+diarization ₹45/h, Sarvam analyze ~₹4/h,
  // Gemini ASR ~₹50/h + analyze ~₹22/h. Rough by design - it exists to stop a
  // run that is an order of magnitude larger than intended, not to bill anyone.
  console.log(
    `  estimated provider cost: ~₹${Math.round(hours * 49)} on Sarvam, ` +
      `~₹${Math.round(hours * 72)} on Gemini`,
  );
  console.log(
    `  each call also fires CRM dispatch - with only_qualified=false that is ` +
      `${all.length} outbound deliveries\n`,
  );

  if (DRY) {
    console.log("DRY RUN - nothing submitted. Re-run with --yes to execute.\n");
    return;
  }

  let ok = 0;
  const failed = [];
  for (const [i, call] of all.entries()) {
    try {
      const res = await fetch(`${API}/v1/calls/${call.id}/reprocess`, { method: "POST", headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      ok++;
    } catch (err) {
      failed.push({ id: call.id, reason: String(err.message ?? err) });
    }
    if ((i + 1) % 10 === 0 || i === all.length - 1) {
      console.log(`  submitted ${i + 1}/${all.length} (ok ${ok}, failed ${failed.length})`);
    }
    if (i < all.length - 1) await new Promise((r) => setTimeout(r, PACE_MS));
  }

  console.log(`\nsubmitted ${ok}/${all.length}`);
  if (failed.length) {
    console.log("failed to submit:");
    for (const f of failed) console.log(`  ${f.id}  ${f.reason}`);
  }
  // Submission is not completion. Batch ASR parks each call in TRANSCRIBING and
  // the worker's poller finishes it, so the real answer is in the console or in
  // /v1/admin/health a few minutes from now.
  console.log(
    "\nThese are submissions, not completions. Watch /v1/admin/health or the\n" +
      "instance's call list - batch ASR parks calls in TRANSCRIBING until the\n" +
      "poller collects them.\n",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
