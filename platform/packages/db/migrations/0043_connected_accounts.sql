-- 0043_connected_accounts.sql — PRD Layer 1, part 1: a user's own email and
-- calendar accounts.
--
-- ── WHY PER-USER, AND WHY NOT ONE PROVIDER ────────────────────────────────
--
-- The calendar integration that exists today (apps/worker/src/pipeline/
-- calendar-busy-sync.ts) is one Google service account, configured through
-- GOOGLE_CALENDAR_ID environment variables, shared by the whole deployment.
-- That works for the marketing funnel's booking slots — there is genuinely one
-- booking calendar — and it is the wrong shape for a CRM, where the mail and
-- the meetings belong to individual reps and to whichever provider each of
-- them already uses.
--
-- So: one row per (user, provider, account). A rep connects their own Gmail;
-- the rep at the next desk connects Outlook; a tenant on neither connects
-- plain IMAP. Nothing here is org-wide and nothing is vendor-specific — the
-- provider is a string resolved against a catalogue in
-- packages/shared/src/connection-providers.ts, the same "onboarding is data,
-- not code" shape crm-providers.ts already uses for outbound CRM connectors.
--
-- The existing booking-calendar sync is NOT touched or migrated by this.
-- It keeps working exactly as it does today; this is a second, additive
-- capability, in the same strangler-fig spirit as the rest of the CRM build.
--
-- ── CREDENTIALS ───────────────────────────────────────────────────────────
--
-- access_token/refresh_token/secret hold values sealed by encryptSecret()
-- (packages/db/src/secrets.ts, AES-256-GCM under CRM_SECRET_KEY) — the same
-- envelope the CRM connectors' API keys already use. RLS does not protect
-- these: the app role can legitimately read the row, and the threat is a
-- database dump. They are stored sealed for that reason.

CREATE TABLE IF NOT EXISTS connected_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Whose account this is. CASCADE because a connection is meaningless
  -- without the person whose mailbox it is — and leaving their tokens behind
  -- after they are removed would be exactly the wrong thing to keep.
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Resolved against the catalogue, app-validated rather than a DB CHECK, so
  -- adding a provider stays a code change and never a migration. Same
  -- reasoning as custom_field_definitions.object_type (0037).
  provider        text NOT NULL,
  -- What this connection is good for: email, calendar, or both. Also
  -- app-validated — a provider that later grows a capability should not need
  -- a constraint dropped.
  capabilities    text[] NOT NULL DEFAULT '{}',

  -- The identity as the provider knows it. `account_email` is what a human
  -- recognises in a list; `external_account_id` is what survives the user
  -- renaming their address.
  account_email   text NOT NULL,
  external_account_id text,
  display_name    text,

  scopes          text[] NOT NULL DEFAULT '{}',

  -- All three sealed by encryptSecret(). `secret` carries the password for
  -- the non-OAuth providers (IMAP/CalDAV app passwords), which have no
  -- token pair at all.
  access_token    text,
  refresh_token   text,
  secret          text,
  token_expires_at timestamptz,

  -- Non-secret per-connection settings: IMAP host and port, which calendar
  -- ids to watch. Shown in the console in the clear, exactly like
  -- crm_integrations.config.
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,

  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'expired', 'revoked', 'error')),
  last_error      text,
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One connection per account per provider per user. Reconnecting the same
-- mailbox updates the tokens in place rather than stacking dead rows.
CREATE UNIQUE INDEX IF NOT EXISTS connected_accounts_identity
  ON connected_accounts (org_id, user_id, provider, lower(account_email));
CREATE INDEX IF NOT EXISTS connected_accounts_user ON connected_accounts (org_id, user_id);
-- The sync worker's query: everything live that is due a poll.
CREATE INDEX IF NOT EXISTS connected_accounts_syncable
  ON connected_accounts (org_id, last_synced_at NULLS FIRST) WHERE status = 'active';

ALTER TABLE connected_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connected_accounts FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON connected_accounts
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON connected_accounts TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON connected_accounts FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON connected_accounts FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER connected_accounts_set_updated_at BEFORE UPDATE ON connected_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── The in-flight half of an OAuth handshake ──────────────────────────────
--
-- `state` is the CSRF defence the OAuth spec requires: the provider echoes it
-- back, and a callback carrying a state this server never issued is an
-- injection attempt, not a login. Storing it rather than signing it also
-- gives somewhere to keep the PKCE verifier and the page to return to, and
-- makes an unused handshake visibly expire instead of a signed blob staying
-- valid until its clock runs out.
--
-- Rows are deleted the moment they are redeemed — single use, so a replayed
-- callback finds nothing.
CREATE TABLE IF NOT EXISTS oauth_authorizations (
  state           text PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  code_verifier   text,
  redirect_path   text,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_authorizations_expiry ON oauth_authorizations (expires_at);

ALTER TABLE oauth_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_authorizations FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON oauth_authorizations
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_authorizations TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON oauth_authorizations FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON oauth_authorizations FROM PUBLIC;
