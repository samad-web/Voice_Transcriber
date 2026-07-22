/**
 * Idempotent dev seed: one org + one workspace with fixed UUIDs so scripts
 * and manual testing have stable IDs. Runs as admin (bypasses RLS).
 */
const { Client } = require("pg");
const { sslFor } = require("./ssl");
const { randomBytes, scryptSync } = require("node:crypto");

// Version-4-shaped fixed UUIDs — zod 4's .uuid() validates RFC version bits,
// so nil-style IDs (version 0) would be rejected at the API boundary.
const DEV_ORG_ID = "00000000-0000-4000-8000-000000000001";
const DEV_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const DEV_USER_ID = "00000000-0000-4000-8000-000000000003";

// Same scrypt scheme as AuthService.hashPassword.
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function main() {
  const url =
    process.env.DATABASE_URL ??
    "postgresql://aura:aura_dev_password@localhost:5433/callintel";
  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();

  await client.query(
    `INSERT INTO organizations (id, name, region) VALUES ($1, 'Dev Org', 'ap-south-1')
     ON CONFLICT (id) DO NOTHING`,
    [DEV_ORG_ID],
  );
  await client.query(
    `INSERT INTO workspaces (id, org_id, name) VALUES ($1, $2, 'Dev Workspace')
     ON CONFLICT (id) DO NOTHING`,
    [DEV_WORKSPACE_ID, DEV_ORG_ID],
  );

  // Dev admin user (org_admin, full recording permissions). Password: "admin".
  // Dev-only credential login; production identifies users via OIDC (sso_subject).
  await client.query(
    `INSERT INTO users (id, email, name, status, password_hash)
     VALUES ($1, 'admin@aura.local', 'Dev Admin', 'active', $2)
     ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [DEV_USER_ID, hashPassword("admin")],
  );
  await client.query(
    `INSERT INTO memberships (org_id, user_id, scope_type, scope_id, role, recordings_listen, recordings_export)
     VALUES ($1, $2, 'org', $1, 'org_admin', true, true)
     ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING`,
    [DEV_ORG_ID, DEV_USER_ID],
  );

  console.log(`org:       ${DEV_ORG_ID}`);
  console.log(`workspace: ${DEV_WORKSPACE_ID}`);
  console.log(`user:      admin@aura.local / admin  (org_admin, listen+export)`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
