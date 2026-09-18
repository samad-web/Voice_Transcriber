-- 0120_org_oauth_apps.sql - each organisation brings its own Google and
-- Microsoft OAuth app.
--
-- ── WHY PER ORGANISATION ────────────────────────────────────────────────────
--
-- Until now Connections (0043) could only use ONE app per provider, read from
-- the platform's environment (GOOGLE_OAUTH_CLIENT_ID and friends). On a
-- multi-tenant platform that is the wrong owner for it: every client's staff
-- would consent to the platform's app, the platform's Google verification
-- would gate every client's rollout, and one client's usage would count
-- against the quota every other client shares. A client registers its own app
-- in its own Google Cloud project or Entra directory and stores it here. The
-- environment variables stay as an optional fallback for an organisation that
-- has not.
--
-- ── THE SECRET IS WRITE-ONLY ────────────────────────────────────────────────
--
-- `client_secret` is sealed by encryptSecret() (packages/db/src/secrets.ts,
-- AES-256-GCM under CRM_SECRET_KEY), exactly like connected_accounts' tokens,
-- and nothing in the API selects it into a response - the console is told
-- only that one is stored. `client_id` is NOT secret (it travels in every
-- authorize URL) and is shown, so an owner can tell which app is set.
--
-- ── WHICH APP ISSUED A TOKEN ────────────────────────────────────────────────
--
-- A refresh token only works with the client ID that issued it. Replacing an
-- organisation's app would otherwise leave every existing connection trying to
-- refresh through the NEW app and failing with the provider's unhelpful
-- `invalid_grant`. `connected_accounts.oauth_client_id` records the app a
-- connection was made through, so a changed app produces "reconnect this
-- account" instead. `oauth_authorizations.oauth_client_id` pins the same thing
-- across the ten-minute sign-in round trip. Both are NULL for rows written
-- before this migration, which keep resolving the way they always did.

CREATE TABLE IF NOT EXISTS org_oauth_apps (
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Resolved against the catalogue in packages/shared/src/connection-
  -- providers.ts and app-validated, the same reasoning as
  -- connected_accounts.provider.
  provider      text NOT NULL,
  client_id     text NOT NULL,
  -- Sealed. Never read back to a client.
  client_secret text NOT NULL,
  -- Microsoft's directory segment (a tenant GUID or domain). NULL keeps the
  -- catalogue default, `common`.
  tenant        text,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider)
);

ALTER TABLE org_oauth_apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_oauth_apps FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON org_oauth_apps
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON org_oauth_apps TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON org_oauth_apps FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON org_oauth_apps FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER org_oauth_apps_set_updated_at BEFORE UPDATE ON org_oauth_apps
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE connected_accounts   ADD COLUMN IF NOT EXISTS oauth_client_id text;
ALTER TABLE oauth_authorizations ADD COLUMN IF NOT EXISTS oauth_client_id text;
