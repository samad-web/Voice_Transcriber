-- 0036_deals.sql — CRM Phase 1 foundation, part 3: Deal, the pipeline object
-- that inherits leads' board/stage role.
--
-- See 0034's header. `stage` is validated in application code against the
-- owning pipeline's `stages` list, exactly like leads.stage is validated
-- against organizations.lead_stages today (0010) — not a DB CHECK/FK, because
-- a tenant renaming a board column must not be a migration.

CREATE TABLE IF NOT EXISTS deals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  -- RESTRICT, not CASCADE/SET NULL: a pipeline with live deals must be
  -- archived, not deleted out from under them.
  pipeline_id   uuid NOT NULL REFERENCES deal_pipelines(id) ON DELETE RESTRICT,
  account_id    uuid REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id    uuid REFERENCES contacts(id) ON DELETE SET NULL,
  name          text NOT NULL,
  stage         text NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  amount        numeric,
  expected_close_date date,
  summary       text,
  next_action   text,
  notes         text,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Write-once attribution snapshot, same rule as leads.telecaller_id (0017):
  -- never updated by a later call, so reassigning a handset can't silently
  -- move who gets credit for a deal already in flight.
  telecaller_id uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  -- Provenance + the dual-write/backfill idempotency key (see the unique
  -- index below) — NULL for a deal created by hand rather than from a call.
  source_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  facts         jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  last_call_id  uuid REFERENCES calls(id) ON DELETE SET NULL,
  call_count    int NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The idempotency key for both the worker dual-write and the backfill script:
-- one lead never produces more than one auto-created deal. A manually-created
-- deal has source_lead_id NULL and is unconstrained by it, so a contact can
-- accumulate multiple real deals over time.
CREATE UNIQUE INDEX IF NOT EXISTS deals_source_lead
  ON deals (source_lead_id) WHERE source_lead_id IS NOT NULL;

-- The board (one query per pipeline+stage column) and the list.
CREATE INDEX IF NOT EXISTS deals_org_pipeline_stage
  ON deals (org_id, pipeline_id, stage, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS deals_org_activity ON deals (org_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS deals_contact       ON deals (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_account       ON deals (account_id) WHERE account_id IS NOT NULL;

ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON deals
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON deals TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON deals FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON deals FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER deals_set_updated_at BEFORE UPDATE ON deals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
