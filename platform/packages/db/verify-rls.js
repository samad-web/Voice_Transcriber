/**
 * RLS enforcement check (hardening plan §2.1, road-to-10 §1.5).
 *
 * Two halves, and both matter:
 *
 *   STRUCTURAL - every table in the public schema that carries an `org_id` is
 *   ENUMERATED from the catalog and must have RLS enabled, FORCED, and a real
 *   org_isolation policy with both USING and WITH CHECK. This half used to not
 *   exist. The old version asserted six behaviours across FOUR tables from a
 *   hand-written list (workspaces, organizations, telecallers, audit_log) while
 *   21 tables carry org_id - so a migration that added a tenant table and
 *   forgot its policy reported ALL PASS. Worse, 0007's FORCE-RLS loop derives
 *   its table list from pg_policies, so a policy-less table is skipped rather
 *   than broken: it ends up with relrowsecurity=false AND relforcerowsecurity
 *   =false and looks exactly like a legitimate non-tenant table. Nothing else
 *   in the system catches that. This does.
 *
 *   BEHAVIOURAL - the original six assertions, unchanged in substance: seed two
 *   orgs as the owner, then prove as `aura_app` that cross-tenant reads return
 *   nothing and cross-tenant writes are rejected. Structure can be right on
 *   paper and still not bind (that is precisely what FORCE ROW LEVEL SECURITY
 *   is for on Supabase, where the migration owner owns the tables), so the
 *   proof is worth keeping alongside the enumeration.
 *
 * Run the full check after every migration in CI, against the ephemeral
 * Postgres - so a bad migration fails the deploy instead of leaking silently.
 *
 *   node verify-rls.js
 *
 * SAFETY: the full run SEEDS AND DELETES (behaviouralChecks). See
 * assertDisposable() below - it refuses to run against anything but a
 * local/disposable host unless RLS_TEST_ALLOW_REMOTE=1 is set explicitly.
 *
 *   node verify-rls.js --structural-only
 *
 * The read-only half alone - safe against, and meant for, the production
 * migrate container (docker-compose.prod.yml's `migrate` service), which
 * `assertDisposable()` would otherwise refuse outright since Supabase is
 * never a local host. See the STRUCTURAL_ONLY branch in main() below.
 */
const { Client } = require("pg");
const { sslFor } = require("./ssl");

const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgresql://aura:aura_dev_password@localhost:5433/callintel";
const APP_URL =
  process.env.APP_DATABASE_URL ??
  "postgresql://aura_app:aura_app_password@localhost:5433/callintel";

/**
 * Tables in the public schema that legitimately have no org_id, and therefore
 * no org_isolation policy. FOUR ENTRIES, ON PURPOSE: this is an allowlist, so
 * adding a fifth requires a reviewed edit to this file rather than a silent
 * pass. Anything else that turns up without an org_id fails the run.
 *
 *   users             platform-level humans; tenancy comes from `memberships`.
 *                     NOTE that this table holds email, password_hash and
 *                     sso_subject for EVERY tenant and has no RLS at all, so
 *                     its tenant boundary is 100% application code (AuthService
 *                     runs on the RLS-bypassing owner pool). That is a known,
 *                     unfixed exposure - it is listed here so the allowlist
 *                     states it out loud rather than hiding it.
 *   schema_migrations this runner's own bookkeeping; 0001 revokes it from
 *                     aura_app entirely.
 *   payment_webhook_events (0060) Razorpay webhook idempotency ledger. Read
 *                     and written entirely on the admin pool by
 *                     razorpay-webhook.controller.ts, which resolves the org
 *                     from the payment_link id in the (untrusted) payload -
 *                     it cannot run inside the org context it is trying to
 *                     establish, the same bootstrap exception
 *                     messaging_channels.webhook_token resolution documents.
 *                     Holds only a provider name + an opaque event id, no
 *                     tenant data.
 *   app_releases      (0081) The Android fleet's release channel. There is ONE
 *                     APK for every tenant, so an org_id column would have no
 *                     value to put in it - this is not tenant data that lost
 *                     its scoping, it is platform data that never had any.
 *                     Holds a version number, an object key, a digest and a
 *                     release note; nothing here is a tenant's, and nothing
 *                     here is a secret. Read on the admin pool by
 *                     devices.controller.ts (no org context exists to enter),
 *                     written only by scripts/publish-app-release.js - the API
 *                     has SELECT and nothing more, so no request can publish.
 */
const NON_TENANT_TABLES = new Set([
  "users",
  "schema_migrations",
  "payment_webhook_events",
  "app_releases",
  // platform_operators  0089. Who may administer the platform - which by
  //                     definition belongs to no tenant, so an org_id here
  //                     would be a fiction rather than a boundary. Reached only
  //                     through the admin pool; `aura_app` is revoked outright,
  //                     and so are the Supabase API roles.
  "platform_operators",
]);

/**
 * Schemas OTHER THAN `public` that hold application data and have been reviewed
 * as legitimately outside the tenant model. This is the marketing funnel's entry
 * on the reviewed allowlist (doc 16 §3.1), and it is a separate list rather than
 * a third entry in NON_TENANT_TABLES for an accurate reason:
 *
 *   EVERY query in structuralChecks() is scoped to `public` - the
 *   information_schema sweep filters `table_schema = 'public'`, the pg_class
 *   sweep filters `relnamespace = 'public'::regnamespace`, and the pg_policies
 *   sweep filters `schemaname = 'public'`. A table in another schema is
 *   therefore not "allowed past" the closure check in step 4; it is never seen
 *   by it at all. Adding `funnel_submissions` to NON_TENANT_TABLES would read
 *   like an exemption that is doing work, and would do nothing.
 *
 *   marketing  0020_funnel_submissions.sql. Inbound marketing enquiries from
 *              strangers: no org, no workspace, no call, no tenant - the exact
 *              opposite of public.leads, which is a per-tenant product object
 *              (doc 16 §0.1 on why the names had to differ). Forcing it into
 *              `public` would have meant either a fake org_id or a genuine
 *              widening of this allowlist. Its boundary is the schema plus a
 *              dedicated login role, `aura_marketing`, which holds no privilege
 *              on `public` at all - see 0020's grant block.
 *
 * The check below is the part that keeps this honest: it asserts these schemas
 * stay tenant-free, so a later migration that quietly adds an org_id to one of
 * them fails the run instead of creating a tenant table with no RLS at all.
 */
const REVIEWED_NON_TENANT_SCHEMAS = ["marketing"];

/**
 * The org_id tables as of migration 0018. This is a FLOOR, never the source of
 * truth - the checks below run over whatever the catalog reports, so a table
 * added by migration 0019 is covered without touching this file. What the list
 * catches is the opposite failure: an enumeration query that silently stops
 * returning rows (a schema rename, a permissions change, a typo) would
 * otherwise report "0 tables, all fine".
 */
const KNOWN_TENANT_TABLES = [
  "agents",
  "ai_outputs",
  "api_keys",
  "audit_log",
  "call_facts",
  "call_notes",
  "calls",
  "crm_integrations",
  "crm_sync_log",
  "device_health",
  "devices",
  "enrollment_tokens",
  "instances",
  "leads",
  "memberships",
  "recordings",
  "sessions",
  "telecallers",
  "transcripts",
  "usage_events",
  "workspaces",
];

let failures = 0;
function assert(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------------------
// Guard: never point this at production.
// ---------------------------------------------------------------------------

/**
 * Same host set as ssl.js: loopback plus the compose/CI service names. A host
 * in here is a throwaway database - docker-compose locally, a `services:`
 * container in GitHub Actions.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

/**
 * The reason this exists: the seeding step runs
 * `DELETE FROM organizations WHERE name LIKE 'rls-test-%'`, and organizations
 * cascades to every tenant table. DATABASE_URL/APP_DATABASE_URL default to
 * localhost, but a developer who has exported production credentials in that
 * shell - which is exactly what deploying and debugging this platform requires
 * - runs those DELETEs, plus two org INSERTs, against live customer data. One
 * exported variable stands between this script and a production incident.
 *
 * So: refuse, by host, and make the override explicit and deliberate.
 */
function assertDisposable(label, url) {
  let host;
  try {
    // IPv6 hostnames come back bracketed from the URL parser.
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    console.error(`${label} is not a parseable connection URL - refusing to run.`);
    process.exit(1);
  }
  if (LOCAL_HOSTS.has(host)) return;
  if (process.env.RLS_TEST_ALLOW_REMOTE === "1") {
    console.warn(
      `WARNING: ${label} points at "${host}", which is not local. ` +
        "Proceeding because RLS_TEST_ALLOW_REMOTE=1.",
    );
    return;
  }
  console.error(
    [
      `REFUSING TO RUN: ${label} points at "${host}".`,
      "",
      "verify-rls.js is destructive - it INSERTs two organizations and runs",
      "DELETE FROM organizations WHERE name LIKE 'rls-test-%', which cascades",
      "to every tenant table. It is only ever meant to run against a disposable",
      "database (docker-compose, or the ephemeral Postgres service in CI).",
      "",
      `Local hosts: ${[...LOCAL_HOSTS].join(", ")}.`,
      "If this really is a throwaway database on a remote host, re-run with",
      "RLS_TEST_ALLOW_REMOTE=1.",
    ].join("\n"),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Structural: enumerate, do not enumerate by hand.
// ---------------------------------------------------------------------------

async function structuralChecks(admin) {
  console.log("--- structural: RLS coverage over every org_id table ---");

  // Every BASE TABLE in public that carries an org_id column. This is the whole
  // point: the list comes from the catalog, so migration 0019 is covered the
  // moment it runs.
  const { rows: tenantRows } = await admin.query(`
    SELECT c.table_name AS name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'org_id'
       AND t.table_type   = 'BASE TABLE'
     ORDER BY 1`);
  const tenantTables = tenantRows.map((r) => r.name);

  // relforcerowsecurity is the load-bearing flag, not relrowsecurity: the
  // migration owner owns these tables, and a table that is merely ENABLEd is
  // still read wide open by its owner.
  const { rows: relRows } = await admin.query(`
    SELECT relname AS name, relrowsecurity AS enabled, relforcerowsecurity AS forced
      FROM pg_class
     WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'`);
  const rls = new Map(relRows.map((r) => [r.name, r]));

  const { rows: policyRows } = await admin.query(`
    SELECT tablename AS tbl, policyname AS name, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'`);
  const policiesFor = new Map();
  for (const p of policyRows) {
    if (!policiesFor.has(p.tbl)) policiesFor.set(p.tbl, []);
    policiesFor.get(p.tbl).push(p);
  }

  // Non-vacuity. If the enumeration above ever returns nothing (renamed schema,
  // revoked catalog access, a typo in the query) every check after it passes
  // trivially, which is the failure mode this whole rewrite exists to remove.
  const missingKnown = KNOWN_TENANT_TABLES.filter((t) => !tenantTables.includes(t));
  assert(
    `enumeration found every org_id table known at 0018 (${tenantTables.length} found)`,
    missingKnown.length === 0,
    missingKnown.length ? `missing: ${missingKnown.join(", ")}` : "",
  );

  // 1. Coverage: enabled + FORCED + at least one policy, for every one of them.
  const unprotected = [];
  for (const t of tenantTables) {
    const flags = rls.get(t);
    const reasons = [];
    if (!flags) reasons.push("not found in pg_class");
    else {
      if (!flags.enabled) reasons.push("RLS not enabled");
      if (!flags.forced) reasons.push("RLS not FORCED (owner bypasses it)");
    }
    if (!policiesFor.has(t)) reasons.push("no policy at all");
    if (reasons.length) unprotected.push(`${t} (${reasons.join("; ")})`);
  }
  assert(
    "every org_id table has RLS enabled, FORCED and a policy",
    unprotected.length === 0,
    unprotected.length ? `\n      ${unprotected.join("\n      ")}` : "",
  );

  // 2. The policy has to be the real one. A policy that exists but reads
  //    `USING (true)`, or one with a USING and no WITH CHECK, passes check 1
  //    while permitting exactly what RLS is here to stop - a USING-only policy
  //    blocks cross-tenant READS and silently allows cross-tenant WRITES.
  const weak = [];
  for (const t of tenantTables) {
    const iso = (policiesFor.get(t) ?? []).find((p) => p.name === "org_isolation");
    if (!iso) {
      weak.push(`${t} (no policy named org_isolation)`);
      continue;
    }
    const reasons = [];
    if (!iso.qual || !iso.qual.includes("app.org_id")) {
      reasons.push(`USING does not key on app.org_id: ${iso.qual ?? "null"}`);
    }
    if (!iso.with_check || !iso.with_check.includes("app.org_id")) {
      reasons.push(`WITH CHECK missing or not keyed on app.org_id: ${iso.with_check ?? "null"}`);
    }
    if (reasons.length) weak.push(`${t} (${reasons.join("; ")})`);
  }
  assert(
    "every org_isolation policy keys both USING and WITH CHECK on app.org_id",
    weak.length === 0,
    weak.length ? `\n      ${weak.join("\n      ")}` : "",
  );

  // 3. organizations is the one legitimate exception to the shape: no org_id
  //    column, so the policy is named org_self and keys on `id` instead. Assert
  //    it explicitly rather than letting it fall through the org_id sweep.
  const orgFlags = rls.get("organizations");
  const orgSelf = (policiesFor.get("organizations") ?? []).find((p) => p.name === "org_self");
  assert(
    "organizations has RLS enabled, FORCED and an org_self policy on both USING and WITH CHECK",
    Boolean(
      orgFlags &&
        orgFlags.enabled &&
        orgFlags.forced &&
        orgSelf &&
        orgSelf.qual &&
        orgSelf.qual.includes("app.org_id") &&
        orgSelf.with_check &&
        orgSelf.with_check.includes("app.org_id"),
    ),
    orgSelf ? "" : "org_self policy not found",
  );

  // 4. Closure over the allowlist. A new table with no org_id is not
  //    self-evidently fine - `device_health` and `sessions` both look like
  //    infrastructure and both carry tenant data. Force the question to be
  //    answered by an edit to NON_TENANT_TABLES.
  const unaccounted = [...rls.keys()].filter(
    (t) => !tenantTables.includes(t) && t !== "organizations" && !NON_TENANT_TABLES.has(t),
  );
  assert(
    "every public table is either org-scoped or on the reviewed non-tenant allowlist",
    unaccounted.length === 0,
    unaccounted.length ? `unaccounted: ${unaccounted.join(", ")}` : "",
  );

  // 4b. The reviewed non-tenant schemas stay tenant-free. Every check above is
  //     scoped to `public`, so a table in `marketing` is invisible to all of
  //     them - including the closure check that would otherwise catch a new
  //     org_id table with no policy. This is the one assertion that covers it:
  //     if a later migration adds an org_id column anywhere in one of those
  //     schemas, that table is tenant data sitting outside the RLS model, and
  //     the run has to fail rather than report ALL PASS.
  const { rows: offSchemaTenantRows } = await admin.query(
    `SELECT c.table_schema || '.' || c.table_name AS name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = ANY($1)
        AND c.column_name  = 'org_id'
        AND t.table_type   = 'BASE TABLE'
      ORDER BY 1`,
    [REVIEWED_NON_TENANT_SCHEMAS],
  );
  assert(
    `reviewed non-tenant schemas (${REVIEWED_NON_TENANT_SCHEMAS.join(", ")}) carry no org_id table`,
    offSchemaTenantRows.length === 0,
    offSchemaTenantRows.length
      ? `org_id found in: ${offSchemaTenantRows.map((r) => r.name).join(", ")} - ` +
          "either move it into public with an org_isolation policy, or remove the column"
      : "",
  );

  // 5. Enum drift. packages/shared/src/enums.ts is hand-maintained and is
  //    ALREADY behind these two constraints (CallStatus has no
  //    TRANSCRIPTION_OFF, added by 0014 and written by pipeline.ts; CrmSyncStatus
  //    has no 'dead', added by 0008 and written by outbox.ts). The database is
  //    the authority on legal values, so assert the values here - a fixture
  //    built from the stale TypeScript union produces tests that pass while the
  //    code is wrong.
  const { rows: constraints } = await admin.query(`
    SELECT conname AS name, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace
       AND conname IN ('calls_status_check', 'crm_sync_log_status_check')`);
  const defOf = (n) => constraints.find((c) => c.name === n)?.def ?? "";
  assert(
    "calls_status_check still admits TRANSCRIPTION_OFF (0014)",
    defOf("calls_status_check").includes("TRANSCRIPTION_OFF"),
    defOf("calls_status_check") || "constraint not found",
  );
  assert(
    "crm_sync_log_status_check still admits 'dead' (0008)",
    defOf("crm_sync_log_status_check").includes("'dead'"),
    defOf("crm_sync_log_status_check") || "constraint not found",
  );
}

// ---------------------------------------------------------------------------
// Behavioural: prove it binds for the role the API actually connects as.
// ---------------------------------------------------------------------------

async function behaviouralChecks(admin, app) {
  console.log("\n--- behavioural: cross-tenant reads and writes as aura_app ---");

  // Clean slate for repeatable runs
  await admin.query("DELETE FROM organizations WHERE name LIKE 'rls-test-%'");
  const {
    rows: [orgA],
  } = await admin.query("INSERT INTO organizations (name) VALUES ('rls-test-a') RETURNING id");
  const {
    rows: [orgB],
  } = await admin.query("INSERT INTO organizations (name) VALUES ('rls-test-b') RETURNING id");
  await admin.query("INSERT INTO workspaces (org_id, name) VALUES ($1, 'ws-a')", [orgA.id]);
  await admin.query("INSERT INTO workspaces (org_id, name) VALUES ($1, 'ws-b')", [orgB.id]);

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

  // 5. telecallers (0017) - same org-isolation shape as workspaces
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.org_id', $1, true)", [orgA.id]);
  await app.query("INSERT INTO telecallers (org_id, display_name) VALUES ($1, 'Test Telecaller A')", [
    orgA.id,
  ]);
  const tRows = await app.query("SELECT display_name FROM telecallers");
  assert(
    "org A sees only its own telecaller",
    tRows.rows.length === 1 && tRows.rows[0].display_name === "Test Telecaller A",
    JSON.stringify(tRows.rows),
  );
  let crossTelecallerBlocked = false;
  try {
    await app.query("INSERT INTO telecallers (org_id, display_name) VALUES ($1, 'evil')", [orgB.id]);
  } catch (err) {
    crossTelecallerBlocked = /row-level security/i.test(err.message);
  }
  assert(
    "insert into telecallers for org B while in org A context is rejected",
    crossTelecallerBlocked,
  );
  await app.query("ROLLBACK");

  // 6. Audit log is append-only for the app role
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

  // 7. usage_events is the other append-only surface (0001 and 0007 both REVOKE
  //    UPDATE, DELETE on it, exactly as they do for audit_log) and was the only
  //    one of the two never asserted. It is the metering ledger - a tenant-facing
  //    write path that could edit it is a billing integrity problem, not just a
  //    tidiness one.
  //    ONE FAILING STATEMENT PER TRANSACTION. Postgres aborts the whole
  //    transaction block on the first error, so a second probe in the same
  //    BEGIN comes back with "current transaction is aborted, commands ignored
  //    until end of transaction block" - never "permission denied" - and the
  //    assertion fails no matter how the grants are set. Each probe therefore
  //    gets its own BEGIN/ROLLBACK.
  await app.query("BEGIN");
  await app.query("SELECT set_config('app.org_id', $1, true)", [orgA.id]);
  let usageImmutable = false;
  try {
    await app.query("DELETE FROM usage_events WHERE org_id = $1", [orgA.id]);
  } catch (err) {
    usageImmutable = /permission denied/i.test(err.message);
  }
  assert("usage_events DELETE is denied for app role", usageImmutable);
  await app.query("ROLLBACK");

  await app.query("BEGIN");
  await app.query("SELECT set_config('app.org_id', $1, true)", [orgA.id]);
  let usageUpdateBlocked = false;
  try {
    // `quantity`, not `qty` - 0001_init.sql:277. A wrong column name raises
    // "column ... does not exist" during parse analysis, before the executor's
    // ACL check ever runs, so the probe would assert nothing at all.
    await app.query("UPDATE usage_events SET quantity = 0 WHERE org_id = $1", [orgA.id]);
  } catch (err) {
    usageUpdateBlocked = /permission denied/i.test(err.message);
  }
  assert("usage_events UPDATE is denied for app role", usageUpdateBlocked);
  await app.query("ROLLBACK");

  // Cleanup
  await admin.query("DELETE FROM organizations WHERE name LIKE 'rls-test-%'");
}

/**
 * `--structural-only`: the read-only half, deliberately runnable against
 * production (08 §1.5 - "the run it in the migrate container half is
 * structurally blocked: production is Supabase, so the guard refuses, and
 * the only override re-enables the destructive path against live data").
 *
 * `structuralChecks` never writes - it enumerates `information_schema`,
 * `pg_class`, `pg_policies` and `pg_constraint`. `assertDisposable()` exists
 * to stop `behaviouralChecks`' seed-and-DELETE from reaching a real tenant,
 * so it has nothing to guard here and would only ever do the wrong thing:
 * refuse the one place this half is most needed, which is exactly the
 * migrate container on a production deploy, where the point is to fail a bad
 * migration before it ships rather than to seed test data into Supabase.
 * No APP_DATABASE_URL / `app` client either - the behavioural half is the
 * only thing that ever needed the `aura_app` role.
 */
const STRUCTURAL_ONLY = process.argv.includes("--structural-only");

async function main() {
  if (STRUCTURAL_ONLY) {
    const admin = new Client({ connectionString: ADMIN_URL, ssl: sslFor(ADMIN_URL) });
    await admin.connect();
    await structuralChecks(admin);
    await admin.end();

    console.log(
      failures === 0
        ? "\nRLS structural verification: ALL PASS"
        : `\nRLS structural verification: ${failures} FAILURE(S)`,
    );
    process.exit(failures === 0 ? 0 : 1);
  }

  assertDisposable("DATABASE_URL", ADMIN_URL);
  assertDisposable("APP_DATABASE_URL", APP_URL);

  const admin = new Client({ connectionString: ADMIN_URL, ssl: sslFor(ADMIN_URL) });
  await admin.connect();
  const app = new Client({ connectionString: APP_URL, ssl: sslFor(APP_URL) });
  await app.connect();

  // Structure first: it is read-only, so a schema fault is reported even if the
  // seeding below cannot run.
  await structuralChecks(admin);
  await behaviouralChecks(admin, app);

  await admin.end();
  await app.end();

  console.log(
    failures === 0 ? "\nRLS verification: ALL PASS" : `\nRLS verification: ${failures} FAILURE(S)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
