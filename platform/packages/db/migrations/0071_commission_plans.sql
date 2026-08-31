-- 0071_commission_plans.sql — a rate per org, not payroll.
--
-- 0050's own header draws the line this migration stays behind: "Commission
-- is payroll: it needs an accrual model, a claw-back rule for a deal that
-- unwinds, an approval trail, and it ends up in somebody's pay packet... Both
-- are real work and neither is this migration's." This table still isn't
-- that. It is a calculator's input — a rate an org configures once — and the
-- CSV export in reports.service.ts multiplies it against a window's
-- attainment on read, the same way `pipeline`'s weighted forecast multiplies
-- a stage's probability against its value. Nothing here is accrued, nothing
-- is approved, and nothing claws back when a deal unwinds; the number simply
-- gets recomputed the next time the report is asked for.
--
-- `metric` picks which of Layer 3's own numbers the rate applies to —
-- 'won_value' and 'won_count' are the same two `sales_targets` already
-- offers (0050), plus 'calls' for a plan paid on call volume rather than
-- outcome. `rate_type` says whether `rate` is a percentage of won value or a
-- flat amount per unit (per rupee is meaningless; per deal or per call is
-- not) — app-validated, like every other small open set in this schema.

CREATE TABLE commission_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  name text NOT NULL,
  metric text NOT NULL DEFAULT 'won_value',   -- 'won_value' | 'won_count' | 'calls'
  rate_type text NOT NULL,                    -- 'percent' | 'flat_per_unit'
  rate numeric NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- "Which plans apply today" — the commission report's shape: active plans
-- for an org, scanned in full (there is no period column to index on, unlike
-- sales_targets — a plan is a standing rate, not tied to one window).
CREATE INDEX IF NOT EXISTS commission_plans_org_active
  ON commission_plans (org_id) WHERE active;

ALTER TABLE commission_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_plans FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON commission_plans
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON commission_plans TO aura_app;

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON commission_plans FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON commission_plans FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER commission_plans_set_updated_at BEFORE UPDATE ON commission_plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
