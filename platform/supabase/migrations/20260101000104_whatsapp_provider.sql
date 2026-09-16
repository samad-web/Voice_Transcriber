-- 0104_whatsapp_provider.sql
--
-- One column on `organizations`, a provisioning control an operator sets per
-- client from the admin console.
--
-- This migration used to carry a second column, `enabled_features text[]`. That
-- half is DELIBERATELY GONE: 0101_org_features already answers the same
-- question with a better design - an `org_feature_settings` row per override
-- plus `org_feature_enabled(org, feature, module, default)`, which keeps the
-- catalogue in TypeScript instead of in a Postgres array. Two designs of one
-- idea is how a schema rots, so this one yielded.
--
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
