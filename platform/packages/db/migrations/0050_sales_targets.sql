-- 0050_sales_targets.sql - PRD Layer 5: what someone is expected to sell.
--
-- The reports built in Layer 3 answer "what happened". A target is the other
-- half - "what was supposed to happen" - and without it every number on the
-- reports page is uncalibrated: 400,000 of won business is excellent or
-- alarming depending entirely on what the quarter was for.
--
-- ── ONE TABLE, NOT A COMP PLAN ────────────────────────────────────────────
--
-- Layer 5 in the PRD reads "quotas, territories, comp plans". This is the
-- quota, deliberately alone. Commission is payroll: it needs an accrual model,
-- a claw-back rule for a deal that unwinds, an approval trail, and it ends up
-- in somebody's pay packet - which makes a bug in it a different category of
-- problem from a wrong number on a dashboard. Territories are an assignment
-- system, which needs routing rules the CRM does not have yet. Both are real
-- work and neither is this migration's.
--
-- ── WHY A PERIOD IS TWO DATES, NOT A QUARTER ──────────────────────────────
--
-- Fiscal years start in April here, in October elsewhere, and monthly targets
-- are as common as quarterly ones. Storing (period_start, period_end) costs
-- nothing and avoids the CRM having an opinion about a customer's calendar.
-- The console offers month/quarter shortcuts on top.

CREATE TABLE IF NOT EXISTS sales_targets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE SET NULL,

  -- Whose target. NULL means the whole org/workspace - a team number, which
  -- is the one most people set first and the only one that works before
  -- individual owners are assigned.
  owner_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,

  -- Inclusive both ends. A target for August is 08-01 to 08-31.
  period_start   date NOT NULL,
  period_end     date NOT NULL,

  -- What is being measured. 'won_value' is money closed, 'won_count' is deals
  -- closed - a business selling few large contracts and one selling many small
  -- ones do not have the same idea of a good month. App-validated, like every
  -- other small open set in this schema.
  metric         text NOT NULL DEFAULT 'won_value',
  -- numeric, not int: a value target is money, and money is not an integer.
  target_value   numeric NOT NULL CHECK (target_value > 0),

  notes          text,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- A period that ends before it starts is not a period. Cheap to state here,
  -- and it stops a typo becoming a silently unreachable target.
  CONSTRAINT sales_targets_period CHECK (period_end >= period_start)
);

-- One target per person per metric per period. `owner_user_id` is nullable and
-- NULL values never collide in a plain unique index, so the team target gets
-- its own partial index rather than being left unconstrained - otherwise
-- "the team's Q3 number" could quietly exist five times.
CREATE UNIQUE INDEX IF NOT EXISTS sales_targets_person
  ON sales_targets (org_id, owner_user_id, metric, period_start, period_end)
  WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sales_targets_team
  ON sales_targets (org_id, metric, period_start, period_end)
  WHERE owner_user_id IS NULL;

-- "What targets cover today" - the attainment query's shape.
CREATE INDEX IF NOT EXISTS sales_targets_period_idx
  ON sales_targets (org_id, period_start, period_end);

ALTER TABLE sales_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_targets FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON sales_targets
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON sales_targets TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON sales_targets FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON sales_targets FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER sales_targets_set_updated_at BEFORE UPDATE ON sales_targets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
