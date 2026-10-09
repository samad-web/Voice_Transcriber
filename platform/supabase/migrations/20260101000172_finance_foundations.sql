-- 0172_finance_foundations.sql
-- Build docs/finance-section-build-plan, M1: the business-agnostic deal layer.
--
-- ── WHAT THIS DOES AND DOES NOT CREATE ──────────────────────────────────────
--
-- It does NOT create a `deals` table. §9's data model names one, and this
-- platform has had `deals` since migration 0036 - a CRM record with a
-- pipeline, a stage, an owner, a telecaller, call counts and an attribution
-- snapshot. A second "deal" would mean the console had two things by that name
-- and the metrics layer had to pick one, which is exactly the two-sources-of-
-- truth problem §11 exists to prevent. So the finance columns are ADDED to the
-- deal that already exists.
--
-- It creates:
--   finance_settings    the per-org knobs §15 says are configurable
--   deal_templates      §5's owner-defined schedule shapes, versioned
--   payment_schedules   the rows a template generates for a deal
--   finance_periods     §9's period lock
--
-- and seeds the `finance`/`incentive` permission grants that
-- `CrmPermissionsGuard` denies without.
--
-- ── MONEY IS `numeric`, NOT `BIGINT` MINOR UNITS ────────────────────────────
--
-- §2's default is integer minor units. DECISIONS.md §3.1 is the full argument;
-- the short version is that every money column this platform already has is
-- `numeric` (invoices.total, payments.amount, products.price), `numeric` is
-- exact decimal rather than floating point, and a BIGINT-paise ledger beside a
-- numeric invoice puts `round(total * 100)` in the middle of every drill-down
-- join - while §11 requires those joins to reconcile. The arithmetic moved to
-- integers instead, in `packages/shared/src/money.ts`, because the actual
-- float risk in this stack is JavaScript's `number`, not Postgres.

-- ── Per-org settings ────────────────────────────────────────────────────────
--
-- Every column is NULLable WITH NO DEFAULT, deliberately. The defaults live in
-- `FINANCE_DEFAULTS` (packages/shared/src/finance.ts) and the API coalesces to
-- them. A `DEFAULT 50000` here would be a second copy of §15's table, and the
-- column would quietly win - so a change to the shared default would apply to
-- new orgs only, which is the hardest kind of inconsistency to notice.
CREATE TABLE IF NOT EXISTS finance_settings (
  org_id                      uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- §6.2: cash/cheque/DD above this needs a second person's approval.
  manual_approval_threshold   numeric,
  -- §8: auto-apply a match at or above this confidence.
  auto_match_confidence       numeric CHECK (auto_match_confidence IS NULL
                                             OR (auto_match_confidence >= 0 AND auto_match_confidence <= 1)),
  -- §12.4: statistical rules stay silent below this many periods of history.
  min_statistical_sample      int CHECK (min_statistical_sample IS NULL OR min_statistical_sample >= 2),
  -- §12.5: hours unacknowledged before an alert climbs the ladder.
  escalation_hours            int[],
  -- §12.5: no PUSH inside this window, org timezone. Detection is unaffected.
  quiet_hours_from            int CHECK (quiet_hours_from IS NULL OR quiet_hours_from BETWEEN 0 AND 23),
  quiet_hours_to              int CHECK (quiet_hours_to   IS NULL OR quiet_hours_to   BETWEEN 0 AND 23),
  -- §12.4 `cash_runway_low`: the balance the forecast may not cross.
  minimum_cash                numeric,
  -- §7.2.7: a settlement whose net differs from the bank credit by more.
  settlement_tolerance        numeric,
  -- §12.4 `discount_abuse`: the discount a rep may give without a question.
  discount_policy_percent     numeric CHECK (discount_policy_percent IS NULL
                                             OR (discount_policy_percent >= 0 AND discount_policy_percent <= 100)),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_settings FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON finance_settings
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_settings TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON finance_settings FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON finance_settings FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER finance_settings_set_updated_at BEFORE UPDATE ON finance_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §5 deal templates ──────────────────────────────────────────────────────
--
-- ── WHY A VERSION COLUMN AND NOT A HISTORY TABLE ───────────────────────────
--
-- §5: "changing a template creates a new version; existing deals keep the
-- version they were created with." Both halves are load-bearing. A template
-- edited in place would retroactively change what a deal was sold under -
-- which is how a schedule generated in January stops matching the template it
-- came from, and how a custom field a deal depends on simply disappears.
--
-- So an edit INSERTs a row with the same `template_key` and `version + 1`, and
-- `deals.finance_template_version` pins which one a deal used. `active` marks
-- the version a new deal gets; superseded rows stay readable forever.
--
-- `template_key` rather than a self-referencing parent id: the key is what a
-- person named the template, it survives every version, and it makes "the
-- current version of X" a single indexed lookup instead of a recursive walk.
CREATE TABLE IF NOT EXISTS deal_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_key    text NOT NULL,
  version         int  NOT NULL DEFAULT 1 CHECK (version >= 1),
  name            text NOT NULL,
  schedule_type   text NOT NULL CHECK (schedule_type IN
                    ('one_time', 'installments', 'recurring', 'commission', 'custom')),
  -- §5's schedule parameters. Validated by `ScheduleParams` + the
  -- `validateScheduleParams` shape check in the API, NOT by a CHECK here: the
  -- five shapes need five different sets of keys, and a CHECK that encoded
  -- that would have to be rewritten for a sixth shape in a migration.
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- §5's `{key, label, type, required}` list.
  custom_fields   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- §5's `{gstRate, inclusive}`.
  tax             jsonb NOT NULL DEFAULT '{}'::jsonb,
  currency        text NOT NULL DEFAULT 'INR',
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_templates_version
  ON deal_templates (org_id, template_key, version);
-- One ACTIVE version per key. A partial unique index rather than application
-- logic, because "activate v3" and "activate v4" racing would otherwise leave
-- two actives and a deal would silently pick whichever the planner returned.
CREATE UNIQUE INDEX IF NOT EXISTS deal_templates_active
  ON deal_templates (org_id, template_key) WHERE active;
CREATE INDEX IF NOT EXISTS deal_templates_org ON deal_templates (org_id, lower(name));

ALTER TABLE deal_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_templates FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON deal_templates
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON deal_templates TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON deal_templates FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON deal_templates FROM PUBLIC;
-- §5: "existing deals keep the version they were created with", which depends
-- on the row surviving. A version is retired by `active = false`, never
-- removed, and the API has no delete route - so the privilege goes too.
REVOKE DELETE ON deal_templates FROM aura_app;
DO $$ BEGIN
  CREATE TRIGGER deal_templates_set_updated_at BEFORE UPDATE ON deal_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── The finance half of a deal ─────────────────────────────────────────────
--
-- `ON DELETE SET NULL` for the template: a template version is never deleted
-- (there is no delete route), but if one ever were, losing the deal would be
-- far worse than losing the link to how its schedule was generated.
--
-- `finance_closed_on` is a DATE and separate from `updated_at`, because every
-- offset in §5 is measured from the day the deal closed and `deals` has never
-- recorded one - `status` moved to 'won' and only `updated_at` noticed, which
-- changes again on the next edit. Without this column, "due 30 days after
-- closing" would drift every time somebody touched the record.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS finance_template_id      uuid REFERENCES deal_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS finance_template_version int,
  ADD COLUMN IF NOT EXISTS finance_custom_fields    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS finance_closed_on        date,
  ADD COLUMN IF NOT EXISTS currency                 text NOT NULL DEFAULT 'INR',
  -- §15's overpayment rule: what is left after the last open schedule item
  -- becomes a credit on the deal. A column rather than a derived figure
  -- because it is money the business OWES the customer, and a balance owed
  -- that only exists as the output of a query is a balance that gets lost.
  ADD COLUMN IF NOT EXISTS credit_balance           numeric NOT NULL DEFAULT 0
    CHECK (credit_balance >= 0);

COMMENT ON COLUMN deals.finance_closed_on IS
  'The day the deal closed, as a date in the org''s own calendar. Every §5 '
  'schedule offset is measured from here; `updated_at` cannot serve because it '
  'changes on the next edit.';

CREATE INDEX IF NOT EXISTS deals_finance_template
  ON deals (finance_template_id) WHERE finance_template_id IS NOT NULL;

-- Backfill the close date for deals already won, so a template applied to an
-- existing deal does not generate a schedule starting today. `updated_at` is
-- the best available evidence and is right for anything closed recently; it
-- is explicitly an approximation, which is why the column is nullable and the
-- API asks for the date when generating a schedule.
UPDATE deals
   SET finance_closed_on = updated_at::date
 WHERE status = 'won'
   AND finance_closed_on IS NULL;

-- ── §5/§9 payment schedules ────────────────────────────────────────────────
--
-- ── `status` MAY NOT HOLD 'overdue' ────────────────────────────────────────
--
-- §9's enum lists it. The CHECK below refuses it, and that is the one
-- deliberate departure from the spec's own data model.
--
-- This repo has the scar: `invoices.status` has allowed 'overdue' since 0060
-- and NOTHING SET IT for a year, so `due_date` was decorative and the report
-- templates from 0088 filtered on a value only a human could type. Doc 37 R4
-- eventually added a sweep. A stored status that depends on today's date is
-- only ever as correct as the last time a job ran - so here it is DERIVED at
-- read time by `scheduleItemStatus()`, which cannot drift at all.
--
-- `paid_amount <= amount` is NOT constrained, because §15 puts overpayment on
-- the deal's credit balance and the matcher caps each application at what the
-- item owes - but a bank that credits twice is a real event, and a CHECK that
-- rejected the record of it would leave the money nowhere. The invariant is
-- asserted in the ledger instead, where it can be corrected by a reversal.
CREATE TABLE IF NOT EXISTS payment_schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id       uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  -- Which generated row this is, 1-based. Lets the console say "instalment
  -- 3 of 12" without counting, and makes a regenerated schedule comparable to
  -- the one it replaced.
  position      int  NOT NULL DEFAULT 1,
  due_date      date NOT NULL,
  amount        numeric NOT NULL CHECK (amount >= 0),
  paid_amount   numeric NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'partial', 'paid', 'cancelled')),
  -- §12.4 `slipped_promise`: the date a customer SAID they would pay, which is
  -- not the due date. Nullable because most items never get one; set by the
  -- collector from the dues screen.
  promised_on   date,
  -- Which invoice (0060) billed this item, when one did. Nullable: an
  -- instalment plan does not need an invoice per instalment, and plenty of
  -- businesses on this platform never raise one at all.
  invoice_id    uuid REFERENCES invoices(id) ON DELETE SET NULL,
  memo          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- §9's required index, plus the two the dues screen and the detail page use.
CREATE INDEX IF NOT EXISTS payment_schedules_org_status_due
  ON payment_schedules (org_id, status, due_date);
CREATE INDEX IF NOT EXISTS payment_schedules_deal
  ON payment_schedules (deal_id, position);
-- The collections sweep's own query: what is open and promised.
CREATE INDEX IF NOT EXISTS payment_schedules_promised
  ON payment_schedules (org_id, promised_on)
  WHERE promised_on IS NOT NULL AND status <> 'paid';

ALTER TABLE payment_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_schedules FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON payment_schedules
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_schedules TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON payment_schedules FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON payment_schedules FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER payment_schedules_set_updated_at BEFORE UPDATE ON payment_schedules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §9 period locking ──────────────────────────────────────────────────────
--
-- One row per locked month. An UNLOCKED month has no row, so "is this period
-- open" is an absence rather than a flag - which means a month can never be
-- half-locked by a failed write, and the table stays small forever.
CREATE TABLE IF NOT EXISTS finance_periods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The first day of the month, so the column is a date rather than a string
  -- somebody has to parse. A CHECK pins it, because '2026-02-15' as a month
  -- would make the lock match nothing.
  month      date NOT NULL CHECK (month = date_trunc('month', month)::date),
  locked_at  timestamptz NOT NULL DEFAULT now(),
  locked_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  note       text
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_periods_month ON finance_periods (org_id, month);

ALTER TABLE finance_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_periods FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON finance_periods
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, DELETE ON finance_periods TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON finance_periods FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON finance_periods FROM PUBLIC;
-- A lock is created or removed, never EDITED: changing `month` on an existing
-- row would silently move which period is closed, and `locked_by` is the
-- record of who closed it. See the note at the end of this file for why a
-- GRANT alone would not have achieved this.
REVOKE UPDATE ON finance_periods FROM aura_app;

-- ── The lock, as a function ────────────────────────────────────────────────
--
-- §13: "period locking enforced in the data layer". There is no data-access
-- layer in this codebase to put it in - controllers issue SQL directly through
-- `withOrgContext` - so it is a trigger, attached in 0173/0175 to each table
-- that holds a dated money row.
--
-- A handler that forgets to check gets an exception from Postgres instead of
-- silently writing into a closed month. That is the whole point: the check
-- being somewhere a developer must remember is the same as the check not
-- existing, which is the lesson `verify-rls.js` records about RLS policies.
CREATE OR REPLACE FUNCTION finance_period_locked(p_org_id uuid, p_on date)
RETURNS boolean
LANGUAGE sql
STABLE
-- SECURITY INVOKER (the default) and `search_path` pinned: this is called from
-- a trigger running as the writing role, and it must see that role's RLS view
-- of `finance_periods` rather than the table owner's.
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM finance_periods
     WHERE org_id = p_org_id
       AND month = date_trunc('month', p_on)::date
  )
$$;

COMMENT ON FUNCTION finance_period_locked(uuid, date) IS
  'True when the org has closed the month containing this date. Used by the '
  'finance_refuse_locked_period trigger on every dated money table.';

CREATE OR REPLACE FUNCTION finance_refuse_locked_period()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  effective_on date;
  org uuid;
BEGIN
  -- The date column differs per table (`received_at`, `posted_at`,
  -- `incurred_on`), so the trigger is attached with the column name as an
  -- argument rather than guessing. TG_ARGV[0] is that column.
  EXECUTE format('SELECT ($1.%I)::date, $1.org_id', TG_ARGV[0])
    INTO effective_on, org
    USING NEW;

  IF effective_on IS NOT NULL AND finance_period_locked(org, effective_on) THEN
    -- 23514 (check_violation) rather than a bare RAISE, so `pg-errors.ts` can
    -- map it to a 409 the console renders as "that month is closed" instead of
    -- a 500 somebody has to read the logs to understand.
    RAISE EXCEPTION 'finance period % is locked', to_char(effective_on, 'YYYY-MM')
      USING ERRCODE = 'check_violation',
            HINT = 'Post this as an adjustment dated in the current open period.';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION finance_refuse_locked_period() IS
  'Trigger: refuses an INSERT/UPDATE whose date column (TG_ARGV[0]) falls in a '
  'locked month. Attached in 0173 and 0175.';

-- ── §3 the permission grants ───────────────────────────────────────────────
--
-- THE STEP THAT MUST NOT BE SKIPPED. `CrmPermissionsGuard` denies whatever it
-- finds no grant for, so widening `PermissionObjectType` without seeding here
-- locks every user out of the new object on deploy day - the lesson 0041,
-- 0059/0060, 0103 and 0158 each record in their own headers.
--
-- `finance:view` to the three admin roles and to `viewer`, but NOT to
-- `workspace_member`. That exclusion is the deliberate one: a telecaller
-- holding `finance:view` would read the whole floor's collections, every
-- expense and the ledger - and `finance` is in ALL_SCOPE_ONLY_OBJECTS, so
-- there is no `owned` scope to hand them instead. What a telecaller actually
-- needs ("my sales, my collections, my dues to chase", §11) is served by the
-- deal and lead grants they already hold plus `incentive:view` at `owned`.
-- `viewer` is included because a viewer is an auditor-shaped role and reading
-- is all it can ever do.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'finance', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin', 'viewer')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- Create / edit / export - the three admin roles only. This is what "finance
-- handler" means in this platform (DECISIONS.md §3.3): no new persona, a
-- grant. `export` is separate because the ledger CSV is the one place a
-- client's entire money history leaves the system.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'finance', a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('create'), ('edit'), ('export')) AS a(action)
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- ── `incentive`, and the one `owned` grant in this migration ───────────────
--
-- §3: "a telecaller must never be able to read another telecaller's pay or
-- incentive, even by guessing an ID." `workspace_member` therefore gets
-- `incentive:view` at **owned** scope - the grid's row filter, applied by
-- `scopeFilter('incentive', …)` against `incentive_payouts.user_id` - and the
-- guard's persona intersection narrows it again for anybody on a telecaller or
-- sales persona even if an admin later widens the grant to `all`.
--
-- `viewer` gets `all`: it is the auditor role, and an auditor who can see
-- every payout but not whose it is cannot audit anything.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'incentive', 'view', 'owned'
  FROM roles r
 WHERE r.is_system AND r.key = 'workspace_member'
ON CONFLICT (role_id, object_type, action) DO NOTHING;

INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'incentive', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin', 'viewer')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- Approving and marking a payout paid. Admin roles only - §10's payout flow
-- needs "an owner/manager approval", and a rep approving their own pay is the
-- one thing this grant exists to make impossible.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'incentive', 'edit', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- ── Prove it, rather than assume it ────────────────────────────────────────
--
-- Every active membership in an org that HAS the finance module must resolve
-- to an `incentive:view` grant through the same join the guard uses, including
-- its `role_id IS NULL` fallback. `incentive:view` and not `finance:view`,
-- because `workspace_member` is deliberately excluded from the latter.
--
-- A WARNING, not an exception: this runs inside the deploy's migrate job, and
-- aborting would leave the schema half-applied and the deploy dead in order to
-- report a data condition that is visible and repairable from the console.
-- Today the count will be zero for the additional reason that no org has the
-- module yet - which is itself worth seeing in the log.
DO $do$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
    FROM memberships m
    JOIN organizations o ON o.id = m.org_id AND 'finance' = ANY(o.enabled_modules)
   WHERE m.status = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM roles r
         JOIN role_permissions rp
           ON rp.role_id = r.id AND rp.object_type = 'incentive' AND rp.action = 'view'
        WHERE r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
     );

  IF stranded > 0 THEN
    RAISE WARNING '0172: % membership(s) in a finance org resolve to no incentive:view grant (custom roles are not seeded) - grant it on Team & permissions', stranded;
  ELSE
    RAISE NOTICE '0172: every active membership in a finance-enabled org resolves to an incentive:view grant';
  END IF;
END $do$;
