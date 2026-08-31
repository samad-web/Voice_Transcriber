-- 0064_lead_scoring.sql - Kailash gap Milestone 4, part 2: a rule-based point
-- ledger on contacts, computed by a worker sweep off events that already
-- exist (inbound replies, meeting interactions) plus inactivity decay. Pure
-- computation, no sends - doesn't touch any of the three safety rules.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_score int NOT NULL DEFAULT 0;

-- Tenant config as jsonb on organizations, same precedent as lead_stages
-- (0010) and lead_rules - a tenant overriding its own point values must not
-- be a migration. {} means "use the worker's built-in defaults" (see
-- lead-scoring.ts).
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS lead_scoring_rules jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The ledger. `source_id` + the partial unique index is the idempotency key:
-- the sweep re-scans a lookback window every tick rather than tracking a
-- cursor, and ON CONFLICT DO NOTHING is what stops the same inbound message
-- or meeting from scoring twice. NULL source_id (used for inactivity decay,
-- which has no source row of its own) is deliberately excluded from the
-- constraint - decay's own idempotency key is `action` being unique per
-- contact per day, enforced in application code via a synthetic source_id
-- (today's date), not by this index.
CREATE TABLE IF NOT EXISTS lead_score_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  action      text NOT NULL,
  delta       int NOT NULL,
  source_id   text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_score_events_source
  ON lead_score_events (contact_id, action, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lead_score_events_contact ON lead_score_events (contact_id, occurred_at DESC);

ALTER TABLE lead_score_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_score_events FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON lead_score_events
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT ON lead_score_events TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON lead_score_events FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON lead_score_events FROM PUBLIC;
