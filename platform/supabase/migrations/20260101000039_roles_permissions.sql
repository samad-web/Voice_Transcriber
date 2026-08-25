-- 0039_roles_permissions.sql — CRM Phase 1 foundation, part 6: a real
-- role -> object -> action(+scope/field) permission model, additive to the
-- existing memberships.role / memberships.owner_role axes.
--
-- Schema only. This migration does NOT wire role_permissions into
-- PermissionsGuard/OwnerRoleGuard/principalHasPermission, and does NOT let a
-- membership be assigned a genuinely custom (non-system) role — memberships
-- .role is a live 5-value CHECK enum read by authorization code across the
-- API and web, and widening that blast radius is deliberately deferred past
-- this "foundation" phase.
--
-- System roles are seeded as REAL PER-ORG ROWS (5 x every org), not shared
-- org_id IS NULL rows: a NULL-org row would be invisible under the standard
-- org_isolation policy below, forcing a bespoke relaxed policy on this one
-- table. Duplicating 5 rows per org is trivial and keeps every table in this
-- schema on the same RLS shape.

CREATE TABLE IF NOT EXISTS roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- platform_admin|org_admin|workspace_admin|workspace_member|viewer for the
  -- 5 seeded system rows (mirrors memberships.role's CHECK); a custom slug
  -- for anything an org defines itself.
  key         text NOT NULL,
  name        text NOT NULL,
  description text,
  is_system   bool NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS roles_org_key ON roles (org_id, key);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON roles
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON roles TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON roles FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON roles FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed the 5 system roles for every existing org.
INSERT INTO roles (org_id, key, name, is_system)
SELECT o.id, v.key, v.name, true
  FROM organizations o
  CROSS JOIN (VALUES
    ('platform_admin',   'Platform Admin'),
    ('org_admin',        'Org Admin'),
    ('workspace_admin',  'Workspace Admin'),
    ('workspace_member', 'Workspace Member'),
    ('viewer',           'Viewer')
  ) AS v(key, name)
 WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.org_id = o.id AND r.key = v.key);

-- ── Grants ─────────────────────────────────────────────────────────────
-- object_type is contact|account|deal only this phase — deliberately not
-- touching the existing recordings_listen/recordings_export mechanism, which
-- keeps its own separate enforcement path untouched.
CREATE TABLE IF NOT EXISTS role_permissions (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  object_type text NOT NULL,
  action      text NOT NULL CHECK (action IN ('view', 'create', 'edit', 'delete', 'export')),
  -- Row-level half of "role -> object -> field/row-level access", without
  -- building full territories yet.
  scope       text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'owned')),
  -- Field-level half. {fieldKey: 'hidden'|'readonly'}. Enforced in app code
  -- when wired (a later phase) — Postgres has no per-application-role column
  -- security mechanism here, so this was never going to be a DB-level control.
  field_restrictions jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (role_id, object_type, action)
);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON role_permissions
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON role_permissions TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON role_permissions FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON role_permissions FROM PUBLIC;

-- Seed sensible, NON-ENFORCED defaults per system role — safe to be
-- approximate since nothing reads this table yet (see header): admin roles
-- get full access, workspace_member gets view/create/edit, viewer gets view.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, ot.object_type, a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('contact'), ('account'), ('deal')) AS ot(object_type)
  CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete'), ('export')) AS a(action)
 WHERE r.is_system
   AND (
     r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
     OR (r.key = 'workspace_member' AND a.action IN ('view', 'create', 'edit'))
     OR (r.key = 'viewer' AND a.action = 'view')
   )
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.object_type = ot.object_type AND rp.action = a.action
   );

-- ── memberships.role_id ────────────────────────────────────────────────
-- Additive, nullable — same shape as 0018's owner_role addition. Backfilled
-- by matching org_id+role to the system role seeded above: lossless,
-- mechanical, the same style as 0018's own backfill.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES roles(id) ON DELETE SET NULL;

UPDATE memberships m
   SET role_id = r.id
  FROM roles r
 WHERE r.org_id = m.org_id AND r.key = m.role AND m.role_id IS NULL;

CREATE INDEX IF NOT EXISTS memberships_role_id ON memberships (role_id) WHERE role_id IS NOT NULL;
