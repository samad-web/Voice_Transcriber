-- 0205_crm_token_refresh.sql
--
-- A CRM connector refreshes its own access token instead of waiting for a human
-- to paste a new one. Doc 49 P10-B.
--
-- ── WHO THIS IS FOR ─────────────────────────────────────────────────────────
--
-- Four of the nineteen connectors in the catalogue take an OAuth ACCESS token
-- rather than a long-lived API key: Salesforce, Zoho, monday and Dynamics 365.
-- For Zoho and Dynamics it lasts ONE HOUR. Every delivery then 401s until
-- somebody opens the integration card and pastes a new one, which makes those
-- four pilot-grade rather than unattended-production-grade - exactly what 0204's
-- watchdog now tells a customer, and exactly what this migration starts to fix.
--
-- The other fifteen vendors issue a credential that does not expire. Nothing
-- here applies to them, and nothing here is required of them: every column is
-- nullable and absent means "this connector has no refresh story", which is the
-- truth for most of the catalogue.
--
-- ── WHAT THIS DOES NOT DO, SAID PLAINLY ─────────────────────────────────────
--
-- It does not implement the authorization-code CONSENT flow. Obtaining the
-- first refresh token means a redirect to the vendor, a consent screen, a
-- callback URL registered in the customer's own OAuth app, and per-provider
-- scope handling - which is 0120's territory and a far larger build than this.
--
-- So a customer still pastes a credential once. The difference is WHAT they
-- paste: a refresh token rather than an access token. Every one of these four
-- vendors issues one to a self-client or Connected App without a redirect
-- (Zoho's self-client, Salesforce's Connected App with a refresh scope,
-- Dynamics via a confidential client), and a refresh token lasts months to
-- forever instead of an hour.
--
-- That is a deliberately smaller change than the plan's week-long version, and
-- it is where the value is: the 401s stop. Adding the consent flow later needs
-- no schema change, because the columns below are what it would write anyway.

BEGIN;

ALTER TABLE crm_integrations
  /**
   * The long-lived credential, SEALED with the same AES-256-GCM envelope as
   * `auth_secret` (packages/db/src/secrets.ts, prefix v1.gcm:). It must never
   * be written in plaintext: a refresh token is strictly MORE dangerous than
   * the access token it mints, because it does not expire.
   */
  ADD COLUMN IF NOT EXISTS refresh_secret text,
  /**
   * When the current access token stops working, as the vendor reported it.
   *
   * NULL means unknown, which is the honest state for a token a customer
   * pasted by hand - we were not told when it was issued. The sweep treats
   * unknown as "refresh it on the next failure" rather than "refresh it now":
   * refreshing a token that works costs a request and a new token, and some
   * vendors invalidate the old one immediately.
   */
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  /**
   * The vendor's token endpoint, because it is not derivable from the provider
   * id alone. Zoho's depends on the customer's data centre
   * (accounts.zoho.in vs .com vs .eu), Salesforce's on whether the org is a
   * sandbox, and Dynamics' carries the Entra tenant id. Getting any of those
   * wrong means a refresh that 400s forever, so it is stored rather than
   * guessed.
   */
  ADD COLUMN IF NOT EXISTS token_url text,
  /** When the access token was last refreshed successfully. For the card. */
  ADD COLUMN IF NOT EXISTS token_refreshed_at timestamptz,
  /**
   * Why the last refresh failed, or NULL. A refresh token that the vendor has
   * revoked cannot be recovered by retrying - the customer has to re-consent -
   * so this is what the console shows instead of retrying forever.
   */
  ADD COLUMN IF NOT EXISTS token_refresh_error text;

COMMENT ON COLUMN crm_integrations.refresh_secret IS
  'OAuth refresh token, AES-256-GCM sealed exactly like auth_secret. More '
  'dangerous than the access token it mints because it does not expire - never '
  'return it from any route, never log it, and never render it. The console '
  'shows only whether one is present.';

COMMENT ON COLUMN crm_integrations.token_refresh_error IS
  'Set when a refresh FAILED in a way retrying cannot fix - a revoked or '
  'expired refresh token. The customer must re-consent; the worker stops '
  'trying so a revoked credential does not become a request every five '
  'minutes against a vendor that has already said no.';

-- The sweep's query: connections with a refresh token whose access token is
-- near expiry. Partial, because the fifteen connectors with no refresh story
-- should not be in the index at all.
CREATE INDEX IF NOT EXISTS crm_integrations_token_expiry_idx
  ON crm_integrations (token_expires_at)
  WHERE refresh_secret IS NOT NULL;

COMMIT;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--
--   \d+ crm_integrations
--
--   -- No route may return the sealed value. This is the assertion that
--   -- matters, and `crm-secret-exposure.spec.ts` makes it in CI:
--   SELECT 1;  -- (nothing to run here; the guard is a source scan)
