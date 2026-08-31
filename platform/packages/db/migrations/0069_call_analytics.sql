-- 0069_call_analytics.sql - AI call-quality scoring, talk-ratio/interruption
-- coaching metrics, and risk-phrase spotting, one row per call.
--
-- All three read the same diarized transcript once: quality scoring and risk
-- spotting extend the existing analyzeConversation() call in packages/llm
-- (no second LLM round trip), while talk-ratio/interruptions are computed in
-- plain TypeScript from the segments that call already returns. Every
-- quality/risk column is nullable and written independently of the talk
-- metrics - a call whose LLM read degraded still gets its talk-ratio, and a
-- call with no segments still gets whatever the LLM half produced.

CREATE TABLE IF NOT EXISTS call_analytics (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id                uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,

  -- AI quality score (0-100) + the per-criterion breakdown behind it.
  quality_score          int,
  quality_criteria       jsonb,

  -- Talk-ratio / interruption coaching metrics - pure computation, no LLM.
  agent_talk_seconds     int,
  customer_talk_seconds  int,
  talk_ratio             numeric,
  interruption_count     int,
  longest_monologue_seconds int,

  -- Escalation / risk-phrase spotting.
  risk_flags             jsonb NOT NULL DEFAULT '[]',
  has_escalation_risk    boolean NOT NULL DEFAULT false,

  model                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  UNIQUE (call_id)
);

CREATE INDEX IF NOT EXISTS call_analytics_org_created ON call_analytics (org_id, created_at DESC);
-- Backs the risk-review queue: "which calls this org need a look".
CREATE INDEX IF NOT EXISTS call_analytics_org_risk
  ON call_analytics (org_id, created_at DESC) WHERE has_escalation_risk;

ALTER TABLE call_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_analytics FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON call_analytics
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON call_analytics TO aura_app;

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON call_analytics FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON call_analytics FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER call_analytics_set_updated_at BEFORE UPDATE ON call_analytics
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
