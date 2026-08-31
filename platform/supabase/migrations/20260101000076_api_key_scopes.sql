-- 0076_api_key_scopes.sql - make `api_keys` a credential that can actually be
-- presented, and bound to least privilege when it is.
--
-- ── THE STATE THIS FIXES ──────────────────────────────────────────────────
--
-- `api_keys` has existed since 0003. Nothing in the codebase authenticates
-- with it: apikeys.controller.ts creates, lists and deletes rows, and
-- billing.controller.ts counts them. Grep the API for `api_keys` and those are
-- the only hits. A tenant can therefore mint a key, be shown it exactly once,
-- and discover there is no request it can be presented on.
--
-- The table is also missing everything a real integration credential needs:
--
--   * NO SCOPES. The only other credential that can act for a tenant is the
--     platform admin key, which is `platform_admin` with every permission and
--     `principalHasPermission` short-circuited to true. A CRM integration key
--     that inherited that would let a partner's build server read every
--     recording and delete every deal. An integration key must be able to say
--     "create leads, and nothing else".
--   * NO EXPIRY. A credential handed to a third party with no expiry is a
--     credential you have permanently, not temporarily, trusted.
--   * NO REVOCATION. Today the only way to stop a key is DELETE, which also
--     destroys the audit trail of what it was and who made it - exactly when
--     you most want that trail (0057's marketing_sources.active makes the same
--     call, and 0073's crm_projects.active repeats it).
--
-- ── WHY THE ORG IS NOT A HEADER ───────────────────────────────────────────
--
-- AdminKeyGuard takes the tenant from `x-org-id` because the admin key is a
-- cross-tenant platform credential and choosing a tenant is its job. An API
-- key is the opposite: it belongs to exactly one org, and the org is a
-- PROPERTY OF THE ROW, resolved server-side from the key hash. There is
-- deliberately no header that can move an API-key request to another tenant -
-- that is the whole difference between the two credentials, and it is enforced
-- in api-key.guard.ts by never reading `x-org-id` at all.

ALTER TABLE api_keys
  -- A closed set, checked here as well as in zod (packages/shared/src/api-scopes.ts)
  -- so a key minted by a script with a typo'd scope is rejected by the database
  -- rather than silently granting nothing - or, worse, silently being treated
  -- as a wildcard by some future `scopes.length === 0` shortcut.
  --
  -- DEFAULT '{}' is deliberately the EMPTY set, not a wildcard: a key created
  -- by code that predates this migration can do nothing at all until someone
  -- states what it is for. Fail closed.
  ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}';

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- Who minted it, for the trail revocation-instead-of-DELETE exists to keep.
-- SET NULL rather than CASCADE: removing the person must not remove the record
-- that the key was issued.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Free-text note for "what is this key plugged into" - the question asked at
-- 3am when a key is behaving oddly and `name` says "integration".
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS description text;

DO $$ BEGIN
  ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_known
    CHECK (scopes <@ ARRAY[
      'leads:read',    'leads:write',
      'contacts:read', 'contacts:write',
      'deals:read',    'deals:write',
      'projects:read',
      'mcp'
    ]::text[]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The guard's lookup: hash first, then liveness. Partial on the live keys
-- because a revoked key is never authenticated again and indexing it helps
-- nothing - the same shape leads_org_project (0073) uses.
CREATE INDEX IF NOT EXISTS api_keys_live_hash
  ON api_keys (key_hash) WHERE revoked_at IS NULL;

-- ── RLS ───────────────────────────────────────────────────────────────────
--
-- 0003 created api_keys before FORCE RLS was the house rule, and it is one of
-- the tables 0007 swept. Re-asserted here rather than assumed, because this
-- migration is what turns the table into a live authentication surface: a
-- credential table readable across tenants is the worst possible RLS gap, and
-- "it was probably done in 0007" is not something to take on trust.
--
-- The guard itself reads this table on the ADMIN pool, deliberately: it has to
-- resolve which org a key belongs to before any org context exists, exactly as
-- the Meta webhook resolves an org from a page_id before it can call withOrg.
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON api_keys
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON api_keys FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON api_keys FROM PUBLIC;

-- ── api_key_events - what a key actually did ──────────────────────────────
--
-- audit_log records actions by `actor_type IN ('user','system',...)` against a
-- target. That is the right home for "a deal was created", and this is NOT a
-- replacement for it. What it cannot answer is "which external system is
-- hammering us, and what is it being refused for" - a question about the
-- CREDENTIAL rather than about any record, and the first question asked when a
-- partner integration misbehaves.
--
-- Deliberately small and append-only. `status` carries refusals too, because a
-- log that only records successes cannot show you a key trying and failing to
-- reach data it has no scope for - which is the signal that matters.
CREATE TABLE IF NOT EXISTS api_key_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,

  -- 'rest' | 'mcp' - the same key may be presented on either front door, and
  -- "the MCP agent did it" vs "their backend did it" is the first thing you
  -- want to know.
  channel    text NOT NULL CHECK (channel IN ('rest', 'mcp')),
  -- The REST route or the MCP tool name.
  operation  text NOT NULL,
  -- ok | forbidden_scope | invalid | not_found | error
  status     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_key_events_key
  ON api_key_events (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_key_events_org_time
  ON api_key_events (org_id, created_at DESC);

ALTER TABLE api_key_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_events FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON api_key_events
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON api_key_events TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON api_key_events FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON api_key_events FROM PUBLIC;
