-- 0197_capture_plans_and_billing.sql - the published price list, its four
-- meters, the add-on catalogue, and the payment layer behind them
-- (Build docs/47_PRICING_AND_COMPLIANCE.md; packages/shared/src/pricing.ts).
--
-- ── WHAT THIS ADDS TO 0192, AND WHY IT IS NOT A SECOND PLAN SYSTEM ──────────
--
-- 0192 built the plan layer: `plans`, `plan_entitlements`, `org_subscriptions`,
-- `usage_meters`, `plan_change_requests`, and one `Entitlements.check()` that
-- every route reads. That machinery is right and this migration does not
-- duplicate any of it. What 0192 priced was the API-only Insights tier, where
-- `price_minor` is NULL on every plan and the console says "Talk to us".
--
-- This is the other product - the one the handsets capture - and it has a real,
-- published price list in two currencies. So:
--
--   * `plans.family` splits the catalogue in two. One `check()`, one
--     subscription row per tenant, two rails. The `capture_` prefix on Starter
--     and Growth is not cosmetic: both names already existed in 0192.
--   * `plan_prices` holds what is actually charged, per plan per region. The
--     numbers in pricing.ts are the SEED, exactly as PLAN_SEED is for limits.
--   * `plan_addons` + `org_plan_addons` + `org_addon_grants` are the top-ups.
--   * `billing_orders` + `billing_webhook_events` are the payment layer.
--
-- ── THE FOUR METERS WERE ALREADY BUILT. THIS IS THE CATALOGUE OVER THEM ─────
--
-- Every limit on the price list is enforced today by a column on
-- `organizations` that predates this migration:
--
--   handsets             -> `devices` rows (the cap itself is new, see below)
--   transcription hours  -> `asr_monthly_minutes_budget` (0086), enforced in
--                           the worker pipeline against `usage_events`
--   audio retention      -> `retention_days` (0001), swept by the reaper
--   storage cap          -> `storage_quota_bytes` (doc 27), swept hourly
--
-- So "assigning a capture plan" resolves the plan into those columns, the same
-- way 0192's apply path resolves a plan into `enabled_modules`. That is the
-- whole reason this is a pricing decision rather than a research project: the
-- meters are measured, the enforcement exists, and what was missing was a
-- catalogue, an assignment and a way to be paid.
--
-- ── THE ONE THING THAT HAD TO BE FIXED FIRST ────────────────────────────────
--
-- `retention_days` governed EVERYTHING. When it expired the reaper deleted the
-- audio, the transcript, the AI analysis, and any dormant lead, deal and
-- contact with it. Wiring "60 days on Starter" to that column would quietly
-- delete a paying customer's CRM history - which is not a bug, it is a refund,
-- a reputation and possibly a compliance problem.
--
-- Retention is therefore two clocks from here on:
--
--   `retention_days`       the AUDIO clock. The plan lever, on the price list,
--                          deletes the recording FILE and nothing else.
--   `data_retention_days`  the full purge. Off the price list, defaults to 90
--                          days or longer, only ever changed per customer on
--                          request.
--
-- A customer at day 90 on Starter still has every transcript, lead and insight
-- and simply cannot replay the audio. `recordings.expired_at` is what makes
-- that state representable instead of a row pointing at a deleted object.
--
-- ── NO LIVE PAYMENT PROVIDER ────────────────────────────────────────────────
--
-- The project owner's decision, carried forward from 0192 and restated in the
-- price list: Razorpay goes in behind environment keys with no live calls
-- until the test keys arrive. `billing_orders.provider` defaults to 'manual'
-- and an order with no gateway configured settles by an operator marking it
-- paid after a manual invoice. Assigning a plan by hand is a perfectly good
-- way to sell the first twenty accounts, and it lets the tiers be proven
-- before collecting money for them is automated.
--
-- Razorpay is an INDIA gateway and will not settle UAE dirhams, which is why
-- `billing_orders.provider` is per order rather than per platform and why the
-- resolver refuses a non-INR order rather than sending one it cannot complete.

------------------------------------------------------------------------------
-- 1 ── The catalogue grows a family, and a fourth limit type
------------------------------------------------------------------------------

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS family text NOT NULL DEFAULT 'insights';

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_family_check;
ALTER TABLE plans ADD CONSTRAINT plans_family_check
  CHECK (family IN ('insights', 'capture'));

COMMENT ON COLUMN plans.family IS
  '0197. Which product line this plan sells. `capture` is the handset product '
  'on the published price list; `insights` is the API-only tier (0192). One '
  'catalogue holds both because there is one Entitlements.check() and one '
  'org_subscriptions row per tenant; the family is what stops a Compare-plans '
  'page offering a capture tenant the API tier''s Scale.';

-- `sweep` is the fourth limit type and the only one that deletes. See
-- packages/shared/src/entitlements.ts's EntitlementLimitType for why it is
-- named rather than folded into `window`: a window is a read-time floor that
-- an upgrade undoes, and a sweep is a day count a background job acts on.
-- Today there is exactly one, `audio_retention_days`, and it deletes the
-- recording file only.
ALTER TABLE plan_entitlements DROP CONSTRAINT IF EXISTS plan_entitlements_limit_type_check;
ALTER TABLE plan_entitlements ADD CONSTRAINT plan_entitlements_limit_type_check
  CHECK (limit_type IN ('hard', 'quota', 'window', 'sweep'));

------------------------------------------------------------------------------
-- 2 ── What a plan costs, per region
--
-- Catalogue data, like `plans` itself: no org_id, no RLS, `aura_app` revoked,
-- read on the admin pool. The same argument 0192 makes - one row for "Growth
-- in India", shared by every Indian tenant on Growth.
--
-- ── WHY THE ANNUAL FIGURE IS STORED AND THE MONTHLY ONE DERIVED ────────────
--
-- Every number on the published price list is "monthly, on annual billing".
-- Monthly billing is about 20% more, which is the convention in both markets
-- and what gives a customer a reason to commit for the year. Storing the
-- annual basis and deriving the monthly one (pricing.ts `monthlyFromAnnual`,
-- rounded to a whole major unit so the uplift yields ₹1,199 rather than
-- ₹1,198.80) means the two can never disagree - and the direction matters,
-- because deriving the annual price from the monthly one would make the
-- headline figure on the price list a rounding artefact.
--
-- ── `sellable` IS A LEGAL GATE, NOT A FEATURE FLAG ────────────────────────
--
-- Recording a call without the counterparty's consent is a CRIMINAL offence in
-- the UAE: Penal Code (Federal Decree-Law 31 of 2021) art. 431 criminalises
-- recording a telephone conversation without the victim's consent, and the
-- Cybercrime Law (34 of 2021) art. 44 carries AED 150,000-500,000 plus
-- imprisonment. An announcement is unilateral notice; the statutes require
-- consent. There is no workplace or commercial exception.
--
-- So the AED prices are seeded, correct, and `sellable = false` until
-- affirmative consent capture ships and counsel has signed off per tenant.
-- Section 6 below pins `consent_policy = 'prohibited'` for an AE tenant so the
-- handset cannot record even if a price somehow got charged - the handset must
-- never be the authority on whether it may record.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plan_prices (
  plan_id              uuid NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  region               text NOT NULL CHECK (region IN ('IN', 'AE')),
  currency             text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Minor units (paise, fils). Integers, never a float: a tax line reached by
  -- two routes has to agree to the last unit. See packages/shared/src/money.ts.
  annual_monthly_minor bigint NOT NULL CHECK (annual_monthly_minor >= 0),
  -- True for Enterprise, where the number is a floor that keeps the
  -- conversation serious rather than a description of what is included. The
  -- console renders "from ₹39,999" and offers no checkout.
  from_price           bool NOT NULL DEFAULT false,
  sellable             bool NOT NULL DEFAULT true,
  -- GST in India, VAT in the UAE, both ON TOP of the price. Basis points so no
  -- percentage is ever a float: 18% is 1800.
  tax_kind             text NOT NULL CHECK (tax_kind IN ('gst', 'vat')),
  tax_rate_bp          int  NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, region)
);

DO $$ BEGIN
  CREATE TRIGGER plan_prices_set_updated_at BEFORE UPDATE ON plan_prices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- 3 ── The add-on catalogue
--
-- Also catalogue data, also admin-pool only.
--
-- `kind` is the whole distinction. A `pack` is consumed and expires with the
-- period it was bought in - hour packs, which is what makes a top-up a one-off
-- purchase rather than a price change. A `recurring` add-on rides on the
-- subscription and raises a ceiling for as long as it is held.
--
-- Prices are set so that buying past a limit repeatedly costs more than moving
-- up a tier: the hour packs work out at ₹80 and ₹70 an hour against an
-- effective in-plan rate of ₹60 on Starter. That ordering is the point. A
-- customer who tops up every month is paying a premium for the privilege and
-- can see that upgrading is cheaper; margin on a top-up is still around 65%,
-- so the premium is not punitive, it is just the wrong way to buy a lot of
-- hours.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plan_addons (
  key             text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('pack', 'recurring')),
  -- Which entitlement one unit raises. Not a FK and not a CHECK listing the
  -- keys: the vocabulary lives in packages/shared/src/entitlements.ts, a
  -- migration cannot import TypeScript, and pricing.test.ts is what checks the
  -- two agree. Same call 0192 makes for `plan_entitlements.entitlement_key`.
  entitlement_key text NOT NULL,
  grant_amount    int  NOT NULL CHECK (grant_amount > 0),
  max_units       int  NOT NULL CHECK (max_units > 0),
  active          bool NOT NULL DEFAULT true,
  sort            int  NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_addon_prices (
  addon_key   text NOT NULL REFERENCES plan_addons(key) ON DELETE CASCADE,
  region      text NOT NULL CHECK (region IN ('IN', 'AE')),
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (addon_key, region)
);

DO $$ BEGIN
  CREATE TRIGGER plan_addons_set_updated_at BEFORE UPDATE ON plan_addons
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER plan_addon_prices_set_updated_at BEFORE UPDATE ON plan_addon_prices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Admin pool only, for all four catalogue tables. REVOKE before any GRANT -
-- the 0089 order - because a GRANT-only migration narrows nothing: the
-- `marketing` schema's public web role kept INSERT for exactly this reason.
DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plan_prices', 'plan_addons', 'plan_addon_prices'] LOOP
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
-- 4 ── Per-tenant add-on state
--
-- Two tables, because a pack and a recurring add-on are different objects and
-- collapsing them would make "how many hours does this tenant have this month"
-- a query with a date range in it.
--
-- `org_plan_addons` is a HOLDING: one row per org per recurring add-on, with a
-- unit count. Raising a ceiling is an UPDATE, not an append, so there is never
-- a question of which row is current - the same argument 0192 makes for
-- org_subscriptions being one row rather than a history.
--
-- `org_addon_grants` is a LEDGER: one row per pack bought, naming the period it
-- credits. Append-only in practice and never updated, because "how many hours
-- were bought for 2026-10" has to stay answerable after the month ends - a
-- refund or a dispute is read from here. The period is the same text bucket
-- `usage_meters` uses ('2026-10'), derived from the UTC calendar month.
--
-- ── THE ENFORCEMENT WINDOW IS THE UTC CALENDAR MONTH, SAID OUT LOUD ────────
--
-- The platform meters transcription over `date_trunc('month', now(), 'UTC')`,
-- not the customer's own time zone and not their billing date. A customer in
-- Dubai or Singapore sees their allowance reset partway through their evening,
-- and a customer whose contract starts on the 15th still gets a reset on the
-- 1st. That is a known, accepted divergence from a billing-date window: the
-- price list says "per calendar month" and means it, and aligning the two is
-- recorded as an open decision rather than silently half-done. A grant written
-- here therefore uses the same UTC bucket as the meter it credits, because a
-- grant in one window and a meter in another is how a customer pays for hours
-- they cannot spend.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_plan_addons (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  addon_key  text NOT NULL REFERENCES plan_addons(key),
  units      int  NOT NULL DEFAULT 0 CHECK (units >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, addon_key)
);

CREATE TABLE IF NOT EXISTS org_addon_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  addon_key   text NOT NULL REFERENCES plan_addons(key),
  -- '2026-10'. The UTC calendar month this credit may be spent in, matching
  -- `usage_meters.period`.
  period      text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  units       int  NOT NULL CHECK (units > 0),
  -- What the grant is worth in the entitlement's own unit (hours, handsets,
  -- GiB, days), resolved at purchase time from `plan_addons.grant_amount`.
  -- Denormalised deliberately: an operator who later edits the catalogue must
  -- not retroactively change what a customer already paid for.
  amount      int  NOT NULL CHECK (amount > 0),
  -- The order that paid for it, or NULL for a grant an operator issued by hand
  -- (a goodwill credit, a migration from a manual invoice).
  order_id    uuid,
  issued_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_addon_grants_period
  ON org_addon_grants (org_id, addon_key, period);

------------------------------------------------------------------------------
-- 5 ── The payment layer
--
-- ── ONE TABLE FOR THE INTENT, ONE FOR THE DELIVERY ────────────────────────
--
-- `billing_orders` is what the customer agreed to buy, with the total frozen
-- at the moment they agreed. Freezing it is the point: a price an operator
-- edits tomorrow must not change what somebody is charged for a checkout they
-- started today, and a gateway that reports back "paid 7079" has to be
-- checkable against a number that has not moved.
--
-- `billing_webhook_events` is the idempotency key for a provider delivery.
-- Razorpay retries, so the same `payment.captured` arrives more than once; a
-- unique index on the provider's own event id is what keeps the second
-- delivery from granting a second month. `payment_webhook_events` (0060) does
-- the same job for the TENANT's own gateway, collecting from THEIR customers -
-- a different table because this is the platform collecting from the tenant,
-- and mixing the two would make a tenant's invoice payment indistinguishable
-- from their subscription payment.
--
-- ── NOTHING HERE CHARGES ANYBODY ──────────────────────────────────────────
--
-- Creating an order never moves money and never changes a plan. A plan changes
-- in exactly two places: an operator applying it, or a verified webhook
-- marking the order paid. `status` starts at 'pending' and the only path to
-- 'paid' is through a signature this platform checked.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('subscription', 'addon')),
  -- For a subscription order. NULL for an add-on purchase.
  plan_id           uuid REFERENCES plans(id),
  billing_period    text CHECK (billing_period IS NULL OR billing_period IN ('annual', 'monthly')),
  -- For an add-on order. NULL for a subscription.
  addon_key         text REFERENCES plan_addons(key),
  addon_units       int CHECK (addon_units IS NULL OR addon_units > 0),
  region            text NOT NULL CHECK (region IN ('IN', 'AE')),
  currency          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor    bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor         bigint NOT NULL CHECK (tax_minor >= 0),
  total_minor       bigint NOT NULL CHECK (total_minor >= 0),
  tax_kind          text NOT NULL CHECK (tax_kind IN ('gst', 'vat')),
  tax_rate_bp       int  NOT NULL CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  -- The quote, as the owner saw it. Kept so a dispute can be answered with the
  -- lines rather than re-derived from a catalogue that has since changed.
  lines             jsonb NOT NULL DEFAULT '[]',
  -- 'manual' is the default and the only one that works today: Razorpay is
  -- wired behind environment keys with no live calls until the test keys
  -- arrive, and it cannot settle AED at all. A 'manual' order is settled by an
  -- operator marking it paid after a manual invoice.
  provider          text NOT NULL DEFAULT 'manual'
                      CHECK (provider IN ('manual', 'razorpay')),
  provider_order_id text,
  provider_payment_id text,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'refunded')),
  -- Set when a checkout is auto-initiated rather than clicked, so an auto
  -- top-up can be counted against the customer's own monthly ceiling.
  auto              bool NOT NULL DEFAULT false,
  requested_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at           timestamptz,
  settled_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- A subscription order names a plan, an add-on order names an add-on, and
  -- neither names both. Without this an order could be ambiguous about what it
  -- grants, and the webhook that applies it would have to guess.
  CONSTRAINT billing_orders_target CHECK (
    (kind = 'subscription' AND plan_id IS NOT NULL AND billing_period IS NOT NULL
       AND addon_key IS NULL AND addon_units IS NULL)
    OR
    (kind = 'addon' AND addon_key IS NOT NULL AND addon_units IS NOT NULL
       AND plan_id IS NULL)
  ),
  -- The total has to be the sum. A rounding bug that reached the gateway would
  -- otherwise be invisible until a reconciliation months later.
  CONSTRAINT billing_orders_total_adds_up CHECK (total_minor = subtotal_minor + tax_minor),
  -- A paid order must say when and by what. A row that claims 'paid' with no
  -- timestamp cannot be reconciled and cannot be refunded.
  CONSTRAINT billing_orders_paid_complete CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS billing_orders_org
  ON billing_orders (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_orders_open
  ON billing_orders (status, created_at DESC) WHERE status = 'pending';
-- One order per gateway order id, so a replayed webhook finds the same row.
-- Partial, because 'manual' orders have no provider id and there are many.
CREATE UNIQUE INDEX IF NOT EXISTS billing_orders_provider_order
  ON billing_orders (provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL CHECK (provider IN ('razorpay')),
  -- The provider's own event id. UNIQUE, which is the entire mechanism: a
  -- retried delivery loses the INSERT and is acknowledged without being
  -- applied twice.
  event_id    text NOT NULL,
  event_type  text,
  order_id    uuid REFERENCES billing_orders(id) ON DELETE SET NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz,
  error       text,
  UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS billing_webhook_events_recent
  ON billing_webhook_events (received_at DESC);

-- No org_id. A webhook arrives before anything is known about which tenant it
-- belongs to - the order id in the payload is what resolves that - which is the
-- same reason `payment_webhook_events` (0060) carries none and is already in
-- verify-rls's NON_TENANT_TABLES. Admin pool only.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON billing_webhook_events FROM %I', api_role);
    END IF;
  END LOOP;
  EXECUTE 'REVOKE ALL ON billing_webhook_events FROM PUBLIC';
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
    EXECUTE 'REVOKE ALL ON billing_webhook_events FROM aura_app';
  END IF;
END $$;

------------------------------------------------------------------------------
-- 6 ── The subscription grows a cadence, a region and an auto top-up ceiling
------------------------------------------------------------------------------

ALTER TABLE org_subscriptions
  ADD COLUMN IF NOT EXISTS billing_period text NOT NULL DEFAULT 'annual',
  ADD COLUMN IF NOT EXISTS auto_topup_enabled bool NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_topup_addon_key text REFERENCES plan_addons(key),
  ADD COLUMN IF NOT EXISTS auto_topup_cap_minor bigint;

ALTER TABLE org_subscriptions DROP CONSTRAINT IF EXISTS org_subscriptions_billing_period_check;
ALTER TABLE org_subscriptions ADD CONSTRAINT org_subscriptions_billing_period_check
  CHECK (billing_period IN ('annual', 'monthly'));

-- Auto top-up is OPT-IN and takes a customer-set monthly ceiling. An
-- auto-charge that renews itself without a cap is how a surprise bill becomes a
-- chargeback, and the ceiling costs nothing to offer - so the CHECK makes it
-- impossible to switch on without one, rather than leaving the API to remember.
ALTER TABLE org_subscriptions DROP CONSTRAINT IF EXISTS org_subscriptions_auto_topup_capped;
ALTER TABLE org_subscriptions ADD CONSTRAINT org_subscriptions_auto_topup_capped CHECK (
  NOT auto_topup_enabled
  OR (auto_topup_addon_key IS NOT NULL AND auto_topup_cap_minor IS NOT NULL
      AND auto_topup_cap_minor > 0)
);

-- `org_addon_grants.order_id` points at `billing_orders`, declared here rather
-- than in section 4 because `billing_orders` is created in section 5. ON
-- DELETE SET NULL: deleting an order must never silently revoke hours a
-- customer already spent.
ALTER TABLE org_addon_grants DROP CONSTRAINT IF EXISTS org_addon_grants_order_fk;
ALTER TABLE org_addon_grants ADD CONSTRAINT org_addon_grants_order_fk
  FOREIGN KEY (order_id) REFERENCES billing_orders(id) ON DELETE SET NULL;

------------------------------------------------------------------------------
-- 7 ── The tenant: a billing region, and retention split in two
------------------------------------------------------------------------------

-- ── WHY BILLING REGION IS ITS OWN COLUMN ───────────────────────────────────
--
-- `organizations.region` is an AWS region ('ap-south-1'), and
-- `org_business_profile.country` is what the TENANT declares for its own
-- invoices - a field the tenant can edit on its own settings screen.
--
-- Neither can carry this. The compliance position requires `consent_policy` to
-- be "enforced server-side, pinned to the tenant's workspace country", and a
-- country the tenant types is not a pin: a UAE tenant that could set its own
-- country to 'IN' would unlock recording for itself, which is the single thing
-- this gate exists to prevent. So `billing_region` is operator-set, it decides
-- which price list applies, which tax regime, which gateway, and whether the
-- handset may record at all.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS billing_region text NOT NULL DEFAULT 'IN';

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_billing_region_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_billing_region_check
  CHECK (billing_region IN ('IN', 'AE'));

COMMENT ON COLUMN organizations.billing_region IS
  '0197. OPERATOR-SET. Which price list, tax regime and payment gateway apply, '
  'and - via the consent gate - whether this tenant''s handsets may record at '
  'all. Deliberately NOT org_business_profile.country, which the tenant edits '
  'itself: a country a tenant can type cannot pin a criminal-law gate.';

-- The counsel opinion that would open the UAE. NULL on every tenant and set by
-- hand, per tenant, by an operator who holds the written opinion - never by a
-- migration and never by a tenant. Until it is set, an AE tenant records
-- nothing. See the price list's compliance position: the UAE is blocked on
-- law, not engineering, and "most of this is one feature - real consent
-- capture - plus paperwork".
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS consent_cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_cleared_note text;

COMMENT ON COLUMN organizations.consent_cleared_at IS
  '0197. When an operator recorded that this tenant holds a counsel opinion '
  'permitting recording in its billing region. Required before an AE tenant '
  'may leave consent_policy = ''prohibited''. Set by hand, never by a plan.';

-- ── THE TWO CLOCKS ────────────────────────────────────────────────────────
--
-- `retention_days` keeps its name and becomes the AUDIO clock, because that is
-- what it already means to every customer-facing surface: the account page, the
-- plan-usage meter and the price list all show it as "audio kept for". What
-- changes is that the reaper no longer purges anything else on it.
--
-- `data_retention_days` is the full purge - transcripts, analysis, dormant
-- leads, deals and contacts. Backfilled to GREATEST(retention_days, 90) so no
-- existing tenant's data window SHRINKS as a result of this migration: a
-- tenant on 365 days keeps 365, and a tenant on 30 moves up to 90 rather than
-- having their CRM swept on the audio clock.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS data_retention_days int;

UPDATE organizations
   SET data_retention_days = GREATEST(retention_days, 90)
 WHERE data_retention_days IS NULL;

ALTER TABLE organizations
  ALTER COLUMN data_retention_days SET DEFAULT 90,
  ALTER COLUMN data_retention_days SET NOT NULL;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_data_retention_floor;
-- 30 days is the floor. A tenant asking for less is asking us to destroy their
-- own CRM, which is a conversation and not a setting.
ALTER TABLE organizations ADD CONSTRAINT organizations_data_retention_floor
  CHECK (data_retention_days >= 30);

COMMENT ON COLUMN organizations.retention_days IS
  '0197 (was 0001). The AUDIO clock: days a RECORDING FILE is kept before the '
  'reaper deletes it. This is the plan lever and the number on the price list. '
  'It deletes the file and nothing else - transcript, analysis and every CRM '
  'record survive, and the call reads "recording expired".';

COMMENT ON COLUMN organizations.data_retention_days IS
  '0197. The FULL PURGE: transcripts, AI output, and dormant leads, deals and '
  'contacts. Off the price list, defaults to 90 days or the audio window, '
  'whichever is longer, and only ever changed per customer on request. Until '
  '0197 a single column governed both, and wiring a plan''s 60-day audio '
  'window to it would have deleted a paying customer''s CRM history.';

-- ── THE DATA CLOCK IS NEVER SHORTER THAN THE AUDIO CLOCK ───────────────────
--
-- A column DEFAULT cannot reference another column, so the `90` above is a
-- constant - and a tenant created with a 365-day audio window would take it,
-- landing with audio kept for a year and its own transcripts purged at 90
-- days. That is backwards twice over: the customer is told they have a year,
-- and a recording would outlive the transcript that describes it.
--
-- Caught by apps/api/verify-capture-plans.cjs against a real database, which
-- is exactly the class of defect no amount of typechecking finds: the
-- backfill above is correct for every org that EXISTED, and wrong for every
-- org created afterwards.
--
-- A TRIGGER rather than a CHECK, because a CHECK would REFUSE the write. An
-- operator creating a tenant with a long audio window has not made a mistake
-- and should not be given an error; the data window is simply raised to meet
-- it. `applyPlanMeters`'s own GREATEST() is now belt-and-braces over this
-- rather than the only thing holding the invariant.
CREATE OR REPLACE FUNCTION enforce_data_retention_floor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.data_retention_days IS NULL OR NEW.data_retention_days < NEW.retention_days THEN
    NEW.data_retention_days := GREATEST(NEW.retention_days, 90);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS organizations_data_retention_floor ON organizations;
CREATE TRIGGER organizations_data_retention_floor
  BEFORE INSERT OR UPDATE OF retention_days, data_retention_days ON organizations
  FOR EACH ROW EXECUTE FUNCTION enforce_data_retention_floor();

-- Re-run over everything the backfill already touched, so the invariant holds
-- from this migration onward rather than from the next write to each row.
UPDATE organizations
   SET data_retention_days = GREATEST(retention_days, 90)
 WHERE data_retention_days < retention_days;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM organizations WHERE data_retention_days < retention_days;
  IF n > 0 THEN
    RAISE EXCEPTION '0197: % org(s) keep audio longer than their own records', n;
  END IF;
END $$;

-- What makes "the audio is gone but the call is not" representable.
--
-- The row is KEPT, with `s3_key` intact, rather than deleted: the key is the
-- audit trail of what was removed and from where, and a reader asking why a
-- player is missing gets an answer instead of an absence. `bytes` is left
-- alone - the storage sweep excludes expired rows by this column instead, so
-- "how much did this tenant ever store" stays answerable.
ALTER TABLE recordings
  ADD COLUMN IF NOT EXISTS expired_at timestamptz;

CREATE INDEX IF NOT EXISTS recordings_live
  ON recordings (org_id, uploaded_at)
  WHERE uploaded_at IS NOT NULL AND expired_at IS NULL;

COMMENT ON COLUMN recordings.expired_at IS
  '0197. When the audio file was deleted by the audio-retention sweep. The row '
  'and its s3_key stay as the record of what was removed; every "is there '
  'audio to play" test (recording-sql.ts HAS_RECORDING, the storage sweep, the '
  'presign route) requires this to be NULL.';

------------------------------------------------------------------------------
-- 8 ── RLS for the four org-scoped tables
--
-- The partner_wall block is not optional. 0163's enumeration could only wall
-- the tables that existed when it ran, so every org-scoped table added after it
-- must create its own RESTRICTIVE policy - without one a channel partner
-- inside the portal reads the table, and `org_isolation` does not help because
-- a partner principal is inside the org. verify-rls.js fails the deploy for a
-- table that forgets it.
------------------------------------------------------------------------------

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'org_plan_addons', 'org_addon_grants', 'billing_orders'
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
    -- re-run would leave the later walls uncreated while reporting success.
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
-- while looking, in `pg_policies`, exactly like the real thing.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['org_plan_addons', 'org_addon_grants', 'billing_orders']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
        AND policyname = 'partner_wall' AND permissive = 'RESTRICTIVE'
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0197: partner_wall missing or not RESTRICTIVE on: %', missing;
  END IF;
END $$;

------------------------------------------------------------------------------
-- 9 ── Seed: the four capture plans
------------------------------------------------------------------------------

INSERT INTO plans (key, name, blurb, family, sort) VALUES
  ('record', 'Record',
   'Every call recorded, searchable and playable. No transcription.', 'capture', 1),
  ('capture_starter', 'Starter',
   '100 transcription hours a month, with lead extraction and sentiment.', 'capture', 2),
  ('capture_growth', 'Growth',
   'Four handsets, 200 hours, and who talked how much on every call.', 'capture', 3),
  ('capture_enterprise', 'Enterprise',
   'Ten handsets or more, with every meter and the ASR provider negotiated.', 'capture', 4)
ON CONFLICT (key) DO UPDATE SET
  name   = EXCLUDED.name,
  blurb  = EXCLUDED.blurb,
  family = EXCLUDED.family,
  sort   = EXCLUDED.sort;

-- The Insights plans keep their family, said explicitly rather than left to the
-- column default: a re-run of this migration after someone has edited the
-- catalogue should not silently reclassify them.
UPDATE plans SET family = 'insights'
 WHERE key IN ('starter', 'growth', 'scale', 'platform') AND family <> 'insights';

------------------------------------------------------------------------------
-- 10 ── Seed: what each capture plan costs
--
-- Monthly, on annual billing, ex-tax, in minor units. India adds 18% GST and
-- the UAE 5% VAT, both on top. The AED column is priced and NOT sellable.
--
-- GROWTH IS ₹19,999 FOR 200 HOURS. Settled by the project owner, 2026-10-12.
-- Growth is the only tier that sells speaker separation, which means Sarvam
-- diarized at ₹45 an audio-hour - ₹10,800 at the 200-hour cap. At the price
-- list's original ₹14,999 that left 28% margin, which is not a tier to sell.
-- The two ways out gave identical 46% margin at the cap: raise the price and
-- keep 200 hours, or hold ₹14,999 and cut to 150. The price was raised.
--
-- The AED figure stays at the published AED 899: that region is not sellable,
-- so there is nothing to re-derive yet, and inventing a number the price list
-- does not carry would be worse than leaving the ratio to be decided when the
-- market opens.
------------------------------------------------------------------------------

-- PLAN_PRICES
INSERT INTO plan_prices
  (plan_id, region, currency, annual_monthly_minor, from_price, sellable, tax_kind, tax_rate_bp)
SELECT p.id, v.region, v.currency, v.minor, v.from_price, v.sellable, v.tax_kind, v.tax_rate_bp
  FROM (VALUES
    ('record',             'IN', 'INR',    99900::bigint, false, true,  'gst', 1800),
    ('record',             'AE', 'AED',     9900::bigint, false, false, 'vat',  500),
    ('capture_starter',    'IN', 'INR',   599900::bigint, false, true,  'gst', 1800),
    ('capture_starter',    'AE', 'AED',    39900::bigint, false, false, 'vat',  500),
    ('capture_growth',     'IN', 'INR',  1999900::bigint, false, true,  'gst', 1800),
    ('capture_growth',     'AE', 'AED',    89900::bigint, false, false, 'vat',  500),
    ('capture_enterprise', 'IN', 'INR',  3999900::bigint, true,  true,  'gst', 1800),
    ('capture_enterprise', 'AE', 'AED',   249900::bigint, true,  false, 'vat',  500)
  ) AS v(plan_key, region, currency, minor, from_price, sellable, tax_kind, tax_rate_bp)
  JOIN plans p ON p.key = v.plan_key
ON CONFLICT (plan_id, region) DO UPDATE SET
  currency             = EXCLUDED.currency,
  annual_monthly_minor = EXCLUDED.annual_monthly_minor,
  from_price           = EXCLUDED.from_price,
  sellable             = EXCLUDED.sellable,
  tax_kind             = EXCLUDED.tax_kind,
  tax_rate_bp          = EXCLUDED.tax_rate_bp,
  updated_at           = now();
-- PLAN_PRICES_END

------------------------------------------------------------------------------
-- 11 ── Seed: the add-on catalogue
------------------------------------------------------------------------------

-- PLAN_ADDONS
INSERT INTO plan_addons (key, name, kind, entitlement_key, grant_amount, max_units, sort) VALUES
  ('topup_hours_25',      '25 transcription hours',             'pack',
     'transcription_hours_monthly',  25, 40, 1),
  ('topup_hours_100',     '100 transcription hours',            'pack',
     'transcription_hours_monthly', 100, 20, 2),
  ('extra_handset',       'Extra handset',                      'recurring',
     'paired_handsets',               1, 50, 3),
  ('extra_storage_5gb',   'Extra 5 GB of storage',              'recurring',
     'storage_cap_gb',                5, 40, 4),
  ('extra_retention_30d', 'Extra 30 days of audio retention',   'recurring',
     'audio_retention_days',         30, 12, 5)
ON CONFLICT (key) DO UPDATE SET
  name            = EXCLUDED.name,
  kind            = EXCLUDED.kind,
  entitlement_key = EXCLUDED.entitlement_key,
  grant_amount    = EXCLUDED.grant_amount,
  max_units       = EXCLUDED.max_units,
  sort            = EXCLUDED.sort,
  updated_at      = now();

INSERT INTO plan_addon_prices (addon_key, region, currency, price_minor) VALUES
  ('topup_hours_25',      'IN', 'INR', 199900),
  ('topup_hours_25',      'AE', 'AED',   8900),
  ('topup_hours_100',     'IN', 'INR', 699900),
  ('topup_hours_100',     'AE', 'AED',  29900),
  ('extra_handset',       'IN', 'INR', 149900),
  ('extra_handset',       'AE', 'AED',   9900),
  ('extra_storage_5gb',   'IN', 'INR',  49900),
  ('extra_storage_5gb',   'AE', 'AED',   2900),
  ('extra_retention_30d', 'IN', 'INR',  79900),
  ('extra_retention_30d', 'AE', 'AED',   4900)
ON CONFLICT (addon_key, region) DO UPDATE SET
  currency    = EXCLUDED.currency,
  price_minor = EXCLUDED.price_minor,
  updated_at  = now();
-- PLAN_ADDONS_END

------------------------------------------------------------------------------
-- 12 ── Seed: every plan's entitlements, including the four new keys
--
-- Written as one JSON document per plan, with a marker per plan, so that
-- pricing.test.ts can parse this file and compare it to PLAN_SEED key by key.
-- Eight blobs a machine checks beat 216 rows a reviewer counts by eye - the
-- same argument 0192 makes for its four.
--
-- EVERY PLAN CARRIES EVERY KEY, including the four this migration adds and
-- including the keys a plan does not get. A missing row would make `check()`
-- decide between "unlimited" and "denied" from an absence, and those two must
-- never be the same value. That is why the Insights plans are restated here
-- rather than only the capture ones: they need the four new keys too.
--
-- NOTHING IS METERED PER SEAT on a capture plan. `active_telecallers` and
-- `dashboard_logins` are null on all four, deliberately and permanently: the
-- cost of running this product follows audio, not logins, and the product wants
-- MORE people inside the CRM reading what the calls revealed. Seat pricing
-- would overcharge the manager who only reads reports and undercharge the
-- telecaller on the phone all day.
------------------------------------------------------------------------------

-- ENTITLEMENT_LIMIT_TYPES_0197
WITH limit_types(entitlement_key, limit_type) AS (VALUES
  ('active_telecallers',          'quota'),
  ('dashboard_logins',            'quota'),
  ('ingest_events_monthly',       'quota'),
  ('api_rate_per_min',            'quota'),
  ('history_retention',           'window'),
  ('selectable_kpis',             'quota'),
  ('custom_kpis',                 'hard'),
  ('team_structure',              'hard'),
  ('export_formats',              'hard'),
  ('scheduled_reports',           'hard'),
  ('threshold_alerts',            'hard'),
  ('outgoing_webhooks',           'hard'),
  ('import_center',               'hard'),
  ('manual_quality_scoring',      'hard'),
  ('revenue_summary',             'hard'),
  ('audit_log_window',            'window'),
  ('sso',                         'hard'),
  ('ip_allowlist',                'hard'),
  ('white_label',                 'hard'),
  ('handset_pairing',             'hard'),
  ('paired_handsets',             'quota'),
  ('crm',                         'hard'),
  ('ai_features',                 'hard'),
  ('transcription_hours_monthly', 'quota'),
  ('audio_retention_days',        'sweep'),
  ('storage_cap_gb',              'quota'),
  ('speaker_separation',          'hard')
),
-- PLAN_SEED_STARTER
seed(plan_key, entitlements) AS (VALUES
  ('starter', '{
    "active_telecallers":          {"limit": 10},
    "dashboard_logins":            {"limit": 3},
    "ingest_events_monthly":       {"limit": 50000, "per": "month"},
    "api_rate_per_min":            {"limit": 60, "per": "minute"},
    "history_retention":           {"months": 3},
    "selectable_kpis":             {"limit": 4},
    "custom_kpis":                 {"enabled": false},
    "team_structure":              {"enabled": true, "variant": "flat"},
    "export_formats":              {"enabled": true, "variant": "csv_limited"},
    "scheduled_reports":           {"enabled": false},
    "threshold_alerts":            {"enabled": false},
    "outgoing_webhooks":           {"enabled": false},
    "import_center":               {"enabled": true, "variant": "single_template"},
    "manual_quality_scoring":      {"enabled": false},
    "revenue_summary":             {"enabled": false},
    "audit_log_window":            {"days": 30},
    "sso":                         {"enabled": false},
    "ip_allowlist":                {"enabled": false},
    "white_label":                 {"enabled": false},
    "handset_pairing":             {"enabled": true},
    "paired_handsets":             {"limit": 10},
    "crm":                         {"enabled": false},
    "ai_features":                 {"enabled": false},
    "transcription_hours_monthly": {"limit": 0, "per": "month"},
    "audio_retention_days":        {"days": 30},
    "storage_cap_gb":              {"limit": 5},
    "speaker_separation":          {"enabled": false}
  }'::jsonb),
  -- PLAN_SEED_GROWTH
  ('growth', '{
    "active_telecallers":          {"limit": 50},
    "dashboard_logins":            {"limit": 10},
    "ingest_events_monthly":       {"limit": 500000, "per": "month"},
    "api_rate_per_min":            {"limit": 300, "per": "minute"},
    "history_retention":           {"months": 12},
    "selectable_kpis":             {"limit": 6},
    "custom_kpis":                 {"enabled": false},
    "team_structure":              {"enabled": true, "variant": "teams"},
    "export_formats":              {"enabled": true, "variant": "csv_excel"},
    "scheduled_reports":           {"enabled": true, "variant": "weekly_monthly"},
    "threshold_alerts":            {"enabled": true, "variant": "email"},
    "outgoing_webhooks":           {"enabled": true},
    "import_center":               {"enabled": true, "variant": "saved_mappings"},
    "manual_quality_scoring":      {"enabled": true},
    "revenue_summary":             {"enabled": true, "variant": "basic"},
    "audit_log_window":            {"months": 12},
    "sso":                         {"enabled": false},
    "ip_allowlist":                {"enabled": false},
    "white_label":                 {"enabled": false},
    "handset_pairing":             {"enabled": true},
    "paired_handsets":             {"limit": 50},
    "crm":                         {"enabled": false},
    "ai_features":                 {"enabled": false},
    "transcription_hours_monthly": {"limit": 0, "per": "month"},
    "audio_retention_days":        {"days": 60},
    "storage_cap_gb":              {"limit": 15},
    "speaker_separation":          {"enabled": false}
  }'::jsonb),
  -- PLAN_SEED_SCALE
  ('scale', '{
    "active_telecallers":          {"limit": 200},
    "dashboard_logins":            {"limit": 50},
    "ingest_events_monthly":       {"limit": 5000000, "per": "month"},
    "api_rate_per_min":            {"limit": 1500, "per": "minute"},
    "history_retention":           {"months": 36},
    "selectable_kpis":             {"limit": 6},
    "custom_kpis":                 {"enabled": true},
    "team_structure":              {"enabled": true, "variant": "org_chart"},
    "export_formats":              {"enabled": true, "variant": "csv_excel_pdf"},
    "scheduled_reports":           {"enabled": true, "variant": "unlimited_branded"},
    "threshold_alerts":            {"enabled": true, "variant": "email_whatsapp_escalation"},
    "outgoing_webhooks":           {"enabled": true},
    "import_center":               {"enabled": true, "variant": "advanced"},
    "manual_quality_scoring":      {"enabled": true},
    "revenue_summary":             {"enabled": true, "variant": "full"},
    "audit_log_window":            {"months": null},
    "sso":                         {"enabled": true},
    "ip_allowlist":                {"enabled": true},
    "white_label":                 {"enabled": true},
    "handset_pairing":             {"enabled": true},
    "paired_handsets":             {"limit": 200},
    "crm":                         {"enabled": false},
    "ai_features":                 {"enabled": false},
    "transcription_hours_monthly": {"limit": 0, "per": "month"},
    "audio_retention_days":        {"days": 90},
    "storage_cap_gb":              {"limit": 50},
    "speaker_separation":          {"enabled": false}
  }'::jsonb),
  -- PLAN_SEED_PLATFORM
  ('platform', '{
    "active_telecallers":          {"limit": null},
    "dashboard_logins":            {"limit": null},
    "ingest_events_monthly":       {"limit": null, "per": "month"},
    "api_rate_per_min":            {"limit": null, "per": "minute"},
    "history_retention":           {"months": null},
    "selectable_kpis":             {"limit": 6},
    "custom_kpis":                 {"enabled": true},
    "team_structure":              {"enabled": true, "variant": "org_chart"},
    "export_formats":              {"enabled": true, "variant": "csv_excel_pdf"},
    "scheduled_reports":           {"enabled": true, "variant": "unlimited_branded"},
    "threshold_alerts":            {"enabled": true, "variant": "email_whatsapp_escalation"},
    "outgoing_webhooks":           {"enabled": true},
    "import_center":               {"enabled": true, "variant": "advanced"},
    "manual_quality_scoring":      {"enabled": true},
    "revenue_summary":             {"enabled": true, "variant": "full"},
    "audit_log_window":            {"months": null},
    "sso":                         {"enabled": true},
    "ip_allowlist":                {"enabled": true},
    "white_label":                 {"enabled": true},
    "handset_pairing":             {"enabled": true},
    "paired_handsets":             {"limit": null},
    "crm":                         {"enabled": true},
    "ai_features":                 {"enabled": true},
    "transcription_hours_monthly": {"limit": null, "per": "month"},
    "audio_retention_days":        {"days": 180},
    "storage_cap_gb":              {"limit": null},
    "speaker_separation":          {"enabled": true}
  }'::jsonb),
  -- PLAN_SEED_RECORD
  ('record', '{
    "active_telecallers":          {"limit": null},
    "dashboard_logins":            {"limit": null},
    "ingest_events_monthly":       {"limit": 0, "per": "month"},
    "api_rate_per_min":            {"limit": 60, "per": "minute"},
    "history_retention":           {"months": null},
    "selectable_kpis":             {"limit": 6},
    "custom_kpis":                 {"enabled": false},
    "team_structure":              {"enabled": true, "variant": "flat"},
    "export_formats":              {"enabled": true, "variant": "csv_limited"},
    "scheduled_reports":           {"enabled": false},
    "threshold_alerts":            {"enabled": false},
    "outgoing_webhooks":           {"enabled": false},
    "import_center":               {"enabled": true, "variant": "single_template"},
    "manual_quality_scoring":      {"enabled": false},
    "revenue_summary":             {"enabled": false},
    "audit_log_window":            {"days": 30},
    "sso":                         {"enabled": false},
    "ip_allowlist":                {"enabled": false},
    "white_label":                 {"enabled": false},
    "handset_pairing":             {"enabled": true},
    "paired_handsets":             {"limit": 2},
    "crm":                         {"enabled": true},
    "ai_features":                 {"enabled": false},
    "transcription_hours_monthly": {"limit": 0, "per": "month"},
    "audio_retention_days":        {"days": 30},
    "storage_cap_gb":              {"limit": 5},
    "speaker_separation":          {"enabled": false}
  }'::jsonb),
  -- PLAN_SEED_CAPTURE_STARTER
  ('capture_starter', '{
    "active_telecallers":          {"limit": null},
    "dashboard_logins":            {"limit": null},
    "ingest_events_monthly":       {"limit": 0, "per": "month"},
    "api_rate_per_min":            {"limit": 60, "per": "minute"},
    "history_retention":           {"months": null},
    "selectable_kpis":             {"limit": 6},
    "custom_kpis":                 {"enabled": false},
    "team_structure":              {"enabled": true, "variant": "teams"},
    "export_formats":              {"enabled": true, "variant": "csv_excel"},
    "scheduled_reports":           {"enabled": true, "variant": "weekly_monthly"},
    "threshold_alerts":            {"enabled": true, "variant": "email"},
    "outgoing_webhooks":           {"enabled": false},
    "import_center":               {"enabled": true, "variant": "saved_mappings"},
    "manual_quality_scoring":      {"enabled": true},
    "revenue_summary":             {"enabled": true, "variant": "basic"},
    "audit_log_window":            {"months": 12},
    "sso":                         {"enabled": false},
    "ip_allowlist":                {"enabled": false},
    "white_label":                 {"enabled": false},
    "handset_pairing":             {"enabled": true},
    "paired_handsets":             {"limit": 2},
    "crm":                         {"enabled": true},
    "ai_features":                 {"enabled": true},
    "transcription_hours_monthly": {"limit": 100, "per": "month"},
    "audio_retention_days":        {"days": 60},
    "storage_cap_gb":              {"limit": 5},
    "speaker_separation":          {"enabled": false}
  }'::jsonb),
  -- PLAN_SEED_CAPTURE_GROWTH
  ('capture_growth', '{
    "active_telecallers":          {"limit": null},
    "dashboard_logins":            {"limit": null},
    "ingest_events_monthly":       {"limit": 0, "per": "month"},
    "api_rate_per_min":            {"limit": 300, "per": "minute"},
    "history_retention":           {"months": null},
    "selectable_kpis":             {"limit": 6},
    "custom_kpis":                 {"enabled": true},
    "team_structure":              {"enabled": true, "variant": "teams"},
    "export_formats":              {"enabled": true, "variant": "csv_excel_pdf"},
    "scheduled_reports":           {"enabled": true, "variant": "unlimited_branded"},
    "threshold_alerts":            {"enabled": true, "variant": "email_whatsapp_escalation"},
    "outgoing_webhooks":           {"enabled": true},
    "import_center":               {"enabled": true, "variant": "advanced"},
    "manual_quality_scoring":      {"enabled": true},
    "revenue_summary":             {"enabled": true, "variant": "full"},
    "audit_log_window":            {"months": 12},
    "sso":                         {"enabled": false},
    "ip_allowlist":                {"enabled": false},
    "white_label":                 {"enabled": false},
    "handset_pairing":             {"enabled": true},
    "paired_handsets":             {"limit": 4},
    "crm":                         {"enabled": true},
    "ai_features":                 {"enabled": true},
    "transcription_hours_monthly": {"limit": 200, "per": "month"},
    "audio_retention_days":        {"days": 90},
    "storage_cap_gb":              {"limit": 15},
    "speaker_separation":          {"enabled": true}
  }'::jsonb),
  -- PLAN_SEED_CAPTURE_ENTERPRISE
  ('capture_enterprise', '{
    "active_telecallers":          {"limit": null},
    "dashboard_logins":            {"limit": null},
    "ingest_events_monthly":       {"limit": null, "per": "month"},
    "api_rate_per_min":            {"limit": null, "per": "minute"},
    "history_retention":           {"months": null},
    "selectable_kpis":             {"limit": 6},
    "custom_kpis":                 {"enabled": true},
    "team_structure":              {"enabled": true, "variant": "org_chart"},
    "export_formats":              {"enabled": true, "variant": "csv_excel_pdf"},
    "scheduled_reports":           {"enabled": true, "variant": "unlimited_branded"},
    "threshold_alerts":            {"enabled": true, "variant": "email_whatsapp_escalation"},
    "outgoing_webhooks":           {"enabled": true},
    "import_center":               {"enabled": true, "variant": "advanced"},
    "manual_quality_scoring":      {"enabled": true},
    "revenue_summary":             {"enabled": true, "variant": "full"},
    "audit_log_window":            {"months": null},
    "sso":                         {"enabled": true},
    "ip_allowlist":                {"enabled": true},
    "white_label":                 {"enabled": true},
    "handset_pairing":             {"enabled": true},
    "paired_handsets":             {"limit": 10},
    "crm":                         {"enabled": true},
    "ai_features":                 {"enabled": true},
    "transcription_hours_monthly": {"limit": null, "per": "month"},
    "audio_retention_days":        {"days": 180},
    "storage_cap_gb":              {"limit": null},
    "speaker_separation":          {"enabled": true}
  }'::jsonb)
)
-- PLAN_SEED_END_0197
INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_type, value)
SELECT p.id, e.key, t.limit_type, e.value
  FROM seed s
  JOIN plans p ON p.key = s.plan_key
  CROSS JOIN LATERAL jsonb_each(s.entitlements) AS e(key, value)
  JOIN limit_types t ON t.entitlement_key = e.key
-- DO UPDATE, not DO NOTHING. 0192's rows already exist for the Insights plans
-- and the four new keys have to land on them; and `limit_type` has to be able
-- to move, which is how `audio_retention_days` would be corrected from
-- 'window' to 'sweep' if an earlier run had written it wrong.
--
-- This DOES overwrite a limit an operator edited by hand, on a re-run. That is
-- the right trade for a seed: a migration re-run is a deploy, the catalogue is
-- restated in full here, and silently keeping a hand-edit would make the
-- drift check in pricing.test.ts pass against a database that disagrees with
-- it. An operator's edits live past the deploy that made them, not past the
-- next restatement of the seed.
ON CONFLICT (plan_id, entitlement_key) DO UPDATE SET
  limit_type = EXCLUDED.limit_type,
  value      = EXCLUDED.value,
  updated_at = now();

-- Every plan must have every key: 8 plans x 27 keys. An absent row is the one
-- failure mode this whole table shape exists to avoid, so it is asserted
-- rather than hoped for.
DO $$
DECLARE n int; expected int := 8 * 27;
BEGIN
  SELECT count(*) INTO n FROM plan_entitlements;
  IF n < expected THEN
    RAISE EXCEPTION '0197: expected at least % plan_entitlements rows, found %', expected, n;
  END IF;
END $$;

-- And every capture plan must be priced in both regions, or the Compare-plans
-- page renders a plan with no price and the checkout route has nothing to
-- charge.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(p.key || '/' || r.region, ', ') INTO missing
    FROM plans p
    CROSS JOIN (VALUES ('IN'), ('AE')) AS r(region)
   WHERE p.family = 'capture'
     AND NOT EXISTS (
       SELECT 1 FROM plan_prices pp WHERE pp.plan_id = p.id AND pp.region = r.region
     );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0197: capture plans with no price: %', missing;
  END IF;
END $$;

------------------------------------------------------------------------------
-- 13 ── The consent lock
--
-- Server-side, pinned to the tenant's billing region, and the handset is never
-- the authority on whether it may record.
--
-- An AE tenant that has not had a counsel opinion recorded is forced to
-- `consent_policy = 'prohibited'`, which the existing upload-admission path
-- already refuses on (calls.controller.ts) and which the handset config route
-- already reads. So this trigger does not add an enforcement point - it makes
-- an existing one impossible to switch off by accident, including through the
-- tenancy PATCH route an owner can reach.
--
-- A TRIGGER rather than an API check, because there are three writers of this
-- column today (the operator's tenant creator, the tenancy PATCH, and a plan
-- apply) and a rule enforced in three places is a rule with two holes.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_region_consent_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_region = 'AE' AND NEW.consent_cleared_at IS NULL THEN
    -- Not an exception: an operator legitimately creates and edits AE tenants,
    -- and failing their write would make the region unusable rather than
    -- unrecordable. The policy is CLAMPED instead, which is the behaviour the
    -- compliance position asks for - "UAE tenants default to recording
    -- disabled until we ship affirmative consent capture".
    NEW.consent_policy := 'prohibited';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS organizations_enforce_region_consent ON organizations;
CREATE TRIGGER organizations_enforce_region_consent
  BEFORE INSERT OR UPDATE OF billing_region, consent_policy, consent_cleared_at
  ON organizations
  FOR EACH ROW EXECUTE FUNCTION enforce_region_consent_policy();

-- Clamp anything that already exists. No tenant is in AE today, so this is
-- expected to touch nothing; it runs so that the invariant holds from this
-- migration onward rather than from the next write to each row.
UPDATE organizations
   SET consent_policy = 'prohibited'
 WHERE billing_region = 'AE' AND consent_cleared_at IS NULL
   AND consent_policy <> 'prohibited';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM organizations
   WHERE billing_region = 'AE' AND consent_cleared_at IS NULL
     AND consent_policy <> 'prohibited';
  IF n > 0 THEN
    RAISE EXCEPTION '0197: % AE tenant(s) not pinned to consent_policy=prohibited', n;
  END IF;
END $$;

------------------------------------------------------------------------------
-- 14 ── Existing tenants keep exactly the product they have
--
-- Same decision 0192 made, for the same reason: this migration creates NO
-- subscription rows and puts NO org on a capture plan. `check()` treats an org
-- with no subscription as unlimited, which is what every pre-plan tenant has
-- today, and putting them on a plan would RESOLVE that plan's meters over the
-- top - which for the capture family means writing retention_days,
-- storage_quota_bytes and the transcription ceiling. Narrowing a live tenant's
-- audio retention from 365 days to 90 as a side effect of a deploy is not a
-- migration, it is data loss.
--
-- A tenant enters the capture plan system when an operator puts them on one.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- 15 ── One new notification kind: the transcription meter's own warning
--
-- The price list says owners are told at 80% and 100% of the transcription
-- allowance, exactly as they already are for storage (`storage_quota`, doc
-- 27). Storage has a kind; hours did not, and without one the warning cannot
-- be written at all - `notifications_kind_check` would answer 23514 at the
-- moment the bell should have rung.
--
-- ── WHY THE WHOLE LIST IS RESTATED, AGAIN ──────────────────────────────────
--
-- `packages/shared/src/notification-kinds.test.ts` finds the LAST literal
-- `ADD CONSTRAINT notifications_kind_check CHECK (kind IN (...))` across every
-- migration, sorted by filename, and asserts `NotificationKind`'s options
-- equal it exactly. So a new kind has to come as a full literal restatement in
-- the highest-numbered file, or the guard compares the enum against 0187's
-- list and goes quietly wrong.
--
-- 0179's header records the mistake this convention exists to prevent: 0176
-- appended DYNAMICALLY, 0177 then did a DROP + ADD with an explicit list that
-- could not contain 0176's values, and two finance kinds were added and then
-- silently removed. The first anybody would have known was a 23514 on a live
-- tenant. Every value below was read back from 0187's list, not retyped from
-- memory, plus the one new one.
--
-- ── AND WHY ONLY ONE KIND FOR FOUR LIMITS ──────────────────────────────────
--
-- `notifications`'s own header: "noise is how a notification system dies -
-- people stop reading the bell, and then the one that mattered gets missed
-- too." Of the four meters only two warn at all. Storage already has its kind.
-- The handset cap refuses at the moment somebody tries to pair, which is a
-- message on the screen they are looking at rather than a bell. Audio
-- retention does not warn because nothing is wrong: the recording reaching its
-- stated age is the product working.
------------------------------------------------------------------------------

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'task_due', 'deal_stage_changed', 'deal_idle',
                  'automation', 'report_ready', 'lead_assigned',
                  'opt_out_requested', 'channel_needs_attention',
                  'sla_breach', 'review_pending',
                  'call_access_requested',
                  'storage_quota',
                  'missed_call',
                  'task_response',
                  -- 0140/0143: attendance (doc 33).
                  'attendance_request',
                  'attendance_break_overrun',
                  'attendance_away',
                  'attendance_review',
                  'attendance_absent',
                  -- 0147: we answered a problem you reported (doc 36).
                  'call_issue_update',
                  -- 0148: the data export engine (doc 35).
                  'export_ready',
                  'export_failed',
                  'export_created',
                  -- 0151: call escalations (doc 38).
                  'call_escalated',
                  'call_escalation_update',
                  -- 0152: an invitation was taken up.
                  'invite_accepted',
                  -- 0177/0178: the organization chart's four.
                  'position_vacant',
                  'reporting_change',
                  'contract_expiring',
                  'probation_ending',
                  -- 0172-0176/0179: the finance module's two.
                  'finance_alert',
                  'finance_payout',
                  -- 0184-0187: the transcript agent's three.
                  'callback_due',
                  'callback_missed',
                  'agent_alert',

                  -- ══ 0197: the transcription allowance ══
                  --
                  -- 80% and 100% of this month's included hours, told to
                  -- owners once per threshold - the same shape and the same
                  -- audience as `storage_quota`, whose sweep records the last
                  -- threshold it sent so an org sitting at 85% hears about it
                  -- once rather than hourly.
                  --
                  -- It is NOT an error and the body must not read like one.
                  -- Hitting the ceiling costs the customer nothing except
                  -- time: the call is still recorded, stored, listed and
                  -- playable, only transcription and analysis are skipped, and
                  -- the call stays reprocessable - so a top-up or the next
                  -- month's reset picks it up and transcribes it after the
                  -- fact. "You have used 80% of your hours" with the top-up
                  -- offered, never "transcription failed".
                  'transcription_quota'));

DO $do$
DECLARE missing text;
BEGIN
  SELECT string_agg(v.k, ', ') INTO missing
    FROM (VALUES
            -- This wave's one.
            ('transcription_quota'),
            -- And a sample of everybody else's, because this file RESTATES the
            -- list: a value dropped by a mistake in the restatement is a
            -- regression in somebody else's feature, and this is the only
            -- place that could catch it.
            ('callback_due'), ('callback_missed'), ('agent_alert'),
            ('finance_alert'), ('finance_payout'),
            ('position_vacant'), ('reporting_change'),
            ('contract_expiring'), ('probation_ending'),
            ('invite_accepted'), ('call_escalated'), ('export_ready'),
            ('attendance_absent'), ('review_pending'), ('task_assigned'),
            ('storage_quota'), ('missed_call'), ('call_issue_update')
         ) AS v(k)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'notifications'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%' || v.k || '%'
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0197: notifications.kind no longer admits: % - this restatement dropped a kind somebody depends on', missing;
  END IF;
  RAISE NOTICE '0197: capture price list, add-on catalogue, billing orders and the two retention clocks are in.';
END $do$;
