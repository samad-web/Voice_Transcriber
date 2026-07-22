/**
 * RLS enforcement test (checklist §2.1): proves cross-tenant reads and writes
 * fail at the DB layer for the app role. Seeds as admin, asserts as aura_app.
 */
const { Client } = require("pg");
const { sslFor } = require("./ssl");

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgresql://aura:aura_dev_password@localhost:5433/callintel";
const APP_URL =
  process.env.APP_DATABASE_URL ??
  "postgresql://aura_app:aura_app_password@localhost:5433/callintel";

let failures = 0;
function assert(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL, ssl: sslFor(ADMIN_URL) });
  await admin.connect();

  // Clean slate for repeatable runs
  await admin.query("DELETE FROM organizations WHERE name LIKE 'rls-test-%'");
  const {
    rows: [orgA],
  } = await admin.query(
    "INSERT INTO organizations (name) VALUES ('rls-test-a') RETURNING id",
  );
  const {
    rows: [orgB],
  } = await admin.query(
    "INSERT INTO organizations (name) VALUES ('rls-test-b') RETURNING id",
  );
  await admin.query("INSERT INTO workspaces (org_id, name) VALUES ($1, 'ws-a')", [orgA.id]);
  await admin.query("INSERT INTO workspaces (org_id, name) VALUES ($1, 'ws-b')", [orgB.id]);

  const app = new Client({ connectionString: APP_URL, ssl: sslFor(APP_URL) });
  await app.connect();

  // 1. No org context → default deny (zero rows visible)
  const noCtx = await app.query("SELECT count(*)::int AS n FROM workspaces");
  assert("no org context sees zero workspaces", noCtx.rows[0].n === 0);

  // 2. Org A context → sees exactly its own workspace
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.org_id', $1, true)", [orgA.id]);
  const aRows = await app.query("SELECT name FROM workspaces");
  assert(
    "org A sees only ws-a",
    aRows.rows.length === 1 && aRows.rows[0].name === "ws-a",
    JSON.stringify(aRows.rows),
  );

  // 3. Cross-tenant write inside org A context → blocked by WITH CHECK
  let crossWriteBlocked = false;
  try {
    await app.query("INSERT INTO workspaces (org_id, name) VALUES ($1, 'evil')", [orgB.id]);
  } catch (err) {
    crossWriteBlocked = /row-level security/i.test(err.message);
  }
  assert("insert into org B while in org A context is rejected", crossWriteBlocked);
  await app.query("ROLLBACK");

  // 4. Org B context → sees only ws-b, and org A's row in organizations is invisible
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.org_id', $1, true)", [orgB.id]);
  const bRows = await app.query("SELECT name FROM workspaces");
  assert(
    "org B sees only ws-b",
    bRows.rows.length === 1 && bRows.rows[0].name === "ws-b",
    JSON.stringify(bRows.rows),
  );
  const orgVis = await app.query("SELECT count(*)::int AS n FROM organizations");
  assert("org B sees exactly one organizations row (its own)", orgVis.rows[0].n === 1);
  await app.query("ROLLBACK");

  // 5. Audit log is append-only for the app role
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.org_id', $1, true)", [orgA.id]);
  await app.query(
    "INSERT INTO audit_log (org_id, actor_type, actor_id, action) VALUES ($1, 'system', 'rls-test', 'test.append')",
    [orgA.id],
  );
  let auditImmutable = false;
  try {
    await app.query("DELETE FROM audit_log WHERE action = 'test.append'");
  } catch (err) {
    auditImmutable = /permission denied/i.test(err.message);
  }
  assert("audit_log DELETE is denied for app role", auditImmutable);
  await app.query("ROLLBACK");

  // Cleanup
  await admin.query("DELETE FROM organizations WHERE name LIKE 'rls-test-%'");
  await admin.end();
  await app.end();

  console.log(failures === 0 ? "\nRLS verification: ALL PASS" : `\nRLS verification: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
