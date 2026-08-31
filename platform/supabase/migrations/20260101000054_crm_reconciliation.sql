-- 0054_crm_reconciliation.sql - A6, Milestone 3: does the dual-write agree
-- with itself?
--
-- The worker's dual-write (apps/worker/src/pipeline/crm-objects.ts) has run
-- since M3 of CRM Phase 1, alongside `leads` - but nothing has ever checked
-- that the two sides still agree once a human starts editing either one.
-- This is that check: a sweep (crm-reconcile.ts) compares each lead against
-- its dual-written deal/contact and logs what differs, so the burn-in period
-- before A6's read/write cutover (CRM_STATUS.md) has real evidence behind it
-- instead of a hope.
--
-- A log, not a live-integrity table - nothing joins through it, same
-- reasoning 0038 gives for merge_log's polymorphic ids. `lead_id`/`deal_id`/
-- `contact_id` are ON DELETE SET NULL rather than CASCADE: a row that
-- explains a divergence is still worth keeping after the record it was about
-- is gone (erased, reaped, merged) - the finding outlives the object.

CREATE TABLE IF NOT EXISTS crm_reconciliation_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id     uuid REFERENCES leads(id) ON DELETE SET NULL,
  deal_id     uuid REFERENCES deals(id) ON DELETE SET NULL,
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- e.g. 'deal.name', 'contact.facts', 'deal.stage', 'deal_missing'. Dotted
  -- rather than two columns (object + field): a structural finding like
  -- 'deal_missing' has no field on the CRM side to name.
  field       text NOT NULL,
  lead_value  text,
  crm_value   text,
  detected_at timestamptz NOT NULL DEFAULT now()
);

-- The sweep's own dedup check: "is this the same mismatch as last time, for
-- this lead and this field" - ORDER BY detected_at DESC LIMIT 1 on exactly
-- this shape.
CREATE INDEX IF NOT EXISTS crm_reconciliation_log_lead_field
  ON crm_reconciliation_log (lead_id, field, detected_at DESC);
-- "What's outstanding in this org" - the operator-facing read.
CREATE INDEX IF NOT EXISTS crm_reconciliation_log_org_detected
  ON crm_reconciliation_log (org_id, detected_at DESC);

ALTER TABLE crm_reconciliation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_reconciliation_log FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON crm_reconciliation_log
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- SELECT + INSERT only, same as deal_stage_transitions (0046) and for the
-- same reason: a finding that can be edited or removed by the app is not a
-- finding, and nothing here has a legitimate reason to rewrite one.
GRANT SELECT, INSERT ON crm_reconciliation_log TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON crm_reconciliation_log FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON crm_reconciliation_log FROM PUBLIC;
