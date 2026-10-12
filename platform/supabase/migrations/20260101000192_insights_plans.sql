-- 0192_insights_plans.sql - plans, entitlements and usage meters for the
-- API-only tier (Build docs/no-crm-api-dashboard-build-plan.md §4 and §10,
-- M1; INSIGHTS_TIER_DECISIONS.md §1, §6, §7).
--
-- `organizations.plan_id` has been a dormant text column since day one and
-- packages/shared/src/plans.ts has documented it, in writing, as "a seam for a
-- feature that doesn't exist yet". This is that feature. `plans.ts` keeps its
-- job - resolving plan_id -> what's included - and stops being a stub whose
-- only function returns true for everybody.
--
-- ── WHY TWO TABLES AND NOT A CONSTANT ────────────────────────────────────────
--
-- The spec's §4 MUST: "Plan definitions live in `plan` and `plan_entitlement`
-- tables so product can change limits without a release." The numbers are a
-- commercial decision and must not need a deploy. The KEYS are not - they are
-- names routes spell in decorators - so they stay in
-- packages/shared/src/entitlements.ts, and the seed below is checked against
-- that file by entitlements-seed.test.ts. A migration cannot import TypeScript,
-- which is the same reason 0093 hardcodes the feature/module pairs and
-- org-features.test.ts checks them.
--
-- ── WHY plans AND plan_entitlements HAVE NO org_id ───────────────────────────
--
-- They are the catalogue, not a tenant's copy of it. One row for "Growth",
-- shared by every tenant on Growth; an org_id here would have nothing to put
-- in it. Exactly the argument `app_releases` (0081) makes for the one APK the
-- whole fleet installs: this is not tenant data that lost its scoping, it is
-- platform data that never had any.
--
-- Consequences, both deliberate:
--
--   * Both are added to NON_TENANT_TABLES in verify-rls.js, which otherwise
--     fails the deploy. That allowlist is short on purpose and this edit is the
--     reviewed one it asks for.
--   * `aura_app` gets NO grant on either. Entitlement resolution runs on the
--     ADMIN pool, narrowed by an explicit `org_id = $1` - the same bootstrap
--     exception ApiKeyGuard documents for resolving an org from a key hash, and
--     for the same reason: the question "what may this tenant do" has to be
--     answerable before a tenant context exists to ask it in. The four
--     org-scoped tables below are RLS'd normally.
--
-- ── NO PAYMENT PROVIDER ──────────────────────────────────────────────────────
--
-- The project owner's decision, 2026-10-10: there is no Razorpay account yet.
-- `provider` defaults to 'none' and 'razorpay' is already legal in the CHECK,
-- so wiring one later needs no migration. `price_minor` is NULL on every seeded
-- plan and the Compare-plans page renders "Talk to us" while it is - no price
-- is hard-coded anywhere, which is the spec's §9.6 requirement.

------------------------------------------------------------------------------
-- The catalogue
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name        text NOT NULL,
  blurb       text,
  -- Minor units plus a currency code, never a float (§2). NULL means "not
  -- priced here", which is every plan today and is what makes the upgrade CTA
  -- "Talk to us" rather than a checkout that cannot complete.
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  currency    text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  period      text NOT NULL DEFAULT 'monthly' CHECK (period IN ('monthly', 'yearly')),
  -- An inactive plan keeps serving the tenants already on it and stops being
  -- offered. Deleting a plan somebody is subscribed to is the thing this
  -- column exists to make unnecessary.
  active      bool NOT NULL DEFAULT true,
  sort        int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_entitlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  entitlement_key  text NOT NULL,
  limit_type       text NOT NULL CHECK (limit_type IN ('hard', 'quota', 'window')),
  -- Shape depends on limit_type and is validated in zod at the write path
  -- (EntitlementValue). NOT a CHECK: the shapes are a union of three object
  -- types and encoding that in SQL would be a second, drifting copy of a
  -- schema the API already enforces. Same call `features.ts` makes about not
  -- adding a CHECK listing the feature keys.
  value            jsonb NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- One answer per plan per key. Two rows would make `check()` pick one, and
  -- which one it picked would decide whether a tenant is entitled.
  UNIQUE (plan_id, entitlement_key)
);

CREATE INDEX IF NOT EXISTS plan_entitlements_key ON plan_entitlements (entitlement_key);

DO $$ BEGIN
  CREATE TRIGGER plans_set_updated_at BEFORE UPDATE ON plans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER plan_entitlements_set_updated_at BEFORE UPDATE ON plan_entitlements
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Admin pool only. REVOKE before any GRANT, the 0089 order, because a GRANT-only
-- migration narrows nothing: `marketing`'s public web role kept INSERT for
-- exactly this reason.
DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans', 'plan_entitlements'] LOOP
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
      EXECUTE format('REVOKE ALL ON %I FROM aura_app', t);
    END IF;
  END LOOP;
END $$;

------------------------------------------------------------------------------
-- Which plan a tenant is on
--
-- One row per org, not a history of rows. A subscription's history is the
-- audit log's job (`audit_log`, already append-only); keeping it here would
-- mean every read has to pick the current one, and "pick the current one" is
-- where a plan lookup starts returning two answers.
--
-- `trial_plan_id` is separate from `plan_id` rather than replacing it, which is
-- the whole mechanism behind §9.5's automatic revert: the plan the tenant pays
-- for is never overwritten by a trial, so reverting is clearing one column
-- rather than remembering what to restore. A trial that forgot what it was
-- interrupting is a trial that cannot end safely.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_subscriptions (
  org_id             uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id            uuid NOT NULL REFERENCES plans(id),
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled')),
  trial_plan_id      uuid REFERENCES plans(id),
  trial_ends_at      timestamptz,
  -- Set when a downgrade is accepted, applied at the end of the period (§9.6).
  -- The downgrade is therefore a *scheduled* write and not an immediate one,
  -- which is what lets the owner see a preview and change their mind.
  pending_plan_id    uuid REFERENCES plans(id),
  current_period_end timestamptz,
  cancel_at          timestamptz,
  provider           text NOT NULL DEFAULT 'none'
                       CHECK (provider IN ('none', 'razorpay')),
  billing_ref        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- A trial has to say both which plan and until when, or the revert sweep has
  -- nothing to act on and the tenant keeps a tier nobody is paying for.
  CONSTRAINT org_subscriptions_trial_complete CHECK (
    (trial_plan_id IS NULL AND trial_ends_at IS NULL)
    OR (trial_plan_id IS NOT NULL AND trial_ends_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS org_subscriptions_trial_ending
  ON org_subscriptions (trial_ends_at) WHERE trial_ends_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS org_subscriptions_period_end
  ON org_subscriptions (current_period_end) WHERE pending_plan_id IS NOT NULL;

------------------------------------------------------------------------------
-- Usage meters
--
-- `period` is a text bucket - '2026-10' for a monthly volume, 'current' for a
-- standing count - rather than a date range. A range would make "which bucket
-- does this write belong to" a query; a derived key makes it a string, which
-- is what keeps the hot ingestion path to one UPSERT.
--
-- A standing count ('current') is RECOMPUTED by a sweep rather than
-- incremented, for the same reason telecaller-stats recomputes: archiving a
-- telecaller has to free a slot, and a counter that only ever goes up cannot.
-- A monthly volume IS incremented, because there is nothing to recount it
-- from once the raw events age out.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_meters (
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entitlement_key text NOT NULL,
  period          text NOT NULL,
  used            bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  -- Set the first time a meter crosses QUOTA_WARN_AT in a period, so the §9.2
  -- banner and the owner email fire once rather than on every tick. Cleared
  -- when the period rolls over, which happens by the period key changing.
  warned_at       timestamptz,
  blocked_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, entitlement_key, period)
);

CREATE INDEX IF NOT EXISTS usage_meters_org_key
  ON usage_meters (org_id, entitlement_key, period);

------------------------------------------------------------------------------
-- Plan changes an owner asks for
--
-- With no payment provider, "upgrade" is a request an operator applies. The
-- row is the contract between the two consoles: the owner's click creates it,
-- the operator's action in /admin resolves it, and a future provider webhook
-- would resolve it the same way. Nothing here charges anybody.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plan_change_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_plan_id  uuid REFERENCES plans(id),
  kind               text NOT NULL
                       CHECK (kind IN ('upgrade', 'downgrade', 'cancel', 'demo')),
  note               text,
  requested_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'applied', 'declined', 'withdrawn')),
  decided_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at         timestamptz,
  decision_note      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One open request per org. A second click must not queue a second row for an
-- operator to wonder about; the API updates the open one instead.
CREATE UNIQUE INDEX IF NOT EXISTS plan_change_requests_one_open
  ON plan_change_requests (org_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS plan_change_requests_open
  ON plan_change_requests (status, created_at DESC) WHERE status = 'open';

-- A cancel names no plan; everything else must.
ALTER TABLE plan_change_requests DROP CONSTRAINT IF EXISTS plan_change_requests_plan_present;
ALTER TABLE plan_change_requests ADD CONSTRAINT plan_change_requests_plan_present CHECK (
  kind = 'cancel' OR requested_plan_id IS NOT NULL
);

------------------------------------------------------------------------------
-- Upsell telemetry (§9.7's frequency cap, and the funnel it asks us to track)
--
-- This table is what makes "at most one in-app banner per user per week" a
-- fact rather than an intention: the cap is a query against it, so a surface
-- that forgets to check cannot show a banner, because showing one means
-- writing the row first.
--
-- `user_id` is NOT NULL. A dismissal that belongs to nobody is a dismissal
-- that cannot be respected, and §9.7 says dismissals are respected and stored.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS upsell_impressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_key text NOT NULL,
  surface     text NOT NULL,
  shown_at    timestamptz NOT NULL DEFAULT now(),
  action      text CHECK (action IS NULL OR action IN ('dismissed', 'clicked', 'upgraded')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS upsell_impressions_recent
  ON upsell_impressions (org_id, user_id, shown_at DESC);
CREATE INDEX IF NOT EXISTS upsell_impressions_trigger
  ON upsell_impressions (org_id, trigger_key, shown_at DESC);

------------------------------------------------------------------------------
-- RLS for the four org-scoped tables
--
-- The partner_wall block is not optional. 0163's enumeration could only wall
-- the tables that existed when it ran, so every org-scoped table added after
-- it must create its own RESTRICTIVE policy - without one, a channel partner
-- inside the portal reads the table, and `org_isolation` does not help because
-- a partner principal is inside the org. verify-rls.js fails the deploy for a
-- table that forgets it. 0165 and 0166 carry the same block.
------------------------------------------------------------------------------

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'org_subscriptions', 'usage_meters', 'plan_change_requests', 'upsell_impressions'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    END IF;
    -- Its own BEGIN block, not the loop's. An EXCEPTION handler on the loop
    -- body would swallow the duplicate AND abandon the remaining tables, so a
    -- re-run would leave the last three walls uncreated while reporting success.
    BEGIN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I
           FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_set_updated_at', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

-- Prove the wall exists and is RESTRICTIVE. A `partner_wall` created as
-- PERMISSIVE would be ORed with org_isolation and let every partner through
-- while looking, in `pg_policies`, exactly like the real thing. 0184 checks
-- its own tables this way and this is the same assertion.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY[
      'org_subscriptions', 'usage_meters', 'plan_change_requests', 'upsell_impressions'
    ]) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
        AND policyname = 'partner_wall' AND permissive = 'RESTRICTIVE'
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0192: partner_wall missing or not RESTRICTIVE on: %', missing;
  END IF;
END $$;

------------------------------------------------------------------------------
-- The seed (spec §4; packages/shared/src/entitlements.ts PLAN_SEED)
--
-- Written as one JSON document per plan rather than 92 VALUES rows, so that
-- entitlements-seed.test.ts can parse this file and compare it to PLAN_SEED
-- key by key. Four blobs a machine checks beat ninety-two rows a reviewer
-- counts by eye.
--
-- EVERY plan carries EVERY key, including the ones it does not get. A missing
-- row would make `check()` decide between "unlimited" and "denied" from an
-- absence, and those two must never be the same value.
------------------------------------------------------------------------------

INSERT INTO plans (key, name, blurb, sort) VALUES
  ('starter',  'Starter (API Insights)', 'Send us your data and see how your floor performs.', 1),
  ('growth',   'Growth',                 'More capacity, scheduled reports, alerts and webhooks.', 2),
  ('scale',    'Scale',                  'Org chart, full finance, branding, SSO and the long history.', 3),
  ('platform', 'Platform (CRM + AI)',    'Everything, plus the CRM and the AI read of every call.', 4)
ON CONFLICT (key) DO NOTHING;

-- ENTITLEMENT_LIMIT_TYPES
WITH limit_types(entitlement_key, limit_type) AS (VALUES
  ('active_telecallers',     'quota'),
  ('dashboard_logins',       'quota'),
  ('ingest_events_monthly',  'quota'),
  ('api_rate_per_min',       'quota'),
  ('history_retention',      'window'),
  ('selectable_kpis',        'quota'),
  ('custom_kpis',            'hard'),
  ('team_structure',         'hard'),
  ('export_formats',         'hard'),
  ('scheduled_reports',      'hard'),
  ('threshold_alerts',       'hard'),
  ('outgoing_webhooks',      'hard'),
  ('import_center',          'hard'),
  ('manual_quality_scoring', 'hard'),
  ('revenue_summary',        'hard'),
  ('audit_log_window',       'window'),
  ('sso',                    'hard'),
  ('ip_allowlist',           'hard'),
  ('white_label',            'hard'),
  ('handset_pairing',        'hard'),
  ('paired_handsets',        'quota'),
  ('crm',                    'hard'),
  ('ai_features',            'hard')
),
-- PLAN_SEED_STARTER
seed(plan_key, entitlements) AS (VALUES
  ('starter', '{
    "active_telecallers":     {"limit": 10},
    "dashboard_logins":       {"limit": 3},
    "ingest_events_monthly":  {"limit": 50000, "per": "month"},
    "api_rate_per_min":       {"limit": 60, "per": "minute"},
    "history_retention":      {"months": 3},
    "selectable_kpis":        {"limit": 4},
    "custom_kpis":            {"enabled": false},
    "team_structure":         {"enabled": true, "variant": "flat"},
    "export_formats":         {"enabled": true, "variant": "csv_limited"},
    "scheduled_reports":      {"enabled": false},
    "threshold_alerts":       {"enabled": false},
    "outgoing_webhooks":      {"enabled": false},
    "import_center":          {"enabled": true, "variant": "single_template"},
    "manual_quality_scoring": {"enabled": false},
    "revenue_summary":        {"enabled": false},
    "audit_log_window":       {"days": 30},
    "sso":                    {"enabled": false},
    "ip_allowlist":           {"enabled": false},
    "white_label":            {"enabled": false},
    "handset_pairing":        {"enabled": true},
    "paired_handsets":        {"limit": 10},
    "crm":                    {"enabled": false},
    "ai_features":            {"enabled": false}
  }'::jsonb),
  -- PLAN_SEED_GROWTH
  ('growth', '{
    "active_telecallers":     {"limit": 50},
    "dashboard_logins":       {"limit": 10},
    "ingest_events_monthly":  {"limit": 500000, "per": "month"},
    "api_rate_per_min":       {"limit": 300, "per": "minute"},
    "history_retention":      {"months": 12},
    "selectable_kpis":        {"limit": 6},
    "custom_kpis":            {"enabled": false},
    "team_structure":         {"enabled": true, "variant": "teams"},
    "export_formats":         {"enabled": true, "variant": "csv_excel"},
    "scheduled_reports":      {"enabled": true, "variant": "weekly_monthly"},
    "threshold_alerts":       {"enabled": true, "variant": "email"},
    "outgoing_webhooks":      {"enabled": true},
    "import_center":          {"enabled": true, "variant": "saved_mappings"},
    "manual_quality_scoring": {"enabled": true},
    "revenue_summary":        {"enabled": true, "variant": "basic"},
    "audit_log_window":       {"months": 12},
    "sso":                    {"enabled": false},
    "ip_allowlist":           {"enabled": false},
    "white_label":            {"enabled": false},
    "handset_pairing":        {"enabled": true},
    "paired_handsets":        {"limit": 50},
    "crm":                    {"enabled": false},
    "ai_features":            {"enabled": false}
  }'::jsonb),
  -- PLAN_SEED_SCALE
  ('scale', '{
    "active_telecallers":     {"limit": 200},
    "dashboard_logins":       {"limit": 50},
    "ingest_events_monthly":  {"limit": 5000000, "per": "month"},
    "api_rate_per_min":       {"limit": 1500, "per": "minute"},
    "history_retention":      {"months": 36},
    "selectable_kpis":        {"limit": 6},
    "custom_kpis":            {"enabled": true},
    "team_structure":         {"enabled": true, "variant": "org_chart"},
    "export_formats":         {"enabled": true, "variant": "csv_excel_pdf"},
    "scheduled_reports":      {"enabled": true, "variant": "unlimited_branded"},
    "threshold_alerts":       {"enabled": true, "variant": "email_whatsapp_escalation"},
    "outgoing_webhooks":      {"enabled": true},
    "import_center":          {"enabled": true, "variant": "advanced"},
    "manual_quality_scoring": {"enabled": true},
    "revenue_summary":        {"enabled": true, "variant": "full"},
    "audit_log_window":       {"months": null},
    "sso":                    {"enabled": true},
    "ip_allowlist":           {"enabled": true},
    "white_label":            {"enabled": true},
    "handset_pairing":        {"enabled": true},
    "paired_handsets":        {"limit": 200},
    "crm":                    {"enabled": false},
    "ai_features":            {"enabled": false}
  }'::jsonb),
  -- PLAN_SEED_PLATFORM
  ('platform', '{
    "active_telecallers":     {"limit": null},
    "dashboard_logins":       {"limit": null},
    "ingest_events_monthly":  {"limit": null, "per": "month"},
    "api_rate_per_min":       {"limit": null, "per": "minute"},
    "history_retention":      {"months": null},
    "selectable_kpis":        {"limit": 6},
    "custom_kpis":            {"enabled": true},
    "team_structure":         {"enabled": true, "variant": "org_chart"},
    "export_formats":         {"enabled": true, "variant": "csv_excel_pdf"},
    "scheduled_reports":      {"enabled": true, "variant": "unlimited_branded"},
    "threshold_alerts":       {"enabled": true, "variant": "email_whatsapp_escalation"},
    "outgoing_webhooks":      {"enabled": true},
    "import_center":          {"enabled": true, "variant": "advanced"},
    "manual_quality_scoring": {"enabled": true},
    "revenue_summary":        {"enabled": true, "variant": "full"},
    "audit_log_window":       {"months": null},
    "sso":                    {"enabled": true},
    "ip_allowlist":           {"enabled": true},
    "white_label":            {"enabled": true},
    "handset_pairing":        {"enabled": true},
    "paired_handsets":        {"limit": null},
    "crm":                    {"enabled": true},
    "ai_features":            {"enabled": true}
  }'::jsonb)
)
-- PLAN_SEED_END
INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_type, value)
SELECT p.id, e.key, t.limit_type, e.value
  FROM seed s
  JOIN plans p ON p.key = s.plan_key
  CROSS JOIN LATERAL jsonb_each(s.entitlements) AS e(key, value)
  JOIN limit_types t ON t.entitlement_key = e.key
ON CONFLICT (plan_id, entitlement_key) DO NOTHING;

-- Every plan must have every key. An absent row is the one failure mode this
-- whole table shape exists to avoid, so it is asserted rather than hoped for:
-- 4 plans x 23 keys.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM plan_entitlements;
  IF n < 4 * 23 THEN
    RAISE EXCEPTION '0192: expected at least % plan_entitlements rows, found %', 4 * 23, n;
  END IF;
END $$;

------------------------------------------------------------------------------
-- Existing tenants
--
-- Every org that exists today predates this table and is on whatever an
-- operator hand-toggled in `enabled_modules`. Putting them on a plan would
-- RESOLVE that plan's module set over the top and could take CRM away from a
-- paying customer, so this migration deliberately creates NO subscription rows
-- and NO org gets a plan. `check()` treats an org with no subscription as
-- unlimited, which is exactly the product they have today, and the
-- INSIGHTS_TIER_DECISIONS §7 asymmetry means that is the fail-open direction.
--
-- A tenant enters the plan system when an operator puts them on one.
------------------------------------------------------------------------------

-- `organizations.plan_id` has been text since day one; point it at the
-- catalogue so the column stops being a free-text note. Kept nullable, because
-- "no plan" is the state every existing tenant is in and is not an error.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS plan_key text REFERENCES plans(key) ON DELETE SET NULL;

COMMENT ON COLUMN organizations.plan_key IS
  '0192. The named plan this org is on, or NULL for the pre-plan tenants. The '
  'RESOLVED entitlement state stays in enabled_modules (0072) - assigning a '
  'plan writes both, in one transaction. plan_id (text, day one) is superseded '
  'by this and is left alone rather than migrated: nothing ever wrote it.';
