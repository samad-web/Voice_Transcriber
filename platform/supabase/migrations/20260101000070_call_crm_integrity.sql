-- 0070_call_crm_integrity.sql - a permanent triage queue comparing a call's
-- own AI read (outcome, quality score) against the deal it produced, or
-- failed to. See apps/worker/src/pipeline/call-crm-integrity.ts for the
-- sweep that writes to this table and its three flag types.
--
-- Deliberately NOT the same table crm-reconcile.ts (0054) writes to - that
-- one is an opt-in burn-in log for the leads<->deals dual-write with no
-- resolve workflow; this is a permanent product surface an owner works
-- through (open -> dismissed/resolved), which needs its own lifecycle.

CREATE TABLE IF NOT EXISTS call_crm_integrity_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: a flag about a stalled deal (stalled_after_positive_call)
  -- has no single call at all, and a flag's own record should survive its
  -- call being purged by retention independently of the deal it's about.
  call_id     uuid REFERENCES calls(id) ON DELETE SET NULL,
  deal_id     uuid REFERENCES deals(id) ON DELETE SET NULL,
  flag_type   text NOT NULL CHECK (flag_type IN (
                'no_deal_from_positive_call',
                'outcome_status_contradiction',
                'stalled_after_positive_call'
              )),
  details     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'resolved')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL
);

-- "What's open right now" - the sweep's own-flag-exists check and the
-- console's review queue both filter on this.
CREATE INDEX IF NOT EXISTS call_crm_integrity_flags_open
  ON call_crm_integrity_flags (org_id, created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS call_crm_integrity_flags_call ON call_crm_integrity_flags (call_id);
CREATE INDEX IF NOT EXISTS call_crm_integrity_flags_deal ON call_crm_integrity_flags (deal_id);

ALTER TABLE call_crm_integrity_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_crm_integrity_flags FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON call_crm_integrity_flags
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON call_crm_integrity_flags TO aura_app;

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON call_crm_integrity_flags FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON call_crm_integrity_flags FROM PUBLIC;
