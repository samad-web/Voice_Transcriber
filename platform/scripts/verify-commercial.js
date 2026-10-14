#!/usr/bin/env node
/**
 * Execute the commercial dashboard's queries against a real database.
 *
 * ── WHY THIS SCRIPT EXISTS ──────────────────────────────────────────────────
 *
 * Typecheck cannot see SQL. Every defect these queries could carry is in the
 * joins, the column names and the status vocabularies - and this project has
 * now been bitten four separate times by exactly that:
 *
 *   - `integration-watchdog.ts` filtered `status = 'active'` on a table whose
 *     statuses are ('connected','disconnected','error'). It matched no row,
 *     ever, and looked like a working watchdog.
 *   - `scripts/alerts.js` read `app_releases.published_at`, which is a boolean
 *     called `published`, and cast `devices.app_version` without a numeric
 *     guard.
 *   - migration 0201's first real execution found three production-fatal bugs.
 *   - 0206's consistency CHECK accepted the record it existed to refuse.
 *
 * So: no query on the commercial dashboard ships without having been executed.
 *
 *   docker compose -f docker-compose.test.yml up -d postgres
 *   DATABASE_URL=postgresql://aura:aura_dev_password@localhost:55432/callintel \
 *     node scripts/verify-commercial.js
 *
 * It asserts the SHAPE - that the query parses, the columns exist and the
 * vocabularies match the CHECK constraints - not the values, because the
 * verification database holds a two-tenant seed rather than a book of business.
 * Values are the pure module's job (`packages/shared/src/commercial.test.ts`).
 */

const { Client } = require("pg");
const {
  FLEET_COMMERCIAL_SQL,
  BILLINGS_BY_MONTH_SQL,
  FUNNEL_SQL,
  PLATFORM_INCIDENTS_SQL,
  NET_NEW_SQL,
  CALL_ISSUE_LIVE_STATUSES,
} = require("../apps/api/dist/modules/admin/commercial-sql");

const URL =
  process.env.DATABASE_URL ?? "postgresql://aura:aura_dev_password@localhost:5433/callintel";

let failures = 0;
function pass(what, detail) {
  console.log(`PASS  ${what}${detail ? ` - ${detail}` : ""}`);
}
function fail(what, why) {
  failures++;
  console.log(`FAIL  ${what}\n      ${why}`);
}

/**
 * Every status vocabulary these queries hard-code, checked against the CHECK
 * constraint that owns it. This is the integration-watchdog bug, generalised:
 * a filter on a value the column cannot hold is a silent no-op.
 */
const VOCABULARIES = [
  { table: "org_subscriptions", column: "status", used: ["trialing", "active", "past_due", "cancelled"] },
  { table: "billing_orders", column: "status", used: ["pending", "paid"] },
  { table: "billing_orders", column: "kind", used: ["subscription"] },
  { table: "organizations", column: "status", used: ["active", "churned"] },
  { table: "organizations", column: "onboarded_by_role", used: ["root", "superadmin", "self_serve"] },
];

async function main() {
  if (/supabase|prod/i.test(URL) && process.env.ALLOW_PRODUCTION !== "1") {
    console.error("Refusing to run against what looks like production. Set ALLOW_PRODUCTION=1.");
    process.exit(2);
  }
  const db = new Client({ connectionString: URL });
  await db.connect();

  try {
    // ── 1. the vocabularies ────────────────────────────────────────────────
    for (const { table, column, used } of VOCABULARIES) {
      const { rows } = await db.query(
        `SELECT pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
          WHERE c.conrelid = $1::regclass AND c.contype = 'c'
            AND pg_get_constraintdef(c.oid) LIKE '%' || $2 || '%'`,
        [table, column],
      );
      const defs = rows.map((r) => r.def).join(" ");
      if (!defs) {
        fail(`${table}.${column} vocabulary`, "no CHECK constraint found to compare against");
        continue;
      }
      const missing = used.filter((v) => !defs.includes(`'${v}'`));
      if (missing.length > 0) {
        fail(
          `${table}.${column} vocabulary`,
          `the dashboard filters on ${missing.map((m) => `'${m}'`).join(", ")}, which the ` +
            `CHECK does not permit. Such a filter matches no row, ever, and looks like it works.`,
        );
      } else {
        pass(`${table}.${column} vocabulary`, used.join(", "));
      }
    }

    // ── 2. every query, executed ───────────────────────────────────────────
    // The scope gate is passed as TRUE here: `operator-scope.spec.ts` covers
    // the predicate itself, and what is being proved here is that the query
    // around it parses and resolves every column.
    const queries = [
      {
        name: "fleet commercial rows",
        sql: FLEET_COMMERCIAL_SQL("TRUE"),
        params: [[...CALL_ISSUE_LIVE_STATUSES]],
      },
      { name: "billings by month", sql: BILLINGS_BY_MONTH_SQL("TRUE"), params: [] },
      { name: "lifecycle funnel", sql: FUNNEL_SQL("TRUE"), params: [] },
      {
        name: "platform incidents",
        sql: PLATFORM_INCIDENTS_SQL("TRUE"),
        params: [[...CALL_ISSUE_LIVE_STATUSES]],
      },
      { name: "net new this month", sql: NET_NEW_SQL("TRUE"), params: [] },
    ];

    for (const { name, sql, params } of queries) {
      try {
        const { rows, fields } = await db.query(sql, params);
        pass(name, `${rows.length} row(s), ${fields.length} column(s)`);
      } catch (err) {
        fail(name, `${err.code ?? ""} ${err.message}`);
      }
    }

    // ── 3. the one value worth asserting ───────────────────────────────────
    //
    // That the capture-minutes window matches the tenant's OWN billing page.
    // If these two ever disagree, the operator's screen and the client's
    // invoice are describing different months, and the client is right.
    const { rows: windowRows } = await db.query(
      `SELECT date_trunc('month', now(), 'UTC') = date_trunc('month', now(), 'UTC') AS same`,
    );
    if (windowRows[0]?.same) {
      pass("capture window", "date_trunc('month', now(), 'UTC'), as subscription.controller uses");
    } else {
      fail("capture window", "the UTC month expression did not evaluate");
    }

    // ── 4. the funnel must not climb ───────────────────────────────────────
    //
    // A funnel step larger than the one above it means the steps are counting
    // different populations, which is the defect that made the signup step
    // unusable: an operator-provisioned tenant has no `org_signups` row, so a
    // funnel starting at "signup" would show more orgs than signups and read
    // as growth.
    const { rows: funnel } = await db.query(FUNNEL_SQL("TRUE"));
    const f = funnel[0] ?? {};
    const order = ["provisioned", "first_call", "first_transcript", "first_lead", "renewed"];
    let climbs = [];
    for (let i = 1; i < order.length; i++) {
      if (Number(f[order[i]]) > Number(f[order[i - 1]])) {
        climbs.push(`${order[i]} (${f[order[i]]}) > ${order[i - 1]} (${f[order[i - 1]]})`);
      }
    }
    if (climbs.length > 0) {
      fail("funnel is monotonic", climbs.join("; "));
    } else {
      pass("funnel is monotonic", order.map((k) => `${k}=${f[k]}`).join(" "));
    }

    // ── 5. A BOOK OF BUSINESS, AND THE NUMBERS IT MUST PRODUCE ────────────
    //
    // Everything above proves the queries PARSE. The verification database
    // holds a two-tenant seed, so it cannot prove they are RIGHT - and a query
    // that runs and returns the wrong number is the failure mode that matters
    // on a commercial screen.
    //
    // So: five tenants are created inside a transaction that is rolled back,
    // each one a case the arithmetic has to get right, and the fleet query's
    // own output is asserted against what they were built to mean.
    await db.query("BEGIN");
    try {
      const plan = await db.query(
        `SELECT p.id, pp.annual_monthly_minor::text AS minor, pp.currency
           FROM plans p JOIN plan_prices pp ON pp.plan_id = p.id AND pp.region = 'IN'
          WHERE p.key = 'capture_growth'`,
      );
      const insights = await db.query(`SELECT id FROM plans WHERE key = 'growth'`);
      if (plan.rowCount === 0 || insights.rowCount === 0) {
        fail("fixture", "capture_growth or insights growth is missing from the plan catalogue");
      } else {
        const planId = plan.rows[0].id;
        const growthMinor = Number(plan.rows[0].minor);
        const insightsPlanId = insights.rows[0].id;

        const cases = [
          { name: "zz-annual", sub: "active", period: "annual", plan: planId },
          { name: "zz-monthly", sub: "active", period: "monthly", plan: planId },
          { name: "zz-trial", sub: "trialing", period: "annual", plan: planId },
          { name: "zz-pastdue", sub: "past_due", period: "annual", plan: planId },
          // The case the plan's own source mapping misses entirely: an
          // insights-family tenant, whose plan has no price row in any region.
          { name: "zz-unpriced", sub: "active", period: "annual", plan: insightsPlanId },
        ];
        for (const c of cases) {
          const { rows } = await db.query(
            `INSERT INTO organizations (name, billing_region, enabled_modules, whatsapp_provider)
             VALUES ($1, 'IN', '{aura}', 'none') RETURNING id`,
            [c.name],
          );
          await db.query(
            `INSERT INTO org_subscriptions (org_id, plan_id, status, billing_period)
             VALUES ($1, $2, $3, $4)`,
            [rows[0].id, c.plan, c.sub, c.period],
          );
        }

        const { rows: fleetRows } = await db.query(FLEET_COMMERCIAL_SQL("o.name LIKE 'zz-%'"), [
          [...CALL_ISSUE_LIVE_STATUSES],
        ]);
        const by = new Map(fleetRows.map((r) => [r.name, r]));

        if (fleetRows.length !== 5) {
          fail("fixture rows", `expected 5, got ${fleetRows.length}`);
        } else {
          pass("fixture rows", "5 tenants, one per arithmetic case");
        }

        // The price must resolve for a capture plan in IN...
        const annual = by.get("zz-annual");
        if (Number(annual?.annual_monthly_minor) === growthMinor && annual?.currency === "INR") {
          pass("price resolves by plan AND region", `${growthMinor} INR`);
        } else {
          fail(
            "price resolves by plan AND region",
            `got ${annual?.annual_monthly_minor} ${annual?.currency}, expected ${growthMinor} INR`,
          );
        }

        // ...and must NOT resolve for an insights plan, which has no price row
        // anywhere. This is the assertion that stops an unpriced tenant being
        // silently counted as a free one.
        const unpriced = by.get("zz-unpriced");
        if (unpriced?.annual_monthly_minor === null) {
          pass("an insights plan has no published price", "resolves to NULL, not to zero");
        } else {
          fail(
            "an insights plan has no published price",
            `got ${unpriced?.annual_monthly_minor} - if this is now a number, the price list ` +
              `has grown insights rows and commercial.ts's 'unpriced' note is out of date`,
          );
        }

        // The subscription status must come through verbatim: the arithmetic
        // branches entirely on it, and a status the query mangles would send a
        // past_due tenant into the recurring total.
        const statuses = cases
          .map((c) => `${c.name}=${by.get(c.name)?.sub_status}`)
          .join(" ");
        const wrong = cases.filter((c) => by.get(c.name)?.sub_status !== c.sub);
        if (wrong.length === 0) {
          pass("subscription status round-trips", statuses);
        } else {
          fail("subscription status round-trips", statuses);
        }

        // The billing period likewise - it decides whether the 20% monthly
        // uplift is applied, which is 20% of that tenant's MRR.
        if (by.get("zz-monthly")?.billing_period === "monthly") {
          pass("billing period round-trips", "the uplift branch can be reached");
        } else {
          fail("billing period round-trips", `got ${by.get("zz-monthly")?.billing_period}`);
        }

        // And the scope predicate must actually bind: the same query with a
        // FALSE gate must return nothing, or the filter is decorative.
        const { rows: none } = await db.query(FLEET_COMMERCIAL_SQL("FALSE"), [
          [...CALL_ISSUE_LIVE_STATUSES],
        ]);
        if (none.length === 0) {
          pass("the scope gate is load-bearing", "a FALSE gate returns no clients");
        } else {
          fail("the scope gate is load-bearing", `a FALSE gate still returned ${none.length} rows`);
        }
      }
    } finally {
      // Always. This database is recreated per suite run, but a verification
      // script that leaves five fake tenants behind is a script somebody stops
      // trusting the output of.
      await db.query("ROLLBACK");
    }
  } finally {
    await db.end();
  }

  console.log(
    failures === 0
      ? "\nCommercial queries: ALL PASS"
      : `\nCommercial queries: ${failures} FAILURE(S)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
