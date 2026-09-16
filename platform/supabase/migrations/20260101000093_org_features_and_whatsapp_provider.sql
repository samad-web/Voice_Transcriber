-- 0093_org_features_and_whatsapp_provider.sql
--
-- Two columns, both on `organizations`, both provisioning controls an operator
-- sets per client from the admin console.
--
-- ── enabled_features ────────────────────────────────────────────────────────
--
-- One level finer than 0072's `enabled_modules`. A module is a commercial
-- entitlement ("this client bought the CRM"); a feature is a provisioning
-- decision inside it ("this client bought the CRM but does not raise invoices,
-- so keep Invoices out of their sidebar"). Those questions are asked by
-- different people at different times, and collapsing them into one array
-- would mean turning off "Invoices" looked - to every gate that reads modules -
-- exactly like cancelling a subscription.
--
-- Same shape and the same deliberate omissions as `enabled_modules`:
--
--   * text[], NOT NULL, defaulted - so no code path has to handle NULL, and
--     `= ANY(...)` works without a COALESCE anywhere.
--   * NO CHECK constraint on the elements. Precedent is 0072, which cites
--     role_permissions.object_type (0039): the legal set lives in the shared
--     zod enum (packages/shared/src/org-features.ts), so adding a feature is a
--     code change and never a migration. A CHECK here would mean every new
--     toggle needed a schema deploy, which is exactly how a "granular" system
--     stops being granular.
--
-- The DEFAULT is the empty array rather than the full feature set, and that is
-- the one place this differs from 0072's `ARRAY['aura']`. A new org gets its
-- features written explicitly by the provisioning path (createTenant computes
-- `defaultFeaturesFor(modules)`), so the default is only ever seen by a row
-- inserted some other way - and for those, "nothing granted" is the safe
-- reading, not "everything".
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS enabled_features text[] NOT NULL DEFAULT ARRAY[]::text[];

-- ── The backfill ────────────────────────────────────────────────────────────
--
-- Every org that exists today has been running with NO feature layer, which
-- means every page its modules entitle it to has been visible. Shipping an
-- empty array would silently strip the CRM sidebar from every existing tenant
-- the moment this deploys - a data migration that reads as a total outage to
-- the customer.
--
-- So existing orgs are backfilled to the full default set for the modules they
-- already hold. `report_builder` is deliberately absent: it is `optIn` in the
-- catalogue because it runs tenant-authored queries on a schedule, and a
-- backfill is not the place to grant something that was never granted before.
-- Any tenant already using it keeps their reports and data; an operator turns
-- the page back on in one click, and that click is the decision the flag exists
-- to record.
UPDATE organizations o
   SET enabled_features = (
     -- f.id is `unknown` inside a bare VALUES list; array_agg over it can fail
       -- with "could not determine polymorphic type". The cast pins it to text,
       -- which is the column's own element type.
       SELECT COALESCE(array_agg(f.id::text), ARRAY[]::text[])
       FROM (VALUES
               ('deals',          'crm'),
               ('contacts',       'crm'),
               ('tasks',          'crm'),
               ('inbox',          'crm'),
               ('whatsapp_leads', 'crm'),
               ('outreach',       'crm'),
               ('products',       'crm'),
               ('quotations',     'crm'),
               ('invoices',       'crm'),
               ('reports',        'crm'),
               ('duplicates',     'crm'),
               ('import',         'crm'),
               ('projects',       'crm'),
               ('call_quality',   'aura'),
               ('productivity',   'aura'),
               ('sops',           'aura'),
               ('lead_sources',   'aura'),
               ('meta_ads',       'aura'),
               ('messaging_setup','wasi')
             ) AS f(id, module)
      WHERE f.module = ANY(o.enabled_modules)
   )
 WHERE cardinality(o.enabled_features) = 0;

COMMENT ON COLUMN organizations.enabled_features IS
  'Per-org feature toggles refining enabled_modules (0072). Catalogue and the '
  'module->feature mapping live in packages/shared/src/org-features.ts. A '
  'VISIBILITY control enforced in the console, not a security boundary - the '
  'boundary is the module gate in CrmPermissionsGuard plus the role grid.';

-- ── whatsapp_provider ───────────────────────────────────────────────────────
--
-- Which platform this tenant's WhatsApp Business number is connected through.
--
-- This is NOT a duplicate of `messaging_channels.provider` (0056), and the
-- distinction is the reason it lives here. That column describes a channel that
-- ALREADY EXISTS - one connected number, its credentials, its webhook token. It
-- can only answer "what is this number connected through", and it cannot exist
-- until a number has been connected.
--
-- This column is the INTENT, set before there is anything to describe: it is
-- what an operator provisions, and it is what decides which connect flow the
-- client is offered on an org with no channel at all. 'wasi' here is what turns
-- the client's WhatsApp Setup page from "paste these three credentials" into an
-- in-app Embedded Signup button. Without it the page would have to guess a
-- provider from a row that does not exist yet.
--
-- CHECK'd, unlike the arrays above, because this one is a scalar with two legal
-- values and no expectation of growth-by-code: a third provider is a real
-- integration (Aura would have to speak its API), so a migration alongside it
-- is proportionate rather than friction.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS whatsapp_provider text NOT NULL DEFAULT 'none';

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_whatsapp_provider_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_whatsapp_provider_check
  CHECK (whatsapp_provider IN ('none', 'wasi'));

-- An org that already has a live Wasi channel is already on Wasi - recording
-- that is what keeps the new column true on day one rather than telling every
-- connected tenant they have no provider.
UPDATE organizations o
   SET whatsapp_provider = 'wasi'
 WHERE o.whatsapp_provider = 'none'
   AND EXISTS (
     SELECT 1 FROM messaging_channels mc
      WHERE mc.org_id = o.id AND mc.provider = 'wasi'
   );

COMMENT ON COLUMN organizations.whatsapp_provider IS
  'Provisioned WhatsApp provider (intent), distinct from messaging_channels.'
  'provider (an existing connection). Decides which connect flow the client is '
  'offered. See packages/shared/src/org-features.ts.';
