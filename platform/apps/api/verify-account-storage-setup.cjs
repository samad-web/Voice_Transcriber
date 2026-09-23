/*
 * Runs doc 27's SQL - the setup guide's signals, the storage sweep, the
 * auth-context join, Plan & usage, sign-in history - against a real database,
 * and checks the RLS boundaries of the four new tables.
 *
 * Exists because typecheck cannot see SQL. The setup checklist alone reads
 * twenty-odd tables in one SELECT, compiled from a table of signals written by
 * reading migrations; ONE wrong column name there 500s the checklist for every
 * onboarding tenant, and nothing but a real Postgres will say so.
 *
 * The SQL is read out of the SOURCE files (each is an exported, non-
 * interpolated template literal), so this needs no build and runs exactly the
 * text the code runs.
 *
 * Everything happens inside ONE transaction that is rolled back at the end -
 * including the rows it inserts to exercise the upserts and the history table -
 * so it can be pointed at any database whose schema is current (0129+).
 * Never point it at production: see packages/db/verify-rls.js on why.
 *
 *   DATABASE_URL=postgres://aura:...@localhost:5433/callintel node apps/api/verify-account-storage-setup.cjs
 */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const shared = require("@aura/shared");

const ROOT = join(__dirname, "..", "..");

/** `export const NAME = \`...\`;` out of a source file, refusing interpolation. */
function sqlConst(relPath, name) {
  const source = readFileSync(join(ROOT, relPath), "utf8");
  const match = new RegExp(`export const ${name} = \`([\\s\\S]*?)\`;`).exec(source);
  if (!match) throw new Error(`${name} not found in ${relPath}`);
  if (match[1].includes("${")) throw new Error(`${name} interpolates - cannot be run verbatim`);
  return match[1];
}

const SQL = {
  setup: sqlConst("apps/api/src/modules/owner/setup.controller.ts", "SETUP_STATUS_SQL"),
  planUsage: sqlConst("apps/api/src/modules/owner/plan-usage.controller.ts", "PLAN_USAGE_SQL"),
  profileSelect: sqlConst("apps/api/src/modules/owner/business-profile.controller.ts", "BUSINESS_PROFILE_SELECT_SQL"),
  profileUpsert: sqlConst("apps/api/src/modules/owner/business-profile.controller.ts", "BUSINESS_PROFILE_UPSERT_SQL"),
  authEventInsert: sqlConst("apps/api/src/modules/account/auth-events.controller.ts", "AUTH_EVENT_INSERT_SQL"),
  loginActivity: sqlConst("apps/api/src/modules/account/auth-events.controller.ts", "LOGIN_ACTIVITY_SQL"),
  authContext: sqlConst("apps/api/src/modules/auth/auth.service.ts", "AUTH_CONTEXT_SQL"),
  storageSweep: sqlConst("apps/worker/src/pipeline/storage-usage.ts", "STORAGE_SWEEP_SQL"),
  storageDaily: sqlConst("apps/worker/src/pipeline/storage-usage.ts", "STORAGE_DAILY_SQL"),
};

let pass = 0;
let fail = 0;
const failures = [];
const ok = (label) => {
  pass++;
  console.log(`  ok   ${label}`);
};
const bad = (label, err) => {
  fail++;
  failures.push(`${label}: ${err}`);
  console.log(`  FAIL ${label}\n       ${String(err).split("\n")[0]}`);
};

/**
 * One check under a SAVEPOINT, so a failure does not abort the transaction and
 * hide every later check behind "current transaction is aborted".
 */
async function check(client, label, fn) {
  await client.query("SAVEPOINT s");
  try {
    const note = await fn();
    await client.query("RELEASE SAVEPOINT s");
    ok(note ? `${label} - ${note}` : label);
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT s");
    bad(label, err.message ?? err);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const setOrg = (client, orgId) => client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);

async function setupRow(client, orgId) {
  const {
    rows: [row],
  } = await client.query(SQL.setup, [orgId, null]);
  return row;
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString: url });
  await client.connect();

  const { rows: orgs } = await client.query(
    "SELECT id FROM organizations WHERE status = 'active' ORDER BY created_at LIMIT 1",
  );
  const orgA = orgs[0]?.id;
  if (!orgA) throw new Error("no active org in this database");
  // RLS only compares ids, so "another tenant" needs no row of its own.
  const orgB = randomUUID();

  await client.query("BEGIN");
  await setOrg(client, orgA);

  // The tenant-scoped queries run as `aura_app`, exactly as withOrg runs them
  // in a request. Connected as a superuser they would bypass RLS - FORCE does
  // not bind superusers - and count every org's rows: the SQL would still be
  // proved to parse, but a query that only works without RLS would pass.
  const { rows: appRole } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'aura_app'");
  const asApp = async () => {
    if (appRole.length) await client.query("SET LOCAL ROLE aura_app");
  };
  const asAdmin = () => client.query("RESET ROLE");
  await asApp();
  console.log(`\nSetup guide (org ${orgA}, as ${appRole.length ? "aura_app" : "the connecting role"})`);

  await check(client, "every setup signal is a non-null boolean", async () => {
    const row = await setupRow(client, orgA);
    assert(row, "no row for the org");
    const signals = Object.keys(row).filter((k) => k.startsWith("has_"));
    // One column per step, except `logo`, which is read from the branding
    // jsonb rather than a table of its own.
    const expected = shared.SETUP_STEPS.length - 1;
    assert(signals.length === expected, `${signals.length} has_* columns, expected ${expected}`);
    const wrong = signals.filter((k) => typeof row[k] !== "boolean");
    assert(wrong.length === 0, `not boolean: ${wrong.join(", ")}`);
    assert(Array.isArray(row.skipped), "skipped is not an array");
    assert(typeof row.viewer_can_pair === "boolean", "viewer_can_pair is not boolean");
    return `${signals.length} signals`;
  });

  await check(client, "the whole catalogue folds without a missing key", async () => {
    const row = await setupRow(client, orgA);
    const progressKeys = Object.keys(row).filter((k) => k.startsWith("has_")).length;
    const state = shared.setupState(
      { modules: row.enabled_modules, features: row.feature_overrides, available: ["meta_app", "call_access_gate"] },
      {},
    );
    assert(state.steps.length > 0, "no steps");
    return `${state.total} steps visible, ${progressKeys} signals`;
  });

  console.log("\nBusiness profile: SQL and businessProfileComplete() agree");
  const profileCases = [
    { label: "legal name + state (IN)", legal: "Acme Pvt Ltd", country: "IN", state: "27" },
    { label: "legal name, no state (IN)", legal: "Acme Pvt Ltd", country: "IN", state: null },
    { label: "no legal name", legal: null, country: "IN", state: "27" },
    { label: "outside India, no state", legal: "Acme LLC", country: "US", state: null },
  ];
  for (const c of profileCases) {
    await check(client, c.label, async () => {
      await client.query(SQL.profileUpsert, [
        orgA, c.legal, null, null, null, null, null, null, null, c.state, c.country, "INR", 4, null, null, null, null,
      ]);
      const row = await setupRow(client, orgA);
      const ts = shared.businessProfileComplete({ legalName: c.legal, country: c.country, stateCode: c.state });
      assert(row.has_business_profile === ts, `SQL says ${row.has_business_profile}, TypeScript says ${ts}`);
      const {
        rows: [profile],
      } = await client.query(SQL.profileSelect, [orgA]);
      assert(profile.country === c.country, "select did not read the row back");
      return `both ${ts}`;
    });
  }

  await check(client, "a skipped step comes back in the setup row", async () => {
    await client.query("INSERT INTO org_setup_step_skips (org_id, step_id) VALUES ($1, 'outreach')", [orgA]);
    const row = await setupRow(client, orgA);
    assert(row.skipped.includes("outreach"), `skipped = ${JSON.stringify(row.skipped)}`);
  });

  await check(client, "a GSTIN that fails the CHECK is refused", async () => {
    await client.query("SAVEPOINT g");
    try {
      await client.query("UPDATE org_business_profile SET gstin = 'not-a-gstin' WHERE org_id = $1", [orgA]);
      throw new Error("accepted a malformed GSTIN");
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT g");
      if (err.message === "accepted a malformed GSTIN") throw err;
      assert(err.code === "23514", `expected 23514, got ${err.code}: ${err.message}`);
    }
  });

  // The sweep, the context query and the history table are the worker's and
  // the API's ADMIN pool - cross-tenant by design.
  console.log("\nStorage (admin pool)");
  await asAdmin();
  await check(client, "the hourly sweep runs across every org", async () => {
    const res = await client.query(SQL.storageSweep);
    await client.query(SQL.storageDaily);
    const {
      rows: [row],
    } = await client.query("SELECT recording_bytes, recording_count FROM org_storage_usage WHERE org_id = $1", [orgA]);
    assert(row, "no snapshot row for the org");
    return `${res.rowCount} org(s) measured; org A holds ${row.recording_bytes} bytes in ${row.recording_count}`;
  });

  await check(client, "the sweep counts only uploaded recordings", async () => {
    const {
      rows: [expected],
    } = await client.query(
      "SELECT COALESCE(sum(bytes), 0)::bigint AS b FROM recordings WHERE org_id = $1 AND uploaded_at IS NOT NULL",
      [orgA],
    );
    const {
      rows: [got],
    } = await client.query("SELECT recording_bytes AS b FROM org_storage_usage WHERE org_id = $1", [orgA]);
    assert(String(expected.b) === String(got.b), `expected ${expected.b}, snapshot says ${got.b}`);
  });

  await check(client, "the auth-context join carries storage and the guide stamps", async () => {
    const {
      rows: [member],
    } = await client.query(
      `SELECT u.sso_subject, u.email FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND m.status = 'active' LIMIT 1`,
      [orgA],
    );
    if (!member) return "skipped - the org has no active member";
    const { rows } = await client.query(SQL.authContext, [member.sso_subject, member.email]);
    const row = rows.find((r) => r.orgId === orgA) ?? rows[0];
    for (const key of ["storageRecordingBytes", "storageComputedAt", "guideCompletedAt", "guideDismissedAt", "reportingTimezone"]) {
      assert(key in row, `missing ${key}`);
    }
    assert(row.storageComputedAt !== null, "no snapshot joined for the member's org");
  });

  await check(client, "Plan & usage runs, with the month starting on the 1st in the org's zone", async () => {
    const {
      rows: [row],
    } = await (async () => {
      // Plan & usage runs inside withOrg: as aura_app, under RLS.
      await asApp();
      try {
        return await client.query(SQL.planUsage, [orgA]);
      } finally {
        await asAdmin();
      }
    })();
    assert(row, "no row");
    assert(/^\d{4}-\d{2}-01$/.test(row.month_start), `month_start = ${row.month_start}`);
    return `month ${row.month_start}, ${row.calls} call(s), ${row.active_members} member(s)`;
  });

  await check(client, "storage_quota is an allowed notification kind", async () => {
    const {
      rows: [user],
    } = await client.query("SELECT user_id FROM memberships WHERE org_id = $1 LIMIT 1", [orgA]);
    if (!user) return "skipped - no member to address it to";
    await client.query(
      "INSERT INTO notifications (org_id, user_id, kind, title) VALUES ($1, $2, 'storage_quota', 'verify')",
      [orgA, user.user_id],
    );
  });

  console.log("\nSign-in history");
  const subjectA = randomUUID();
  const subjectB = randomUUID();
  await check(client, "events insert, and a page reads back only its own person", async () => {
    for (let i = 0; i < 3; i++) {
      await client.query(SQL.authEventInsert, [subjectA, null, "sign_in", randomUUID(), "owner", orgA, "203.0.113.9", "UA"]);
    }
    await client.query(SQL.authEventInsert, [subjectB, null, "sign_in_failed", null, null, null, null, null]);
    const { rows } = await client.query(SQL.loginActivity, [subjectA, 90, null, "0", 51]);
    assert(rows.length === 3, `expected 3 rows, got ${rows.length}`);
    assert(rows[0].ip === "203.0.113.9", `ip read back as ${rows[0].ip}`);
    assert(/Z$/.test(rows[0].cursor_at) && rows[0].cursor_at.includes("."), `cursor_at = ${rows[0].cursor_at}`);
  });

  await check(client, "the keyset cursor pages without losing a row", async () => {
    const first = await client.query(SQL.loginActivity, [subjectA, 90, null, "0", 2]);
    const last = first.rows[first.rows.length - 1];
    const second = await client.query(SQL.loginActivity, [subjectA, 90, last.cursor_at, last.id, 2]);
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    assert(new Set(ids).size === 3, `pages overlap or drop a row: ${ids.join(",")}`);
  });

  console.log("\nRLS");
  const { rows: roles } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'aura_app'");
  if (roles.length === 0) {
    console.log("  skip no aura_app role in this database");
  } else {
    for (const table of ["org_business_profile", "org_storage_usage", "org_storage_daily", "org_setup_step_skips"]) {
      await check(client, `another tenant sees none of org A's ${table}`, async () => {
        await client.query("SET LOCAL ROLE aura_app");
        await setOrg(client, orgB);
        const {
          rows: [row],
        } = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgA]);
        await client.query("RESET ROLE");
        await setOrg(client, orgA);
        assert(row.n === 0, `${row.n} row(s) visible across tenants`);
      });
    }
    await check(client, "aura_app is refused auth_events outright", async () => {
      await client.query("SET LOCAL ROLE aura_app");
      await client.query("SAVEPOINT r");
      try {
        await client.query("SELECT 1 FROM auth_events LIMIT 1");
        throw new Error("aura_app could read auth_events");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT r");
        if (err.message === "aura_app could read auth_events") throw err;
        assert(err.code === "42501", `expected permission denied (42501), got ${err.code}`);
      } finally {
        await client.query("RESET ROLE");
      }
    });
    await check(client, "aura_app can only READ the storage snapshot", async () => {
      await client.query("SET LOCAL ROLE aura_app");
      await setOrg(client, orgA);
      await client.query("SAVEPOINT w");
      try {
        await client.query("UPDATE org_storage_usage SET recording_bytes = 0 WHERE org_id = $1", [orgA]);
        throw new Error("aura_app could write org_storage_usage");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT w");
        if (err.message === "aura_app could write org_storage_usage") throw err;
        assert(err.code === "42501", `expected 42501, got ${err.code}`);
      } finally {
        await client.query("RESET ROLE");
      }
    });
  }

  await client.query("ROLLBACK");
  await client.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log(failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
