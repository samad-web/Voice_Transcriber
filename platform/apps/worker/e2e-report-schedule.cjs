/*
 * Drives the scheduled-delivery sweep once, against a running API and the dev
 * database, and asserts the property that matters most about it:
 *
 *   the report is rendered and frozen, an IN-APP notification is written, and
 *   NOTHING is queued for an outbound channel.
 *
 * That last one is Aura's third safety rule (design doc D6), and it is checked
 * here by counting rows in every outbox table before and after.
 *
 * Creates a report + schedule, runs the sweep, then removes everything it made.
 *
 *   node apps/worker/e2e-report-schedule.cjs
 */
const { Client } = require("pg");
const { runReportScheduleSweep } = require("./dist/pipeline/report-schedules");

const API = process.env.API_URL || "http://localhost:4000";
const ORG = process.env.E2E_ORG;
const USER = process.env.E2E_USER;
const KEY = process.env.ADMIN_API_KEY || "dev-admin-key";
if (!ORG || !USER) throw new Error("E2E_ORG and E2E_USER are required");

const headers = {
  "content-type": "application/json",
  "x-admin-key": KEY,
  "x-org-id": ORG,
  "x-caller-user-id": USER,
};

let pass = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
};

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text), text };
  } catch {
    return { status: res.status, body: {}, text };
  }
}

/**
 * Every table in this schema that means "something will be sent to a person
 * outside the console". Verified against information_schema rather than
 * guessed - a probe that names a table which does not exist passes silently
 * and proves nothing, which is the failure this list previously had.
 */
const OUTBOX_TABLES = [
  // The marketing funnel's own outbox - WhatsApp rejections and follow-ups,
  // drained by startFollowUpDrain().
  "marketing.funnel_followups",
  // Pre-call reminders and the no-show drip, drained by
  // startBookingNotificationDrain().
  "marketing.booking_notifications",
  // Outbound WhatsApp/email on a conversation. An outgoing row here IS a sent
  // message.
  "public.conversation_messages",
  // A due outreach step is work for a person, not a send - but a row appearing
  // here because of a REPORT would still mean this feature reached into the
  // follow-up ladder, which it must not.
  "public.outreach_journey_steps",
];

async function outboxCounts(client) {
  const counts = {};
  for (const table of OUTBOX_TABLES) {
    try {
      const { rows } = await client.query(`SELECT count(*)::int n FROM ${table}`);
      counts[table] = rows[0].n;
    } catch (err) {
      // A table that cannot be counted is NOT a pass. Recording the error means
      // the assertion below fails loudly instead of quietly checking nothing.
      counts[table] = `unreadable: ${String(err.message).slice(0, 60)}`;
    }
  }
  return counts;
}

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("SELECT set_config('app.org_id', $1, false)", [ORG]);

  let reportId = null;
  let datasetId = null;

  try {
    // ── set up a published report with a due schedule ─────────────────────
    const ds = await call("POST", "/v1/report-datasets", {
      kind: "crm",
      sourceKey: "leads",
      name: `E2E sched leads ${Date.now()}`,
    });
    datasetId = ds.body.dataset.id;

    const rep = await call("POST", "/v1/report-builder", { name: `E2E scheduled ${Date.now()}` });
    reportId = rep.body.report.id;

    await call("PATCH", `/v1/report-builder/${reportId}`, {
      revision: 0,
      doc: {
        version: 1,
        theme: { preset: "minimal", paletteId: "corporate-navy" },
        pages: [
          {
            id: "p1",
            name: "Page 1",
            filters: [],
            widgets: [
              {
                id: "w1",
                type: "chart",
                chart: "bar",
                title: "Leads by stage",
                layout: { x: 0, y: 0, w: 6, h: 8 },
                datasetId,
                options: {},
                respondsToPageFilters: true,
                query: {
                  dimensions: [{ column: "stage" }],
                  measures: [{ agg: "count", alias: "Leads" }],
                  filters: [],
                  derived: [],
                },
              },
            ],
          },
        ],
      },
    });
    await call("POST", `/v1/report-builder/${reportId}/publish`);

    const sched = await call("POST", `/v1/report-builder/${reportId}/schedules`, {
      cadence: "daily",
      hourUtc: 6,
      recipients: [USER],
    });
    check("schedule created", sched.status === 201, sched.text.slice(0, 200));
    const scheduleId = sched.body.schedule.id;

    // Make it due. This is the only thing the sweep is waiting for.
    await client.query(
      `UPDATE report_schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
      [scheduleId],
    );

    const before = await outboxCounts(client);
    const { rows: notesBefore } = await client.query(
      `SELECT count(*)::int n FROM notifications WHERE user_id = $1`,
      [USER],
    );

    // ── run the sweep ─────────────────────────────────────────────────────
    console.log("\nRunning the sweep");
    const delivered = await runReportScheduleSweep();
    check("the sweep delivered one run", delivered >= 1, `returned ${delivered}`);

    // ── what it produced ──────────────────────────────────────────────────
    const { rows: runs } = await client.query(
      `SELECT id, status, error, snapshot IS NOT NULL AS has_snapshot, recipients
         FROM report_runs WHERE report_id = $1 AND schedule_id = $2`,
      [reportId, scheduleId],
    );
    check("a run row was written", runs.length === 1, JSON.stringify(runs));
    check("it succeeded", runs[0]?.status === "succeeded", JSON.stringify(runs[0]));
    check("it froze a snapshot", runs[0]?.has_snapshot === true);
    check("it recorded its audience", runs[0]?.recipients?.includes(USER));

    const { rows: notes } = await client.query(
      `SELECT kind, title, link_path, dedupe_key FROM notifications
        WHERE user_id = $1 AND kind = 'report_ready' ORDER BY created_at DESC LIMIT 1`,
      [USER],
    );
    check("an in-app notification was written", notes.length === 1, JSON.stringify(notes));
    check("it is kind 'report_ready'", notes[0]?.kind === "report_ready");
    check(
      "it links to the frozen run, not the live report",
      notes[0]?.link_path === `/owner/reports/builder/${reportId}/runs/${runs[0].id}`,
      notes[0]?.link_path,
    );
    check("it is deduped on the RUN, so a retry cannot double-notify",
      notes[0]?.dedupe_key === `report-run:${runs[0].id}`);

    // ── THE SAFETY RULE ───────────────────────────────────────────────────
    console.log("\nSafety rule 3: nothing automated sends");
    const after = await outboxCounts(client);
    for (const table of OUTBOX_TABLES) {
      check(
        `${table} is unchanged (${before[table]} rows)`,
        typeof before[table] === "number" && before[table] === after[table],
        `${before[table]} -> ${after[table]}`,
      );
    }
    const { rows: notesAfter } = await client.query(
      `SELECT count(*)::int n FROM notifications WHERE user_id = $1`,
      [USER],
    );
    check(
      "the ONLY thing produced for the recipient is one in-app notification",
      notesAfter[0].n === notesBefore[0].n + 1,
      `${notesBefore[0].n} -> ${notesAfter[0].n}`,
    );

    // ── the claim is idempotent ───────────────────────────────────────────
    console.log("\nRe-running immediately");
    const again = await runReportScheduleSweep();
    check("a second sweep does nothing - next_run_at was already advanced", again === 0,
      `returned ${again}`);

    const { rows: nextRun } = await client.query(
      `SELECT next_run_at > now() AS future FROM report_schedules WHERE id = $1`,
      [scheduleId],
    );
    check("the schedule was rolled forward", nextRun[0]?.future === true);
  } finally {
    console.log("\nCleanup");
    if (reportId) {
      await client.query(`DELETE FROM notifications WHERE link_path LIKE $1`, [
        `/owner/reports/builder/${reportId}%`,
      ]);
      await client.query(`DELETE FROM reports WHERE id = $1`, [reportId]);
      console.log(`  removed report ${reportId} (runs and schedules cascade)`);
    }
    if (datasetId) {
      await client.query(`DELETE FROM report_datasets WHERE id = $1`, [datasetId]);
      console.log(`  removed dataset ${datasetId}`);
    }
    await client.end();
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
