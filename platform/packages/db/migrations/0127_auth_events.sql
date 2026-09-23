-- Sign-in history: the rows behind the console's Login activity page
-- (doc 27 §5).
--
-- Until now nothing recorded a sign-in at all. `audit_log` never got a login
-- row and `signInAction` wrote nothing, so "was that me on Tuesday?" had no
-- answer anywhere in the product.
--
-- ── WHY OUR OWN TABLE, NOT GOTRUE'S ─────────────────────────────────────────
--
-- In production this database IS the Supabase Postgres, so auth.sessions and
-- auth.audit_log_entries are technically readable. They are not used:
--   - the self-host README's rule is that nothing couples to `auth.*` by SQL;
--   - local dev has no `auth` schema at all;
--   - GoTrue's rows cannot say which console or workspace a sign-in went to.
-- The web tier records the events at the moments it already controls.
--
-- ── NOT A TENANT TABLE, ON PURPOSE ──────────────────────────────────────────
--
-- A person's sign-in history spans every workspace they belong to, and
-- platform operators - who belong to no workspace - have one too. So the
-- boundary is the PERSON, not the org: every read is bound to the caller's own
-- `auth_user_id`, and that id comes only from the `x-caller-auth-id` header
-- the Next server sets from a verified getClaims(). Never from a body.
--
-- The workspace a sign-in entered is kept for display as `console_org_id`,
-- deliberately NOT named `org_id`: verify-rls.js classifies every table with
-- an `org_id` column as tenant data and demands an org_isolation policy, and
-- a column that is display-only must not look like a boundary to a reader or
-- to that script.
--
-- Same treatment as platform_operators (0089): RLS enabled and FORCED with no
-- policy at all (deny everything), `aura_app` and the Supabase API roles
-- revoked outright, reached only through the admin pool. Listed in
-- NON_TENANT_TABLES in packages/db/verify-rls.js as a reviewed exemption.

CREATE TABLE IF NOT EXISTS auth_events (
  id              bigserial PRIMARY KEY,
  -- GoTrue's subject (claims.sub). Works for operators AND org users, which
  -- is why the history is keyed on it rather than on users.id.
  auth_user_id    uuid NOT NULL,
  -- The platform user, when there is one. NULL for an operator, who has no
  -- `users` row.
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN
                    ('sign_in', 'sign_in_failed', 'sign_out', 'sign_out_all', 'password_changed')),
  -- claims.session_id, so the page can mark "This session".
  session_id      uuid,
  console         text CHECK (console IN ('owner', 'operator')),
  -- Display only - see the header. No FK: a deleted workspace must not take a
  -- person's own sign-in history with it.
  console_org_id  uuid,
  ip              inet,
  user_agent      text CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Every read is "this person's rows, newest first", keyset-paged on
-- (created_at, id); the failed-sign-in cap reads the same index.
CREATE INDEX IF NOT EXISTS auth_events_user_time ON auth_events (auth_user_id, created_at DESC, id DESC);
-- The 180-day retention sweep.
CREATE INDEX IF NOT EXISTS auth_events_created ON auth_events (created_at);

COMMENT ON TABLE auth_events IS
  'Per-person sign-in history (doc 27). Admin pool only; every read is bound to the caller''s own auth_user_id.';

ALTER TABLE auth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_events FORCE  ROW LEVEL SECURITY;
-- No policy, deliberately: for any role subject to RLS this table is empty.

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'aura_app'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON auth_events FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE auth_events_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON auth_events FROM PUBLIC;
REVOKE ALL ON SEQUENCE auth_events_id_seq FROM PUBLIC;
