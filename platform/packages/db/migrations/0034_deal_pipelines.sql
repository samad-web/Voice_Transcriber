-- 0034_deal_pipelines.sql - CRM Phase 1 foundation, part 1: pipelines.
--
-- Strangler-fig build (CRM PRD, Phase 1 / Layer 0): this and the five
-- migrations that follow (0035-0039) add a real Account/Contact/Deal object
-- model alongside the existing `leads` table. Nothing here changes `leads`,
-- apps/worker/src/pipeline/leads.ts, call_facts, or the CRM outbound
-- connector pipeline (crm_integrations/crm_sync_log) - those stay exactly as
-- they are until a later, separately-reviewed cutover migration.
--
-- organizations.lead_stages (0010) is one implicit pipeline per org. Deals
-- need multiple pipelines per org (a brick supplier's sales pipeline is not
-- its support pipeline), so this reuses that column's SHAPE - a jsonb array
-- of {key,label,terminal?}, app-validated, not a DB enum - as a real table
-- instead of a single organizations column, for the same reason 0010 gave:
-- renaming a board column must not be a migration.

CREATE TABLE IF NOT EXISTS deal_pipelines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- Fixed to 'deal' this phase. A real column (not left implicit) because
  -- widening it to other object types is a deliberate future decision, not a
  -- config knob an admin could turn on by accident.
  object_type  text NOT NULL DEFAULT 'deal' CHECK (object_type = 'deal'),
  -- Array of {key,label,terminal?:'won'|'lost'} - same shape and validation
  -- (packages/shared/src/pipelines.ts) as organizations.lead_stages.
  stages       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Exactly one default per org is an app-enforced invariant (pipelines
  -- controller), the same way agents.is_active already is.
  is_default   bool NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_pipelines_org_status ON deal_pipelines (org_id, status);

ALTER TABLE deal_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_pipelines FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON deal_pipelines
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON deal_pipelines TO aura_app;

-- 0007 revoked Supabase's default privileges for future tables, but only for
-- the role that ran it. Re-assert here so a table created under a different
-- owner can never be reachable with the public anon key.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON deal_pipelines FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON deal_pipelines FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER deal_pipelines_set_updated_at BEFORE UPDATE ON deal_pipelines
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Seed a default pipeline for every existing org ────────────────────────
-- Mirrors organizations.lead_stages' own default exactly, so an org that
-- opens the new Deals board for the first time sees the same columns its
-- lead board already has, rather than an empty pipeline.
INSERT INTO deal_pipelines (org_id, name, stages, is_default)
SELECT o.id, 'Sales Pipeline',
       COALESCE(o.lead_stages, '[
         {"key": "new",         "label": "New"},
         {"key": "contacted",   "label": "Contacted"},
         {"key": "qualified",   "label": "Qualified"},
         {"key": "negotiation", "label": "Negotiation"},
         {"key": "won",         "label": "Won",  "terminal": "won"},
         {"key": "lost",        "label": "Lost", "terminal": "lost"}
       ]'::jsonb),
       true
  FROM organizations o
 WHERE NOT EXISTS (SELECT 1 FROM deal_pipelines p WHERE p.org_id = o.id);
