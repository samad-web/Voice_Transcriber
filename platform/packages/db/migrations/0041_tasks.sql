-- 0041_tasks.sql — Track A3: follow-up tasks.
--
-- "Call Priya back on Thursday" — the thing a CRM is actually for, and the
-- one piece of Layer 0 with no existing home: `deals.next_action` is a single
-- free-text line with no owner, no due date and no way to ask "what is
-- overdue across the team?".
--
-- Same shape decisions as 0040: `status` and `priority` are DB CHECKs
-- because they are closed sets that authorization and sorting depend on,
-- while the object a task hangs off is three nullable FKs rather than a
-- polymorphic (object_type, record_id) pair — real referential integrity,
-- the same reasoning 0037 used for custom-field values.

CREATE TABLE IF NOT EXISTS tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE SET NULL,

  title          text NOT NULL,
  notes          text,

  -- What it is about. All optional: "prepare Monday's pipeline review" is a
  -- real task with no object attached.
  contact_id     uuid REFERENCES contacts(id) ON DELETE CASCADE,
  account_id     uuid REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id        uuid REFERENCES deals(id) ON DELETE CASCADE,

  -- Who owes it. Nullable so a task can sit in a shared queue before anyone
  -- picks it up; SET NULL on user delete returns it to that queue rather than
  -- deleting work that still needs doing.
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Date, not timestamp: "due Thursday" is what people mean, and a timestamp
  -- would make overdue depend on the reader's timezone.
  due_on         date,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  priority       text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  completed_at   timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- "My open work, soonest first" — the query the console opens with. NULLS
-- LAST so undated tasks sort after dated ones rather than pretending to be
-- the most urgent thing on the list.
CREATE INDEX IF NOT EXISTS tasks_assignee_due
  ON tasks (org_id, assignee_user_id, due_on NULLS LAST) WHERE status = 'open';
-- "What is overdue anywhere in this org", for a manager and for A3's
-- notification hook.
CREATE INDEX IF NOT EXISTS tasks_org_due
  ON tasks (org_id, due_on) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS tasks_deal    ON tasks (deal_id)    WHERE deal_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_contact ON tasks (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_account ON tasks (account_id) WHERE account_id IS NOT NULL;

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON tasks
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tasks TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON tasks FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON tasks FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Permission grants for the new object type ───────────────────────────
-- `PermissionObjectType` grows to contact|account|deal|task in this same
-- change, and CrmPermissionsGuard DENIES anything a role has no grant for.
-- Without this block every existing user would be locked out of tasks the
-- moment the routes shipped — the grid is only editable by an admin who
-- would first have to notice.
--
-- Byte-for-byte the same predicate 0039 used for its own seeding, so a
-- system role's task grants match its contact grants exactly: admins get
-- everything, workspace_member view/create/edit, viewer view only. Custom
-- roles are deliberately NOT touched — somebody defined those by hand, and
-- silently widening them is not this migration's call.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'task', a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete'), ('export')) AS a(action)
 WHERE r.is_system
   AND (
     r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
     OR (r.key = 'workspace_member' AND a.action IN ('view', 'create', 'edit'))
     OR (r.key = 'viewer' AND a.action = 'view')
   )
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.object_type = 'task' AND rp.action = a.action
   );
