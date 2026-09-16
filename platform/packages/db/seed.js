/**
 * Idempotent dev seed: one org + one workspace with fixed UUIDs so scripts
 * and manual testing have stable IDs. Runs as admin (bypasses RLS).
 */
const { Client } = require("pg");
const { sslFor } = require("./ssl");
const { PermissionObjectType } = require("@aura/shared");
const { randomBytes, scryptSync } = require("node:crypto");

// Version-4-shaped fixed UUIDs - zod 4's .uuid() validates RFC version bits,
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

  // The editable board + its default pipeline (migration 0075). Needed here
  // because `db:reset` runs migrate BEFORE seed: on a fresh database the
  // migration's backfill finds no organizations, so Dev Org would be the one
  // org in the system with no board. Same function the migration and the admin
  // dashboard's tenant provisioning both call, and idempotent, so re-seeding an
  // existing database is a no-op.
  await client.query(`SELECT seed_default_board($1)`, [DEV_ORG_ID]);

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

  // ── The CRM module, its roles and its permission grid ──────────────────────
  //
  // Same reason the board is seeded above, one level up: `db:reset` runs
  // migrate BEFORE seed, so on a FRESH database migration 0039's one-time
  // backfill finds no organizations and writes no roles - and then this script
  // creates Dev Org afterwards with plain SQL, which is not the provisioning
  // path. The org ends up with a membership and no grid.
  //
  // That failure is invisible and expensive to diagnose: `CrmPermissionsGuard`
  // needs BOTH 'crm' in enabled_modules AND a `role_permissions` row, so every
  // Contacts/Accounts/Deals/Tasks/Invoices page 403s and renders "Data
  // unavailable" while Leads and the board beside them work fine. It reads
  // exactly like a broken API, and it is a bare database.
  //
  // Object types come from the shared enum rather than a list written out
  // here, because that is the part that GROWS - `lead` joined it in 0103 -
  // and a hand-copied list is the half that would silently go stale. The five
  // roles and the action rules below mirror migration 0039, which is frozen
  // history and cannot drift. The live equivalent is `seedCrmDefaults` in
  // apps/api/src/modules/admin/admin.controller.ts, which is what real tenants
  // get; this is the dev-seed path to the same place.
  await client.query(
    `UPDATE organizations
        SET enabled_modules = ARRAY['aura','crm']
      WHERE id = $1 AND NOT ('crm' = ANY(enabled_modules))`,
    [DEV_ORG_ID],
  );

  await client.query(
    `INSERT INTO roles (org_id, key, name, is_system)
     VALUES ($1, 'platform_admin',   'Platform Admin',   true),
            ($1, 'org_admin',        'Org Admin',        true),
            ($1, 'workspace_admin',  'Workspace Admin',  true),
            ($1, 'workspace_member', 'Workspace Member', true),
            ($1, 'viewer',           'Viewer',           true)
     ON CONFLICT (org_id, key) DO NOTHING`,
    [DEV_ORG_ID],
  );

  await client.query(
    `INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
     SELECT r.org_id, r.id, ot.object_type, a.action, 'all'
       FROM roles r
       CROSS JOIN unnest($2::text[]) AS ot(object_type)
       CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete'), ('export')) AS a(action)
      WHERE r.org_id = $1
        AND r.is_system
        AND (
          r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
          OR (r.key = 'workspace_member' AND a.action IN ('view', 'create', 'edit'))
          OR (r.key = 'viewer' AND a.action = 'view')
        )
     ON CONFLICT (role_id, object_type, action) DO NOTHING`,
    [DEV_ORG_ID, PermissionObjectType.options],
  );

  // Point the membership at its role row. The guard has a documented fallback
  // that matches `memberships.role` against `roles.key` when this is NULL, but
  // leaving it NULL here would mean the dev seed only ever exercises the
  // fallback and never the primary join - so a break in the join would pass
  // every local check and fail in production.
  await client.query(
    `UPDATE memberships m
        SET role_id = r.id
       FROM roles r
      WHERE m.org_id = $1 AND m.user_id = $2
        AND r.org_id = m.org_id AND r.key = m.role
        AND m.role_id IS DISTINCT FROM r.id`,
    [DEV_ORG_ID, DEV_USER_ID],
  );

  console.log(`org:       ${DEV_ORG_ID}  (modules: aura, crm)`);
  console.log(`workspace: ${DEV_WORKSPACE_ID}`);
  console.log(`user:      admin@aura.local / admin  (org_admin, listen+export)`);
  console.log(`grid:      5 system roles seeded with a full CRM permission grid`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
