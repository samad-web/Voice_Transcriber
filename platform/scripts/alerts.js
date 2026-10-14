/**
 * THE THING THAT WAS WATCHING NOTHING.
 *
 *   node scripts/alerts.js              # check, notify what changed
 *   node scripts/alerts.js --dry-run    # check and print, notify nobody
 *   node scripts/alerts.js --digest     # also post the daily all-clear
 *   node scripts/alerts.js --list       # what is firing right now
 *   node scripts/alerts.js --test <key> # force one alert to fire, once
 *
 * Cron (see DEPLOYMENT.md §9) - every five minutes, plus a 09:00 digest:
 *   (slash)5 * * * *  cd /opt/aura/platform && node scripts/alerts.js
 *   0        9 * * *  cd /opt/aura/platform && node scripts/alerts.js --digest
 *
 * ── WHY THESE CHECKS AND NOT CPU GRAPHS (doc 49 P2-B) ───────────────────────
 *
 * Technical monitoring would not have caught the incident that prompted this
 * file. For 62 days: no exception was thrown that a human saw, every container
 * was healthy, `GET /health` was green, the queue was empty because work was
 * completing - and 96% of the product's core function was failing. The pipeline
 * was working exactly as coded and failing as a business.
 *
 * So the alerts are on BUSINESS RATIOS, not on process liveness. The first
 * check below is P1's exact signature and would have fired on 2026-08-13.
 *
 * ── WHY IT RUNS FROM CRON AND NOT IN THE WORKER ─────────────────────────────
 *
 * The worker is the process most likely to be the thing that is broken, and a
 * monitor inside the patient cannot report the patient's death. This runs
 * independently, reads a heartbeat the worker writes (0203), and so can say
 * "the worker has not beaten for nine minutes" - which no in-process metric
 * can.
 *
 * It still cannot say "the VPS is down", because it would be down too. That is
 * P2-C, and it has to be bought from outside.
 *
 * ── THE ALL-CLEAR IS NOT A COURTESY ─────────────────────────────────────────
 *
 * `--digest` posts a line every morning even when nothing is wrong, and that is
 * the point rather than noise. Silence from a monitor is ambiguous - fixed, or
 * dead? - and an alarm nobody has ever seen fire is an alarm nobody trusts.
 * The digest is the daily proof that the thing is running at all.
 */
const { Client } = require("pg");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DRY = process.argv.includes("--dry-run");
const DIGEST = process.argv.includes("--digest");
const LIST = process.argv.includes("--list");
const TEST_KEY = (() => {
  const i = process.argv.indexOf("--test");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const URL =
  process.env.DATABASE_URL ?? "postgresql://aura:aura_dev_password@localhost:5433/callintel";

/**
 * Where an alert goes.
 *
 * A generic webhook rather than a vendor SDK, because the shape works with
 * Slack, Discord, Google Chat, Mattermost and n8n unchanged, and because the
 * one thing a monitor must not have is a dependency that can break it.
 * Unset means stdout only - which is still better than what existed before,
 * and is the right default for a first run.
 */
const WEBHOOK = process.env.ALERT_WEBHOOK_URL;

/**
 * How long before a still-firing alert is repeated.
 *
 * Six hours. Long enough that a condition lasting a week is 28 messages rather
 * than 2,016; short enough that it does not disappear from a channel somebody
 * reads once a day. The FIRST firing is always immediate.
 */
const REMIND_AFTER_MS = Number(process.env.ALERT_REMIND_AFTER_MS ?? 6 * 3600 * 1000);

// ── THE CHECKS ──────────────────────────────────────────────────────────────
//
// Each returns null when healthy, or { detail, severity } when not. They are
// ordinary async functions rather than a list of SQL strings because four of
// them have to read something that is not the database - a disk, a directory, a
// broker - and a framework that could only do SQL would have quietly excluded
// exactly those.

/**
 * 1. P1's SIGNATURE. The single most important line in this file.
 *
 * NO_AUDIO is excluded because those are the call-log-only rows from
 * missed-call capture (0133/0134), which never had audio to transcribe.
 * Including them flatters the ratio by precisely the amount nobody wants
 * flattered - on the measured week it would have turned 4% into 2%, still bad,
 * but on a quiet day of missed calls it can turn a total outage into a
 * comfortable-looking number.
 *
 * The >= 20 floor is what stops three failures at 2am paging somebody. Without
 * it the alert is a coin flip on low volume and gets muted, which is the same
 * as not having it.
 */
async function asrSuccessRate(db) {
  const {
    rows: [r],
  } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'COMPLETE')::int AS complete
       FROM calls
      WHERE created_at > now() - interval '1 hour'
        AND status <> 'NO_AUDIO'`,
  );
  if (r.total < 20) return null;
  const rate = r.complete / r.total;
  if (rate >= 0.8) return null;
  return {
    severity: "critical",
    detail:
      `Transcription success is ${(rate * 100).toFixed(0)}% over the last hour ` +
      `(${r.complete} of ${r.total} audio-bearing calls). Expected >80%.`,
  };
}

/**
 * 2. WHICH VENDOR IS REFUSING US, BY NAME (0202).
 *
 * This is the alert that turns "the product is broken" into "top up the Sarvam
 * account", which is the difference between an alert somebody can act on and
 * one they can only worry about.
 */
async function providerParked(db) {
  const { rows } = await db.query(
    `SELECT provider, last_reason, parked_until
       FROM asr_provider_health
      WHERE parked_until > now()
      ORDER BY provider`,
  );
  if (rows.length === 0) return null;
  const { rows: configured } = await db.query(`SELECT count(*)::int AS n FROM asr_provider_health`);
  const all = rows.length >= configured[0].n;
  return {
    // All of them parked means nothing transcribes at all; one means the other
    // is carrying the load, which is the routing working as designed.
    severity: all ? "critical" : "warning",
    detail:
      (all ? "NO ASR provider is usable: " : "An ASR provider is parked: ") +
      rows
        .map((r) => `${r.provider} (${r.last_reason ?? "unknown"}) until ${iso(r.parked_until)}`)
        .join("; "),
  };
}

/** 3. The queue backing up: the worker is dead, or losing. */
async function queueDepth() {
  const api = process.env.RABBITMQ_MANAGEMENT_URL;
  if (!api) return null;
  try {
    const res = await fetch(`${api.replace(/\/$/, "")}/api/queues`, {
      headers: {
        authorization:
          "Basic " +
          Buffer.from(
            `${process.env.RABBITMQ_USER ?? "aura"}:${process.env.RABBITMQ_PASSWORD ?? ""}`,
          ).toString("base64"),
      },
    });
    if (!res.ok) return null;
    const queues = await res.json();
    const deep = queues
      .filter((q) => Number(q.messages_ready ?? 0) > 500)
      .map((q) => `${q.name}=${q.messages_ready}`);
    if (deep.length === 0) return null;
    return { severity: "critical", detail: `Queue backing up: ${deep.join(", ")}` };
  } catch {
    // A broker we cannot ask is not a broker we can call deep. The heartbeat
    // and the stuck-call checks cover the case where it is genuinely down.
    return null;
  }
}

/**
 * 4. Calls parked in TRANSCRIBING. `asr-poll.ts:27` names this exact failure:
 * a submitted batch job that never reaches a terminal state, invisible to the
 * retry sweep (which only looks at FAILED_%) and to anyone not reading worker
 * logs.
 */
async function stuckTranscribing(db) {
  const {
    rows: [r],
  } = await db.query(
    `SELECT count(*)::int AS n, min(updated_at) AS oldest
       FROM calls
      WHERE status = 'TRANSCRIBING'
        AND updated_at < now() - interval '2 hours'`,
  );
  if (r.n === 0) return null;
  return {
    severity: "critical",
    detail: `${r.n} call(s) stuck in TRANSCRIBING, oldest since ${iso(r.oldest)}. The ASR poller may be dead.`,
  };
}

/**
 * 5. ZERO INGEST. 15 paired devices; a silent business hour means FCM, pairing
 * or the APK - never "a quiet day".
 *
 * Business hours and weekdays are resolved in SQL against the deployment's
 * configured zone rather than the server's, because an alert that fires at
 * 04:00 IST because the box thinks it is UTC afternoon is an alert that gets
 * disabled within a week.
 */
async function zeroIngest(db) {
  const zone = process.env.ALERT_TIMEZONE ?? "Asia/Kolkata";
  const {
    rows: [r],
  } = await db.query(
    `SELECT (now() AT TIME ZONE $1)::time AS local_time,
            EXTRACT(ISODOW FROM (now() AT TIME ZONE $1))::int AS dow,
            (SELECT count(*)::int FROM calls WHERE created_at > now() - interval '1 hour') AS calls,
            (SELECT count(*)::int FROM devices WHERE status = 'active') AS devices`,
    [zone],
  );
  const hour = Number(String(r.local_time).slice(0, 2));
  if (r.dow > 5 || hour < 10 || hour >= 19) return null;
  if (r.devices === 0) return null;
  if (r.calls > 0) return null;
  return {
    severity: "warning",
    detail: `No calls ingested in the last hour during business hours, with ${r.devices} active device(s). Check FCM, pairing and the published APK.`,
  };
}

/** 6. A phone that has stopped reporting records nothing, and nobody notices. */
async function deviceSilence(db) {
  const { rows } = await db.query(
    `SELECT d.id, o.name AS org, d.last_seen_at
       FROM devices d JOIN organizations o ON o.id = d.org_id
      WHERE d.status = 'active'
        AND (d.last_seen_at IS NULL OR d.last_seen_at < now() - interval '48 hours')
      ORDER BY d.last_seen_at NULLS FIRST
      LIMIT 10`,
  );
  if (rows.length === 0) return null;
  return {
    severity: "warning",
    detail:
      `${rows.length} device(s) silent for over 48h: ` +
      rows.map((r) => `${r.org}/${String(r.id).slice(0, 8)} (${iso(r.last_seen_at)})`).join(", "),
  };
}

/**
 * 7. BACKUP AGE (doc 49 P4).
 *
 * Reads the directory rather than a log, because a log line saying "complete"
 * is a claim and a file with a size is evidence. A backup script that exits 0
 * having written nothing is a real failure mode and this is the only check that
 * would catch it.
 */
async function backupAge() {
  const dir = process.env.BACKUP_DIR ?? "/opt/aura/platform/supabase/selfhost/backups";
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(sql|dump|gz|age|enc)$/i.test(f))
      .map((f) => ({ f, stat: fs.statSync(path.join(dir, f)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (files.length === 0) {
      return { severity: "critical", detail: `No backup files in ${dir} at all.` };
    }
    const newest = files[0];
    const hours = (Date.now() - newest.stat.mtimeMs) / 3_600_000;
    if (hours > 36) {
      return {
        severity: "critical",
        detail: `Newest backup (${newest.f}) is ${hours.toFixed(0)}h old. Nightly backup has not run.`,
      };
    }
    // An empty or near-empty dump is worse than a missing one, because it looks
    // like success. 1MB is far below this database's real size.
    if (newest.stat.size < 1_000_000) {
      return {
        severity: "critical",
        detail: `Newest backup (${newest.f}) is only ${Math.round(newest.stat.size / 1024)}KB - almost certainly truncated.`,
      };
    }
    return null;
  } catch {
    // Not running on the box (a laptop, CI) - not a finding.
    return null;
  }
}

/** 8. DISK. MinIO grows monotonically and nothing ages out until P8-C lands. */
async function diskSpace() {
  try {
    const out = execSync("df -P /", { encoding: "utf8", timeout: 10_000 });
    const line = out.trim().split("\n").pop();
    const pct = Number(/(\d+)%/.exec(line)?.[1] ?? 0);
    if (pct < 80) return null;
    return {
      severity: pct >= 90 ? "critical" : "warning",
      detail: `Root filesystem is ${pct}% full. Recordings accumulate monotonically; see the retention job.`,
    };
  } catch {
    return null;
  }
}

/**
 * 9. THE FLEET IS BEHIND (doc 49 P3).
 *
 * Two halves, and the first is the one that voided six weeks of work: an APK
 * built, signed and sitting in `dist/` that the update channel has never been
 * offered, so no phone can get it. That was invisible for four weeks for the
 * same reason P1 was - nothing compared the two numbers.
 */
async function fleetBehind(db) {
  // `published` is a BOOLEAN on this table, not a timestamp - uploading is not
  // publishing, which is the distinction the whole check rests on and the one
  // that left 1.2.1 on a laptop for four weeks.
  const {
    rows: [published],
  } = await db.query(`SELECT max(version_code)::int AS code FROM app_releases WHERE published`);
  const findings = [];

  // The newest build on disk, if this is running where the builds are.
  try {
    const dist = process.env.APK_DIST_DIR ?? "CallRecorderApp/dist";
    const built = fs
      .readdirSync(dist)
      .map((f) => Number(/-(\d+)\.apk$/.exec(f)?.[1] ?? 0))
      .reduce((a, b) => Math.max(a, b), 0);
    if (built > (published.code ?? 0)) {
      findings.push(
        `An APK with versionCode ${built} is built but the newest PUBLISHED release is ${published.code ?? "none"} - no phone can get it.`,
      );
    }
  } catch {
    // Not the build machine. Fine.
  }

  // `devices.app_version` is TEXT. It holds the versionCode on current builds
  // but an older one reported a versionName ("1.1.4"), so the comparison is
  // guarded by a digits-only test rather than a cast: an unparseable value must
  // be ignored, not throw and take the whole check down with it.
  const { rows: behind } = await db.query(
    `SELECT count(*)::int AS n FROM devices
      WHERE status = 'active'
        AND app_version ~ '^[0-9]+$'
        AND app_version::int <= $1 - 2`,
    [published.code ?? 0],
  );
  if (behind[0].n > 0) {
    findings.push(
      `${behind[0].n} active device(s) are two or more builds behind ${published.code}.`,
    );
  }

  if (findings.length === 0) return null;
  return { severity: "warning", detail: findings.join(" ") };
}

/** 10. Is the worker alive at all (0203)? */
async function workerHeartbeat(db) {
  const {
    rows: [r],
  } = await db.query(
    `SELECT beat_at, release FROM platform_heartbeats WHERE service = 'worker'`,
  );
  if (!r) {
    // Nothing has ever beaten. On a fresh deploy this is true for a minute,
    // which is why it is a warning and not critical - the ASR and stuck-call
    // checks are what catch a genuinely dead worker on a busy deployment.
    return { severity: "warning", detail: "The worker has never written a heartbeat." };
  }
  const minutes = (Date.now() - new Date(r.beat_at).getTime()) / 60_000;
  if (minutes < 10) return null;
  return {
    severity: "critical",
    detail: `The worker has not beaten for ${minutes.toFixed(0)} minutes (last ${iso(r.beat_at)}${r.release ? `, build ${String(r.release).slice(0, 7)}` : ""}). Nothing is being transcribed.`,
  };
}

/**
 * 11. A PLATFORM INCIDENT NOBODY HAS CLOSED (0201).
 *
 * Both directions are useful and this reports both. An incident still taking
 * occurrences is live. One whose newest occurrence is a day old has healed
 * itself and is waiting to be closed - and a board full of those is a board
 * people learn to scroll past, which is how the queue stops working.
 */
async function openPlatformIncidents(db) {
  const { rows } = await db.query(
    `SELECT platform_reason, sum(occurrence_count)::int AS calls,
            min(reported_at) AS since, max(last_occurred_at) AS latest
       FROM call_issue_reports
      WHERE source = 'system'
        AND status IN ('open','acknowledged','in_progress','awaiting_client')
      GROUP BY 1
      ORDER BY 2 DESC`,
  );
  if (rows.length === 0) return null;
  const live = rows.filter(
    (r) => r.latest && Date.now() - new Date(r.latest).getTime() < 3_600_000,
  );
  return {
    severity: live.length > 0 ? "critical" : "warning",
    detail:
      rows
        .map(
          (r) =>
            `${r.platform_reason}: ${r.calls} call(s) since ${iso(r.since)}` +
            (r.latest && Date.now() - new Date(r.latest).getTime() > 86_400_000
              ? " (nothing new for over a day - may be closeable)"
              : ""),
        )
        .join("; ") || "open platform incidents",
  };
}

/**
 * 12. STORAGE GROWTH, as days until full (doc 49 P8-D).
 *
 * A percentage tells you where you are; a projection tells you when to act,
 * which is the number somebody can put in a calendar. Needs a week of
 * snapshots before it says anything, and says nothing rather than guessing.
 */
async function storageRunway(db) {
  // `org_storage_daily` is the only history this schema keeps (one row per org
  // per day, recording bytes). Summed across tenants it is the growth curve of
  // the MinIO volume, which is the thing that fills the disk - 0197's eviction
  // only fires for an org past its own ceiling, which on current plans almost
  // never happens.
  //
  // Read on the admin pool, which bypasses this table's org_isolation policy -
  // deliberate, and the same bootstrap exception every cross-tenant platform
  // read in this repo documents: "how fast is the platform's disk filling" has
  // no tenant to ask it as.
  const {
    rows: [r],
  } = await db
    .query(
      `WITH daily AS (
         SELECT day, sum(recording_bytes)::bigint AS total
           FROM org_storage_daily
          WHERE day > (now() - interval '21 days')::date
          GROUP BY day
       )
       SELECT min(day) AS from_day, max(day) AS to_day,
              (SELECT total FROM daily ORDER BY day ASC  LIMIT 1) AS from_bytes,
              (SELECT total FROM daily ORDER BY day DESC LIMIT 1) AS to_bytes
         FROM daily`,
    )
    .catch(() => ({ rows: [null] }));
  if (!r || !r.from_day || !r.to_day) return null;
  const days = (new Date(r.to_day) - new Date(r.from_day)) / 86_400_000;
  if (days < 5) return null;
  const perDay = (Number(r.to_bytes) - Number(r.from_bytes)) / days;
  if (perDay <= 0) return null;

  let freeBytes = null;
  try {
    const out = execSync("df -P -k /", { encoding: "utf8", timeout: 10_000 });
    const cols = out.trim().split("\n").pop().split(/\s+/);
    freeBytes = Number(cols[3]) * 1024;
  } catch {
    return null;
  }
  const runway = freeBytes / perDay;
  if (runway > 60) return null;
  return {
    severity: runway < 21 ? "critical" : "warning",
    detail: `Storage is growing ${(perDay / 1_048_576).toFixed(0)} MB/day; about ${runway.toFixed(0)} days of free space left.`,
  };
}

const CHECKS = [
  ["asr_success", asrSuccessRate],
  ["provider_parked", providerParked],
  ["queue_depth", queueDepth],
  ["stuck_transcribing", stuckTranscribing],
  ["zero_ingest", zeroIngest],
  ["device_silence", deviceSilence],
  ["backup_age", backupAge],
  ["disk_space", diskSpace],
  ["fleet_behind", fleetBehind],
  ["worker_heartbeat", workerHeartbeat],
  ["platform_incidents", openPlatformIncidents],
  ["storage_runway", storageRunway],
];

// ── PLUMBING ────────────────────────────────────────────────────────────────

function iso(d) {
  return d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) : "never";
}

async function notify(text) {
  console.log(text);
  if (DRY || !WEBHOOK) return;
  try {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `text` and `content` together, so the same URL works for Slack,
      // Mattermost (text) and Discord (content) without a per-vendor branch.
      body: JSON.stringify({ text, content: text }),
    });
    if (!res.ok) console.error(`alert webhook returned HTTP ${res.status}`);
  } catch (err) {
    // A webhook we cannot reach must not stop the next check, and must not
    // stop the state being recorded - the state is what makes the next run
    // notice the delivery never happened.
    console.error("alert webhook failed:", err.message ?? err);
  }
}

/** Record the firing and decide whether a human hears about it. */
async function recordFiring(db, key, finding) {
  const {
    rows: [row],
  } = await db.query(
    `INSERT INTO platform_alerts (key, state, detail, severity, occurrences, resolved_at)
     VALUES ($1, 'firing', $2, $3, 1, NULL)
     ON CONFLICT (key) DO UPDATE
       SET state = 'firing',
           detail = $2,
           severity = $3,
           last_seen_at = now(),
           resolved_at = NULL,
           occurrences = CASE WHEN platform_alerts.state = 'firing'
                              THEN platform_alerts.occurrences + 1 ELSE 1 END,
           first_seen_at = CASE WHEN platform_alerts.state = 'firing'
                                THEN platform_alerts.first_seen_at ELSE now() END,
           updated_at = now()
     RETURNING first_seen_at, last_notified_at, occurrences`,
    [key, finding.detail, finding.severity],
  );

  const due =
    row.last_notified_at === null ||
    Date.now() - new Date(row.last_notified_at).getTime() > REMIND_AFTER_MS;
  if (!due) return false;

  const first = row.occurrences === 1;
  await notify(
    `${finding.severity === "critical" ? "CRITICAL" : "WARNING"} ${key}\n${finding.detail}` +
      (first ? "" : `\n(firing since ${iso(row.first_seen_at)}, ${row.occurrences} checks)`),
  );
  if (!DRY) {
    await db.query(`UPDATE platform_alerts SET last_notified_at = now() WHERE key = $1`, [key]);
  }
  return true;
}

/** Announce a recovery exactly once. */
async function recordRecovery(db, key) {
  const {
    rows: [row],
  } = await db.query(
    `UPDATE platform_alerts
        SET state = 'ok', resolved_at = now(), updated_at = now()
      WHERE key = $1 AND state = 'firing'
      RETURNING first_seen_at, detail`,
    [key],
  );
  if (!row) return false;
  await notify(`RESOLVED ${key}\nWas: ${row.detail}\n(firing since ${iso(row.first_seen_at)})`);
  return true;
}

async function main() {
  const db = new Client({ connectionString: URL });
  await db.connect();

  if (LIST) {
    const { rows } = await db.query(
      `SELECT key, severity, detail, first_seen_at, occurrences, last_notified_at
         FROM platform_alerts WHERE state = 'firing'
        ORDER BY severity, first_seen_at`,
    );
    if (rows.length === 0) console.log("nothing firing");
    for (const r of rows) {
      console.log(
        `${r.severity.toUpperCase().padEnd(8)} ${r.key.padEnd(20)} since ${iso(r.first_seen_at)}` +
          `${r.last_notified_at === null ? "  [NEVER DELIVERED]" : ""}\n    ${r.detail}`,
      );
    }
    await db.end();
    return;
  }

  if (TEST_KEY) {
    // Proving the pipe works end to end. "An alert nobody has ever seen fire
    // has not been tested" - doc 49 P2's verification criterion, made runnable.
    await recordFiring(db, TEST_KEY, {
      severity: "warning",
      detail: "Test alert, fired by hand to prove the delivery path works. Ignore.",
    });
    await db.end();
    return;
  }

  const firing = [];
  const failed = [];
  for (const [key, check] of CHECKS) {
    let finding = null;
    try {
      finding = await check(db);
    } catch (err) {
      // A check that throws is a BUG IN THE MONITOR, and it must not silently
      // reduce coverage - that is this document's central lesson applied to
      // itself. It is reported as its own finding.
      failed.push(`${key}: ${err.message ?? err}`);
      continue;
    }
    if (finding) {
      firing.push({ key, ...finding });
      await recordFiring(db, key, finding);
    } else {
      await recordRecovery(db, key);
    }
  }

  if (failed.length > 0) {
    await recordFiring(db, "monitor_broken", {
      severity: "warning",
      detail: `${failed.length} check(s) threw: ${failed.join("; ")}`,
    });
  } else {
    await recordRecovery(db, "monitor_broken");
  }

  if (DIGEST) {
    const critical = firing.filter((f) => f.severity === "critical").length;
    const {
      rows: [stats],
    } = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'COMPLETE')::int AS complete
         FROM calls
        WHERE created_at > now() - interval '24 hours' AND status <> 'NO_AUDIO'`,
    );
    const rate =
      stats.total > 0 ? `${((stats.complete / stats.total) * 100).toFixed(0)}%` : "no calls";
    await notify(
      firing.length === 0
        ? `ALL CLEAR - ${CHECKS.length} checks passed. Transcription success last 24h: ${rate} (${stats.complete}/${stats.total}).`
        : `DAILY DIGEST - ${firing.length} firing (${critical} critical): ` +
            firing.map((f) => f.key).join(", ") +
            `. Transcription success last 24h: ${rate} (${stats.complete}/${stats.total}).`,
    );
  } else if (firing.length === 0) {
    console.log(`all clear - ${CHECKS.length} checks passed`);
  }

  await db.end();
  // Non-zero when something is critical, so a cron wrapper or a CI step can
  // react without parsing the output.
  process.exit(firing.some((f) => f.severity === "critical") ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
