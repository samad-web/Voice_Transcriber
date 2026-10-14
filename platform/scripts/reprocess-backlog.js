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
 * ── THE FOUR REPLAY RULES (doc 49 P1-B) ────────────────────────────────────
 *
 * 2,792 calls have audio in object storage and no transcript, because the ASR
 * vendor returned HTTP 402 to every submission between 2026-08-13 and
 * 2026-10-14. Replaying them is what closes that gap, and the plan's rules for
 * doing it are enforced here rather than written down and hoped for:
 *
 *   1. RUN IT AFTER THE ROUTING FIX. Replaying into a parked vendor reproduces
 *      the failure 2,792 more times. `--yes` now refuses to start unless
 *      /v1/admin/health reports at least one usable ASR provider. Override with
 *      --skip-health-check, which exists so the refusal can be argued with
 *      rather than worked around silently.
 *   2. OLDEST FIRST, so the customer-visible gap closes from the far end. This
 *      is the default; --newest-first is there for a deliberate "fix today
 *      before fixing August".
 *   3. RATE-LIMITED. --pace-ms, as before, and it matters more now: a provider
 *      being asked to absorb two months of backlog in an afternoon is how you
 *      discover a quota you did not know you had.
 *   4. PRICED BEFORE IT RUNS. The estimate below is printed on every run,
 *      including the dry one. Deciding whether all 2,792 are worth it or only
 *      the last 30 days is a business call - --since is how you express the
 *      answer.
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
/**
 * Only calls that started on or after this date. The whole backlog and the
 * last 30 days of it are different invoices, and which one to pay is not a
 * decision this script should make for anybody.
 */
const SINCE = flag("since");
/** Oldest first unless told otherwise - the gap closes from the far end. */
const NEWEST_FIRST = has("newest-first");
/** Seconds between submissions. The queue is fine with a burst; the ASR provider
 *  and the customer's webhook are the things worth being polite to. */
const PACE_MS = Number(flag("pace-ms", "1500"));
const DRY = !has("yes");

if (!API || !KEY || !ORG || STATUSES.length === 0) {
  console.error(
    "usage: node scripts/reprocess-backlog.js --org <uuid> --status A,B [--api URL] [--key KEY]\n" +
      "                                        [--limit N] [--pace-ms N] [--since YYYY-MM-DD]\n" +
      "                                        [--newest-first] [--skip-health-check] [--yes]\n\n" +
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

/**
 * Is anything able to transcribe right now?
 *
 * This is rule 1, and it is the only check in this script that can refuse to
 * run. The 2,792-call backlog exists because the pipeline could not tell
 * "configured" from "usable"; replaying it into the same condition would turn
 * one incident into two, with the second one's cost on our own invoice.
 */
async function assertAsrUsable() {
  let health;
  try {
    const res = await fetch(`${API}/v1/admin/health`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    health = await res.json();
  } catch (err) {
    throw new Error(
      `could not read ${API}/v1/admin/health (${err.message ?? err}). ` +
        "Re-run with --skip-health-check if you have confirmed a provider works by hand.",
    );
  }

  const asr = Array.isArray(health.asr) ? health.asr : [];
  if (asr.length === 0) {
    console.warn(
      "  WARNING: this deployment reports no ASR provider health rows at all.\n" +
        "  Migration 0202 may not be applied. Proceeding only because there is\n" +
        "  nothing to contradict - watch the first ten calls.",
    );
    return;
  }
  for (const p of asr) {
    console.log(
      `  provider ${String(p.provider).padEnd(8)} ${p.parked ? `PARKED (${p.reason ?? "?"})` : "usable"}`,
    );
  }
  if (asr.every((p) => p.parked)) {
    throw new Error(
      "every ASR provider is parked - a replay now would fail every call again.\n" +
        "Top the vendor up, or set ASR_PROVIDER_ORDER to one that works, and try again.",
    );
  }
  const rate = health.transcription?.successRate;
  if (typeof rate === "number") {
    console.log(`  last 24h success rate on audio-bearing calls: ${(rate * 100).toFixed(1)}%`);
  }
}

async function main() {
  const groups = [];
  for (const status of STATUSES) {
    const rows = await listCalls(status);
    groups.push({ status, rows });
  }

  if (SINCE) {
    const cutoff = new Date(SINCE);
    if (Number.isNaN(cutoff.getTime())) {
      console.error(`--since ${SINCE} is not a date`);
      process.exit(2);
    }
    for (const g of groups) {
      g.rows = g.rows.filter((c) => {
        const at = c.started_at ?? c.created_at;
        return at ? new Date(at) >= cutoff : true;
      });
    }
  }

  const all = groups.flatMap((g) => g.rows);
  /**
   * Rule 2. The API returns newest-first, which is the wrong end for this job:
   * a customer looking at August wants August filled in, and the oldest calls
   * are also the ones closest to their retention window expiring.
   */
  all.sort((a, b) => {
    const at = new Date(a.started_at ?? a.created_at ?? 0).getTime();
    const bt = new Date(b.started_at ?? b.created_at ?? 0).getTime();
    return NEWEST_FIRST ? bt - at : at - bt;
  });
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

  if (all.length > 0) {
    const first = all[0].started_at ?? all[0].created_at;
    const last = all[all.length - 1].started_at ?? all[all.length - 1].created_at;
    console.log(
      `  order: ${NEWEST_FIRST ? "newest" : "oldest"} first ` +
        `(${String(first).slice(0, 10)} → ${String(last).slice(0, 10)})`,
    );
  }

  if (DRY) {
    console.log("\nDRY RUN - nothing submitted. Re-run with --yes to execute.\n");
    return;
  }

  console.log("\nchecking that something can actually transcribe:");
  if (has("skip-health-check")) {
    console.warn("  --skip-health-check given; NOT verifying that an ASR provider is usable.");
  } else {
    await assertAsrUsable();
  }
  console.log("");

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
