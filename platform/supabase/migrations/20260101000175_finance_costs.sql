-- 0175_finance_costs.sql
-- Build docs/finance-section-build-plan, M5: expenses and cost drivers (§9, §12.3).
--
-- ── WHAT THIS DOES NOT RE-IMPORT ────────────────────────────────────────────
--
-- Ad spend already has a home. Migration 0171 added `marketing_source_spend`
-- (org, source, month, amount) and the console has a screen that enters it, so
-- the cost layer READS that table for per-source ROI rather than asking an
-- owner to type the same number twice. §7.4 lists "Meta/Google ad spend" as a
-- roadmap cost connector; when one lands it writes 0171's table, not this one.
--
-- `expenses` is everything else: the bills, the salaries, the software, the
-- bought leads, the bank charges.
--
-- ── AND WHAT IT DELIBERATELY DUPLICATES ────────────────────────────────────
--
-- Incentives are a cost AND a payout. `expenses` carries an `incentive`
-- category, and `finance_snapshots` keeps `incentive` in its own column so
-- `totalCosts()` can add it exactly once. The alternative - deriving incentive
-- cost from `incentive_payouts` inside every cost query - was rejected because
-- an approved-but-unpaid payout is a cost the business has incurred, and the
-- payout table's status would have made that a judgement call in fourteen
-- different queries.

-- ── §9 expenses ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- A catalogue, because §12.3's variance and §12.4's `expense_outlier` both
  -- compare a category against its OWN baseline - and a category somebody
  -- retypes as "Telephony" and "telephony " has two baselines, each with half
  -- the history and neither with enough sample to ever fire. `other` is the
  -- escape hatch and is not a failure.
  category      text NOT NULL CHECK (category IN (
                  'advertising', 'lead_purchase', 'telephony', 'messaging',
                  'software', 'salary', 'incentive', 'rent', 'utilities',
                  'travel', 'professional_fees', 'bank_charges', 'other')),
  vendor        text,
  amount        numeric NOT NULL CHECK (amount >= 0),
  currency      text NOT NULL DEFAULT 'INR',
  -- GST on the bill, where it is recoverable. Split out rather than folded
  -- into `amount` so cost-as-a-share-of-revenue compares like with like: an
  -- invoice total includes tax the business gets back, and counting it as cost
  -- overstates every margin by the GST rate.
  tax           numeric NOT NULL DEFAULT 0 CHECK (tax >= 0),
  incurred_on   date NOT NULL,
  -- §12.3's fixed/variable split. A column and not a derivation, because a
  -- per-seat software bill is variable for a floor that is hiring and fixed
  -- for one that is not. `DEFAULT_FIXED_CATEGORIES` in @aura/shared is what
  -- the form PROPOSES; this is what the person decided.
  is_fixed      boolean NOT NULL DEFAULT false,
  -- Which lead source or campaign this cost belongs to, when it belongs to
  -- one. Nullable and must stay so: rent belongs to no campaign, and forcing
  -- an attribution is how CAC becomes fiction.
  marketing_source_id uuid REFERENCES marketing_sources(id) ON DELETE SET NULL,
  -- Whose cost this is, for per-telecaller profitability (§11). A salary or an
  -- incentive line has one; the electricity bill does not.
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- §12.4 `duplicate_expense` needs this; §9's model calls it `source`.
  source        text NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual', 'connector', 'csv_import', 'recurring')),
  -- §9: `approved_by`. A manager may approve up to a limit (§3); above it the
  -- API requires an owner. The LIMIT lives in finance_settings, not here.
  approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at   timestamptz,
  attachment_url text,
  -- §12.4 `idle_spend`: a recurring subscription's own cadence, so "paying for
  -- something nobody uses" can be detected without inferring it from gaps.
  recurs        text CHECK (recurs IS NULL OR recurs IN ('monthly', 'quarterly', 'yearly')),
  -- When a recurring expense last showed usage. Written by whatever knows -
  -- the seat count for software, the call minutes for telephony.
  last_used_on  date,
  memo          text,
  -- §6.3 applies to costs too: an expense is reversed, not deleted. A reversal
  -- is a new row with a negative-mirroring `reverses_id`.
  reverses_id   uuid REFERENCES expenses(id) ON DELETE RESTRICT,
  reversal_reason text,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS expenses_org_incurred
  ON expenses (org_id, incurred_on DESC);
CREATE INDEX IF NOT EXISTS expenses_org_category
  ON expenses (org_id, category, incurred_on DESC);
CREATE INDEX IF NOT EXISTS expenses_source
  ON expenses (marketing_source_id, incurred_on)
  WHERE marketing_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_user
  ON expenses (user_id, incurred_on) WHERE user_id IS NOT NULL;
-- The approval queue.
CREATE INDEX IF NOT EXISTS expenses_unapproved
  ON expenses (org_id, incurred_on) WHERE approved_at IS NULL;
-- `duplicate_expense`'s own lookup: same vendor and amount, near in time.
CREATE INDEX IF NOT EXISTS expenses_vendor_amount
  ON expenses (org_id, lower(vendor), amount, incurred_on) WHERE vendor IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS expenses_reverses
  ON expenses (reverses_id) WHERE reverses_id IS NOT NULL;

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON expenses
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- No DELETE: reversed, never removed, same as a payment.
GRANT SELECT, INSERT, UPDATE ON expenses TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON expenses FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON expenses FROM PUBLIC;
-- Reversed, never removed - same rule as a payment.
REVOKE DELETE ON expenses FROM aura_app;
DO $$ BEGIN
  CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON expenses
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER expenses_period_lock
    BEFORE INSERT OR UPDATE OF incurred_on, amount ON expenses
    FOR EACH ROW EXECUTE FUNCTION finance_refuse_locked_period('incurred_on');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §9 cost drivers ────────────────────────────────────────────────────────
--
-- The denominators §12.3's per-unit costs divide by: call minutes, calls made,
-- leads bought, messages sent, seats, new customers.
--
-- ── WHY MEASURED NUMBERS GET A TABLE RATHER THAN A QUERY ───────────────────
--
-- Most of these ARE derivable - `calls_made` is a count of `calls`. They are
-- stored anyway, per period, for two reasons. A driver that is recomputed
-- changes retroactively when a call is reprocessed or a lead is merged, so
-- last quarter's cost-per-call moves after the quarter closed. And the ones
-- that are NOT derivable - seats on a subscription, leads bought from a broker
-- - have to live somewhere, and splitting six drivers across two mechanisms is
-- how half of them get forgotten.
--
-- The worker fills what it can measure; the console accepts the rest.
CREATE TABLE IF NOT EXISTS cost_drivers (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind      text NOT NULL CHECK (kind IN (
              'call_minutes', 'calls_made', 'leads_bought',
              'messages_sent', 'seats', 'new_customers')),
  -- First day of the month, same convention and same CHECK as finance_periods.
  period    date NOT NULL CHECK (period = date_trunc('month', period)::date),
  value     numeric NOT NULL CHECK (value >= 0),
  -- Where the number came from, so a measured value is not silently overwritten
  -- by a typed one on the next sweep.
  source    text NOT NULL DEFAULT 'measured' CHECK (source IN ('measured', 'manual')),
  -- Optional narrowing, so cost per lead can be per SOURCE rather than
  -- org-wide - which is the only version of that metric anybody can act on.
  marketing_source_id uuid REFERENCES marketing_sources(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One value per (kind, period, source). `COALESCE(marketing_source_id, ...)` in
-- the index so the org-wide row and the per-source rows cannot collide: a NULL
-- in a unique index does not conflict with another NULL, which would otherwise
-- let two org-wide `calls_made` rows exist for the same month.
CREATE UNIQUE INDEX IF NOT EXISTS cost_drivers_unique
  ON cost_drivers (org_id, kind, period,
                   COALESCE(marketing_source_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS cost_drivers_org_period ON cost_drivers (org_id, period DESC);

ALTER TABLE cost_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_drivers FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON cost_drivers
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON cost_drivers TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON cost_drivers FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON cost_drivers FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER cost_drivers_set_updated_at BEFORE UPDATE ON cost_drivers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §10 incentive plans ────────────────────────────────────────────────────
--
-- `commission_plans` (0088) already exists and is NOT reused. It computes a
-- commission from BOOKED deal value for the sales report - §10 is a MUST that
-- incentives come from COLLECTED payments only, which is a different number
-- from a different table. Two mechanisms with the same name would be worse
-- than two names; the console labels this one "Incentives (paid on money
-- received)" and that distinction is the point.
CREATE TABLE IF NOT EXISTS incentive_plans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name           text NOT NULL,
  type           text NOT NULL CHECK (type IN ('slab', 'percent_of_collected', 'kpi_linked')),
  -- `IncentiveRules` in @aura/shared: percent, slabs, kpiMultipliers, floor, cap.
  rules          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- §10: a refund inside this window produces a negative line in the current
  -- period. 0 means no clawback - a legitimate choice for a business paying on
  -- cleared cash only.
  clawback_days  int NOT NULL DEFAULT 90 CHECK (clawback_days >= 0),
  -- §10: "effective-dated plans: a change never recalculates closed periods".
  effective_from date NOT NULL,
  effective_to   date,
  CONSTRAINT incentive_plans_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- Who it applies to. NULL = everybody on a telecaller/sales persona, which
  -- is the common case and saves a row per rep.
  user_id        uuid REFERENCES users(id) ON DELETE CASCADE,
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incentive_plans_org ON incentive_plans (org_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS incentive_plans_user
  ON incentive_plans (user_id, effective_from DESC) WHERE user_id IS NOT NULL;

ALTER TABLE incentive_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE incentive_plans FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON incentive_plans
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON incentive_plans TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON incentive_plans FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON incentive_plans FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER incentive_plans_set_updated_at BEFORE UPDATE ON incentive_plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §10 payouts ────────────────────────────────────────────────────────────
--
-- `user_id` is the column `scopeFilter('incentive', …)` narrows on, which is
-- what makes §3's "a telecaller must never read another telecaller's pay, even
-- by guessing an ID" a query rather than a convention. NOT NULL for that
-- reason: a payout with no owner would be readable by an `owned`-scoped role
-- only if the predicate were written to include NULLs, and it is not.
CREATE TABLE IF NOT EXISTS incentive_payouts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- First day of the month the payout is FOR.
  period           date NOT NULL CHECK (period = date_trunc('month', period)::date),
  plan_id          uuid REFERENCES incentive_plans(id) ON DELETE SET NULL,
  -- What the rules produced, from the lines below. Recomputable; stored
  -- because once approved it must not change when a plan is edited (§10's
  -- effective dating).
  calculated       numeric NOT NULL DEFAULT 0,
  -- Clawbacks and manual corrections, signed.
  adjustments      numeric NOT NULL DEFAULT 0,
  -- GENERATED, so the number somebody is paid cannot drift from its parts.
  payable          numeric GENERATED ALWAYS AS (calculated + adjustments) STORED,
  currency         text NOT NULL DEFAULT 'INR',
  status           text NOT NULL DEFAULT 'calculated'
                     CHECK (status IN ('calculated', 'approved', 'paid')),
  -- §10: "an owner/manager approval". Asserted in the API to be somebody
  -- other than `user_id` - a rep may not approve their own pay - which a CHECK
  -- cannot express because it needs the requester's identity.
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  paid_at          timestamptz,
  paid_reference   text,
  -- The KPI score used, when the plan is `kpi_linked`. Stored so a statement
  -- can be explained months later, after the score has moved.
  kpi_score        numeric,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One payout per person per month. The calculation re-runs and UPDATEs it
-- while `calculated`; once approved the API refuses to recompute.
CREATE UNIQUE INDEX IF NOT EXISTS incentive_payouts_unique
  ON incentive_payouts (org_id, user_id, period);
CREATE INDEX IF NOT EXISTS incentive_payouts_org_period
  ON incentive_payouts (org_id, period DESC, status);
CREATE INDEX IF NOT EXISTS incentive_payouts_user
  ON incentive_payouts (user_id, period DESC);

ALTER TABLE incentive_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE incentive_payouts FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON incentive_payouts
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE ON incentive_payouts TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON incentive_payouts FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON incentive_payouts FROM PUBLIC;
-- A payout is what somebody was paid. Recalculated while `calculated`,
-- never deleted.
REVOKE DELETE ON incentive_payouts FROM aura_app;
DO $$ BEGIN
  CREATE TRIGGER incentive_payouts_set_updated_at BEFORE UPDATE ON incentive_payouts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §10 payout lines ───────────────────────────────────────────────────────
--
-- The statement. One line per payment that earned (or clawed back) something,
-- so §10's "a statement per telecaller" is a real document and not a single
-- number somebody has to trust.
CREATE TABLE IF NOT EXISTS incentive_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payout_id   uuid NOT NULL REFERENCES incentive_payouts(id) ON DELETE CASCADE,
  deal_id     uuid REFERENCES deals(id) ON DELETE SET NULL,
  payment_id  uuid REFERENCES finance_payments(id) ON DELETE SET NULL,
  refund_id   uuid REFERENCES finance_refunds(id) ON DELETE SET NULL,
  -- What the percentage was applied TO - the collected amount for an earn, the
  -- refunded amount for a clawback. Stored because the rate is not enough to
  -- reconstruct the line once a plan changes.
  basis       numeric NOT NULL,
  amount      numeric NOT NULL,
  type        text NOT NULL CHECK (type IN ('earn', 'clawback', 'adjustment')),
  -- A clawback must say which refund caused it, or the rep cannot check it.
  CONSTRAINT incentive_lines_clawback_has_cause
    CHECK (type <> 'clawback' OR refund_id IS NOT NULL),
  memo        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incentive_lines_payout ON incentive_lines (payout_id);
-- §12.4 `incentive_not_clawed_back` asks "was this refund ever reversed?" -
-- this is the index that answers it.
CREATE UNIQUE INDEX IF NOT EXISTS incentive_lines_refund
  ON incentive_lines (refund_id) WHERE refund_id IS NOT NULL;
-- And the earn side: one earn per (payout, payment), so re-running the
-- calculation cannot double somebody's pay.
CREATE UNIQUE INDEX IF NOT EXISTS incentive_lines_earn
  ON incentive_lines (payout_id, payment_id) WHERE type = 'earn' AND payment_id IS NOT NULL;

ALTER TABLE incentive_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE incentive_lines FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON incentive_lines
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- DELETE is granted, and only for one path: re-running an UNAPPROVED
-- calculation replaces its lines. The API refuses once `status <> 'calculated'`,
-- which is where §10's "a change never recalculates closed periods" is held.
GRANT SELECT, INSERT, UPDATE, DELETE ON incentive_lines TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON incentive_lines FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON incentive_lines FROM PUBLIC;
