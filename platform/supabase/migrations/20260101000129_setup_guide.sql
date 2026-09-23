-- The "Finish your setup - X of N" guide (doc 27 §7.4).
--
-- 0106 built a checklist that nags about the REQUIRED steps and closes for
-- good once they are done (`setup_completed_at`). The guide is separate and
-- wider: a sidebar meter and a /owner/get-started page over EVERY step that
-- applies to the tenant, where optional steps can be skipped.
--
-- ── TWO NEW STAMPS, AND WHY NEITHER REUSES setup_completed_at ───────────────
--
--   guide_completed_at  every visible, non-skipped step is done. Stamped by
--                       GET /v1/owner/setup on the transition, with the same
--                       guarded UPDATE ... WHERE ... IS NULL 0106 uses.
--   guide_dismissed_at  an owner chose "Hide this guide".
--
-- `setup_completed_at` keeps its meaning and stays backfilled for existing
-- orgs (0106), so existing tenants still never see the required-steps banner.
-- Both new columns start NULL for everyone, so existing tenants' owners and
-- managers WILL see the sidebar widget after this deploy (doc 27 Q7) - and an
-- owner can hide it.
--
-- Re-opening: when an operator ADDS a module, the API clears
-- guide_completed_at in the same transaction, so the new module's steps can
-- appear. It never clears guide_dismissed_at - a guide an owner hid stays hid.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS guide_completed_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS guide_dismissed_at timestamptz;

-- A skipped optional step. Required steps cannot be skipped: the API answers
-- 409 `step_required`, and setupState() ignores a stray row for one.
CREATE TABLE IF NOT EXISTS org_setup_step_skips (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Validated against SetupStepId in the API, not by CHECK: the catalogue
  -- grows in TypeScript, and a CHECK here would need a migration per step.
  step_id     text NOT NULL CHECK (step_id ~ '^[a-z_]{1,40}$'),
  skipped_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  skipped_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, step_id)
);

COMMENT ON TABLE org_setup_step_skips IS
  'Optional setup-guide steps a tenant chose to skip (doc 27 §7). Excluded from the guide''s N.';

ALTER TABLE org_setup_step_skips ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_setup_step_skips FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON org_setup_step_skips
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON org_setup_step_skips FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON org_setup_step_skips FROM PUBLIC;
-- No UPDATE: a skip is inserted or deleted, never edited.
GRANT SELECT, INSERT, DELETE ON org_setup_step_skips TO aura_app;
