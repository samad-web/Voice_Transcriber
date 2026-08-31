-- 0038_merge_dedupe.sql - CRM Phase 1 foundation, part 5: Contact/Account
-- merge with a revert window, and a duplicate-candidate queue.
--
-- Victims are tombstoned (status='merged', merged_into_id set on the row
-- itself - see 0035), never hard-deleted: a merge is a workflow action a
-- human can get wrong, and losing data on a mis-click is worse than a little
-- permanent bookkeeping. Revert restores the survivor's overwritten fields
-- from the snapshot taken at merge time and un-tombstones the victim.

CREATE TABLE IF NOT EXISTS merge_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- App-validated: contact | account. Polymorphic survivor_id/victim_id are
  -- acceptable here (unlike the custom-field values in 0037) because this
  -- table is an audit trail, not a live-integrity surface - nothing joins
  -- through it.
  object_type text NOT NULL,
  survivor_id uuid NOT NULL,
  victim_id   uuid NOT NULL,
  -- {fieldKey: 'survivor'|'victim'} per contested field.
  field_decisions   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Survivor's mutable columns BEFORE the merge overwrote them - what a
  -- revert restores.
  survivor_snapshot jsonb NOT NULL,
  -- The victim's full row, for display and for restoring on revert.
  victim_snapshot   jsonb NOT NULL,
  -- deal ids whose contact_id/account_id were repointed victim->survivor, so
  -- a revert knows what to point back.
  reassigned_deals  jsonb NOT NULL DEFAULT '[]'::jsonb,
  performed_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  performed_at       timestamptz NOT NULL DEFAULT now(),
  revert_deadline_at timestamptz NOT NULL,
  reverted_at         timestamptz,
  reverted_by         uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS merge_log_org_object ON merge_log (org_id, object_type, performed_at DESC);
CREATE INDEX IF NOT EXISTS merge_log_victim      ON merge_log (victim_id);

ALTER TABLE merge_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE merge_log FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON merge_log
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Append-only except for the revert fields, same treatment as audit_log: an
-- audit trail that can be freely edited or deleted isn't one.
GRANT SELECT, INSERT, UPDATE ON merge_log TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON merge_log FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON merge_log FROM PUBLIC;

-- ── Duplicate candidate queue ──────────────────────────────────────────
-- Populated by an offline scan (fuzzy name+company matching needs pg_trgm -
-- confirm it is enabled on the target Postgres before that scan job ships,
-- since no migration in this codebase has enabled an extension before), not
-- computed live on page load.
CREATE TABLE IF NOT EXISTS duplicate_matches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  object_type  text NOT NULL,
  record_a_id  uuid NOT NULL,
  record_b_id  uuid NOT NULL,
  match_reason text NOT NULL CHECK (match_reason IN ('phone', 'email', 'external_id', 'fuzzy_name_company')),
  score        numeric,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dismissed', 'merged')),
  resolved_merge_id uuid REFERENCES merge_log(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Prevents (a,b)/(b,a) duplicate rows for the same pair.
  CONSTRAINT duplicate_matches_ordered_pair CHECK (record_a_id < record_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS duplicate_matches_org_object_pair
  ON duplicate_matches (org_id, object_type, record_a_id, record_b_id);
CREATE INDEX IF NOT EXISTS duplicate_matches_org_object_status
  ON duplicate_matches (org_id, object_type, status);

ALTER TABLE duplicate_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE duplicate_matches FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON duplicate_matches
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON duplicate_matches TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON duplicate_matches FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON duplicate_matches FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER duplicate_matches_set_updated_at BEFORE UPDATE ON duplicate_matches
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
