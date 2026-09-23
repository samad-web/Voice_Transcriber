-- 0131_integration_pending_choices.sql - a sign-in that returns with choices
-- waits for a person to make them.
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
--
-- Meta's OAuth callback asked Facebook for every Page the person manages and
-- then took `pages[0]` (meta-oauth.controller.ts). Somebody who runs lead ads
-- on their second Page connected their first one, saw "connected", and got no
-- leads - and the callback rendered JSON on the API's own domain, so they were
-- not even back in the console to notice.
--
-- The Integrations store (doc 28 §11.3) ends that sign-in on a CHOOSE step
-- inside the console instead. Between the callback and the choice, the Pages
-- and their tokens have to be somewhere, and the only somewhere that survives
-- a browser redirect without putting a token in a URL is a row.
--
-- ── WHAT THE ROW HOLDS, AND FOR HOW LONG ────────────────────────────────────
--
-- `payload` is the list of Pages WITH their access tokens, sealed by
-- `encryptSecret` (CRM_SECRET_KEY, AES-256-GCM) like every other credential in
-- this schema - never pgcrypto, never plaintext. The API reads names out of it
-- for the choose step and never returns a token.
--
-- Fifteen minutes, then it is garbage: a choice nobody made is swept by the
-- API on the next read or write for that org, and the choose route refuses an
-- expired row whether or not the sweep has run. The row is deleted the moment
-- the choice is saved - it is a hand-off, not a record.
--
-- `user_id` is the person who signed in. Only they may make the choice: the
-- tokens are theirs, granted on their Facebook account.

CREATE TABLE IF NOT EXISTS integration_pending_choices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Widened one provider at a time, deliberately: each one's payload has its
  -- own shape and its own choose route.
  provider    text NOT NULL CHECK (provider IN ('meta')),
  -- encryptSecret(JSON: [{ pageId, name, token }]).
  payload     text NOT NULL,
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_pending_choices_org
  ON integration_pending_choices (org_id, expires_at);

ALTER TABLE integration_pending_choices ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_pending_choices FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON integration_pending_choices
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- No UPDATE: a choice is written once, read, and deleted. REVOKE first - the
-- schema's default privileges hand aura_app every table-level right on a new
-- table, so a bare GRANT narrows nothing (checked: without this line aura_app
-- held UPDATE).
REVOKE ALL ON integration_pending_choices FROM aura_app;
GRANT SELECT, INSERT, DELETE ON integration_pending_choices TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON integration_pending_choices FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON integration_pending_choices FROM PUBLIC;
