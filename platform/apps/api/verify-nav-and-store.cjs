/*
 * Runs the Integrations store's SQL (doc 28 §19.3) against a real database and
 * checks the one table the store added, integration_pending_choices (0131).
 *
 * Exists because typecheck cannot see SQL. The store's status is a dozen-
 * statement batch across every provider table; one wrong column name 500s the
 * Integrations page for every tenant, and only a real Postgres says so.
 *
 * The SQL comes from the BUILT module (dist/modules/owner/integration-sql.js),
 * so this runs exactly the strings the controller sends - build the API first:
 *
 *   pnpm --filter ./apps/api build
 *   DATABASE_URL=postgres://aura:...@localhost:5433/callintel node apps/api/verify-nav-and-store.cjs
 *
 * Everything happens inside ONE transaction that is rolled back at the end,
 * including the rows it inserts. Never point it at production: see
 * packages/db/verify-rls.js on why.
 */
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { Client } = require("pg");
const shared = require("@aura/shared");

const { SNAPSHOT_SQL, activityStatements } = require(join(__dirname, "dist", "modules", "owner", "integration-sql.js"));

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

/** One check under a SAVEPOINT, so a failure does not abort every later check. */
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

/** Expect `fn` to be refused by the database; returns the refusal's code. */
async function refused(client, fn) {
  await client.query("SAVEPOINT r");
  try {
    await fn();
  } catch (err) {
    await client.query("ROLLBACK TO SAVEPOINT r");
    return err.code ?? "error";
  }
  await client.query("RELEASE SAVEPOINT r");
  return null;
}

const setOrg = (client, orgId) => client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString: url });
  await client.connect();

  const { rows: orgs } = await client.query(
    `SELECT o.id, m.user_id
       FROM organizations o
       JOIN memberships m ON m.org_id = o.id
      WHERE o.status = 'active'
      ORDER BY o.created_at
      LIMIT 1`,
  );
  const orgA = orgs[0]?.id;
  const userA = orgs[0]?.user_id;
  if (!orgA || !userA) throw new Error("no active org with a member in this database");
  // RLS only compares ids, so "another tenant" needs no row of its own.
  const orgB = randomUUID();

  await client.query("BEGIN");

  console.log("\nintegration_pending_choices (0131): the table itself");
  await check(client, "row-level security is enabled AND forced", async () => {
    const {
      rows: [t],
    } = await client.query(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'integration_pending_choices'",
    );
    assert(t, "table missing - is 0131 applied?");
    assert(t.relrowsecurity && t.relforcerowsecurity, "RLS not enabled and forced");
  });
  await check(client, "aura_app holds exactly SELECT, INSERT, DELETE", async () => {
    const { rows } = await client.query(
      `SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
         FROM information_schema.role_table_grants
        WHERE table_name = 'integration_pending_choices' AND grantee = 'aura_app'`,
    );
    assert(rows[0]?.privs === "DELETE,INSERT,SELECT", `aura_app holds ${rows[0]?.privs ?? "nothing"}`);
    return rows[0].privs;
  });

  // Everything tenant-scoped runs as aura_app, exactly as withOrg runs it in a
  // request. Connected as a superuser it would bypass RLS - FORCE does not
  // bind superusers - and a query that only works without RLS would pass.
  await client.query("SET LOCAL ROLE aura_app");
  await setOrg(client, orgA);

  console.log(`\nintegration_pending_choices: isolation (org ${orgA}, as aura_app)`);
  let mine = null;
  await check(client, "a tenant can park a choice of its own", async () => {
    const {
      rows: [row],
    } = await client.query(
      `INSERT INTO integration_pending_choices (org_id, user_id, provider, payload)
       VALUES ($1, $2, 'meta', 'sealed') RETURNING id`,
      [orgA, userA],
    );
    mine = row.id;
  });
  await check(client, "…but not one for another tenant (WITH CHECK)", async () => {
    const code = await refused(client, () =>
      client.query(
        `INSERT INTO integration_pending_choices (org_id, user_id, provider, payload)
         VALUES ($1, $2, 'meta', 'sealed')`,
        [orgB, userA],
      ),
    );
    assert(code, "the insert for another org went through");
    return `refused ${code}`;
  });
  await check(client, "…and cannot UPDATE a choice at all", async () => {
    const code = await refused(client, () =>
      client.query("UPDATE integration_pending_choices SET payload = 'x' WHERE id = $1", [mine]),
    );
    assert(code === "42501", `expected permission denied, got ${code}`);
  });
  await check(client, "another tenant sees none of it", async () => {
    await setOrg(client, orgB);
    const { rows } = await client.query("SELECT id FROM integration_pending_choices");
    await setOrg(client, orgA);
    assert(rows.length === 0, `org B saw ${rows.length} row(s)`);
  });
  await check(client, "an expired choice is not pending, and the sweep removes it", async () => {
    await client.query(
      `INSERT INTO integration_pending_choices (org_id, user_id, provider, payload, expires_at)
       VALUES ($1, $2, 'meta', 'sealed', now() - interval '1 minute')`,
      [orgA, userA],
    );
    const pendingSql = SNAPSHOT_SQL[SNAPSHOT_SQL.length - 1];
    const { rows: live } = await client.query(pendingSql);
    assert(live.every((r) => r.id === mine || r.id !== undefined), "unexpected shape");
    const { rows: stale } = await client.query(
      "SELECT id FROM integration_pending_choices WHERE expires_at <= now()",
    );
    assert(stale.length === 1, `expected one expired row, saw ${stale.length}`);
    assert(!live.some((r) => r.id === stale[0].id), "an expired choice read as pending");
    const { rowCount } = await client.query("DELETE FROM integration_pending_choices WHERE expires_at < now()");
    assert(rowCount === 1, `the sweep removed ${rowCount}`);
  });

  console.log("\nThe store's status batch");
  await check(client, "runs in one round trip and returns every result set", async () => {
    const results = await client.query(SNAPSHOT_SQL.join(";\n"));
    const sets = Array.isArray(results) ? results : [results];
    assert(sets.length === SNAPSHOT_SQL.length, `${sets.length} result sets for ${SNAPSHOT_SQL.length} statements`);
    const org = sets[0].rows[0];
    assert(org && Array.isArray(org.modules), "the org row has no modules array");
    return `${sets.length} statements`;
  });
  await check(client, "sees only this tenant's rows (the pending choice counts once)", async () => {
    const results = await client.query(SNAPSHOT_SQL.join(";\n"));
    const pending = results[results.length - 1].rows;
    assert(pending.length === 1 && pending[0].id === mine, `pending read ${pending.length} row(s)`);
  });

  console.log("\nEvery app's activity statements");
  for (const spec of shared.storeIntegrations()) {
    const statements = activityStatements(spec.id);
    if (statements.length === 0) continue;
    await check(client, spec.id, async () => {
      let rows = 0;
      for (const sql of statements) rows += (await client.query(sql)).rows.length;
      return `${statements.length} statement(s), ${rows} row(s)`;
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
