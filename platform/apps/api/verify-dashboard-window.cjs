/*
 * Runs the dashboard's two endpoints (GET /v1/owner/overview and
 * /crm-overview) against a real database for a CUSTOM date range and for the
 * "last N days" preset, and checks the figures against calls whose answers are
 * known in advance.
 *
 * Exists for the reason verify-call-insights.cjs does: the dashboard is one
 * multi-statement batch of generated SQL, invisible to `tsc`. This proves
 * Postgres accepts every statement for both window kinds, and - the part only
 * a database can show - that a custom range has BOTH edges in the org's
 * calendar: a call at 00:10 IST on 1 July is outside a range ending 30 June,
 * even though it is still 30 June in UTC.
 *
 * Nothing persists. It seeds a throwaway org inside ONE transaction, calls the
 * controller with a DbService that hands it that transaction as `aura_app`
 * with `app.org_id` set (as a request would), and rolls everything back. It
 * must connect as a role that may create rows and `SET ROLE aura_app` (the
 * local `aura` superuser does). Never point it at production.
 *
 *   pnpm --filter @aura/api build
 *   DATABASE_URL=postgres://aura:<pw>@localhost:5433/callintel node apps/api/verify-dashboard-window.cjs
 */
const { Client } = require("pg");
const { OwnerController } = require("./dist/modules/owner/owner.controller");

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

async function rejects(label, fn) {
  try {
    await fn();
    fail++;
    console.log(`  FAIL ${label}\n       expected a 400, got an answer`);
  } catch (err) {
    const status = err?.getStatus?.();
    if (status === 400) {
      pass++;
      console.log(`  ok   ${label}`);
    } else {
      fail++;
      console.log(`  FAIL ${label}\n       expected a 400, got ${status ?? err?.message}`);
    }
  }
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  if (/supabase|pooler|sirahagents/i.test(url)) throw new Error("refusing to run against what looks like production");
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("BEGIN");

  try {
    const q = (sql, params) => client.query(sql, params).then((r) => r.rows);
    const [org] = await q(
      `INSERT INTO organizations (name, reporting_timezone) VALUES ('Verify Dashboard Window', 'Asia/Kolkata') RETURNING id`,
    );
    const orgId = org.id;
    const [ws] = await q(`INSERT INTO workspaces (org_id, name) VALUES ($1, 'Sales') RETURNING id`, [orgId]);
    const [inst] = await q(`INSERT INTO instances (org_id, workspace_id, name) VALUES ($1, $2, 'Main') RETURNING id`, [
      orgId,
      ws.id,
    ]);
    const [dev] = await q(
      `INSERT INTO devices (org_id, instance_id, public_key, label) VALUES ($1, $2, 'verify-dash-key', 'Handset 1') RETURNING id`,
      [orgId, inst.id],
    );

    // [label, started_at (UTC), direction, duration]
    const calls = [
      // ── In the range, 1-30 June 2026 IST ──
      ["c1", "2026-05-31T18:35:00Z", "outgoing", 120], // 00:05 IST on 1 June
      ["c2", "2026-06-10T05:00:00Z", "incoming", 60],
      ["c3", "2026-06-10T08:00:00Z", "incoming", 0],
      ["c4", "2026-06-10T08:20:00Z", "incoming", 0],
      ["c5", "2026-06-15T06:00:00Z", "outgoing", 300],
      ["c6", "2026-06-30T18:00:00Z", "outgoing", 30], // 23:30 IST on 30 June
      // ── After it ──
      ["x1", "2026-06-30T18:40:00Z", "outgoing", 45], // 00:10 IST on 1 July
      ["x2", "2026-07-05T06:00:00Z", "incoming", 0],
      // ── The previous 30 days, 2-31 May IST ──
      ["p1", "2026-05-10T06:00:00Z", "outgoing", 100],
      ["p2", "2026-05-20T06:00:00Z", "incoming", 0],
      // ── Before that - counted nowhere ──
      ["z1", "2026-04-01T06:00:00Z", "outgoing", 100],
    ];
    for (const [label, at, direction, duration] of calls) {
      await q(
        `INSERT INTO calls (org_id, workspace_id, device_id, direction, started_at, duration_s, status, remote_name)
         VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETE', $7)`,
        [orgId, ws.id, dev.id, direction, at, duration, `Customer ${label}`],
      );
    }
    // Leads: one created in the range, one after it, one in the previous window.
    for (const [title, at] of [
      ["In range", "2026-06-15T06:00:00Z"],
      ["After range", "2026-07-02T06:00:00Z"],
      ["Previous window", "2026-05-15T06:00:00Z"],
    ]) {
      await q(`INSERT INTO leads (org_id, workspace_id, title, created_at, stage_changed_at) VALUES ($1, $2, $3, $4, $4)`, [
        orgId,
        ws.id,
        title,
        at,
      ]);
    }

    // ── Read back as the app role, exactly as a request would ──
    await client.query("SET ROLE aura_app");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const db = { withOrg: async (_orgId, fn) => fn(client) };
    const controller = new OwnerController(db);
    const owner = { role: "owner", scope: "all", userId: null, telecallerId: null };

    for (const [name, read] of [
      ["overview", (query) => controller.overview(orgId, query, owner)],
      ["crm-overview", (query) => controller.crmOverview(orgId, query, owner)],
    ]) {
      console.log(`\n${name}: a custom range, 1-30 June`);
      const r = await read({ from: "2026-06-01", to: "2026-06-30" });
      check("echoes the range, its length and that it is custom", r.window, {
        days: 30,
        custom: true,
        from: "2026-06-01",
        to: "2026-06-30",
        timezone: "Asia/Kolkata",
      });
      check("counts the six calls on June's IST days, not UTC's", r.calls.total, 6);
      check("splits them by state", [r.calls.outgoing, r.calls.answered, r.calls.missed], [3, 1, 2]);
      check("compares with the 30 days before (2-31 May)", [r.previous.calls, r.previous.missed], [2, 1]);
      check("one row per day of the range, first to last", [r.byDay.length, r.byDay[0]?.day, r.byDay.at(-1)?.day], [
        30,
        "2026-06-01",
        "2026-06-30",
      ]);
      check(
        "files the 00:05 and 23:30 IST calls on their own days",
        [r.byDay[0]?.calls, r.byDay.at(-1)?.calls],
        [1, 1],
      );
      check("the leaderboard stops at the range's end too", r.telecallers.map((t) => t.calls), [6]);
      const heat = r.callHeat.reduce((sum, c) => sum + c.inbound, 0);
      check("the heatmap counts only the range's inbound calls", heat, 3);
      if (name === "overview") {
        check("counts the one lead created in the range", r.leads.created_in_window, 1);
        check("and the previous window's lead against it", r.previous.leads_created, 1);
        check("response speed counts only the range's arrivals", r.response?.leads, 1);
      }

      console.log(`${name}: one day`);
      const day = await read({ from: "2026-06-10", to: "2026-06-10" });
      check("a single day is a range of one", [day.window.days, day.byDay.length, day.calls.total], [1, 1, 3]);

      console.log(`${name}: the preset, last 30 days`);
      const rel = await read({ days: "30" });
      check("is not custom, and is 30 days ending today", [rel.window.custom, rel.window.days, rel.byDay.length], [
        false,
        30,
        30,
      ]);
      check("ends on the org's today", rel.byDay.at(-1)?.day, rel.window.to);

      console.log(`${name}: what it refuses`);
      await rejects("a from with no to", () => read({ from: "2026-06-01" }));
      await rejects("a reversed pair", () => read({ from: "2026-06-30", to: "2026-06-01" }));
      await rejects("a date that is not on the calendar", () => read({ from: "2026-02-31", to: "2026-03-01" }));
      await rejects("more than 366 days", () => read({ from: "2025-01-01", to: "2026-06-30" }));
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
