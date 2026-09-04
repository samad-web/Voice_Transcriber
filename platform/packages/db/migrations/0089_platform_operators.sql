-- Superadmins the root operator can add without a redeploy.
--
-- Until now the operator console's allowlist was PLATFORM_OPERATOR_EMAILS, an
-- environment variable read by the web tier. That is a fine boundary and a
-- terrible workflow: adding a colleague means editing production env and
-- restarting the console, which only whoever holds the server can do. This
-- table is the same allowlist with an INSERT instead of a deploy.
--
-- ── WHAT THIS TABLE IS NOT ───────────────────────────────────────────────────
--
-- It is NOT the root. `PLATFORM_ROOT_OPERATOR_EMAIL` stays in the environment,
-- deliberately, and is never read from here. The root is the only account that
-- may add or remove rows in this table, so if the root itself were a row then
-- anyone who reached the table - through the app, through a stray admin key,
-- through a SQL injection in some future endpoint - could delete the real root
-- and appoint themselves. A root that cannot be minted from inside the
-- application is the property that makes the rest of this safe, and it is worth
-- the one env var it costs.
--
-- The API refuses to INSERT or DELETE the root address for the same reason: a
-- row carrying the root email would be a second, deletable copy of an identity
-- that is supposed to have exactly one source.
--
-- ── NO org_id, ON PURPOSE ────────────────────────────────────────────────────
--
-- A platform operator belongs to no tenant - that is the whole definition. So
-- this table is added to NON_TENANT_TABLES in packages/db/verify-rls.js, which
-- is a REVIEWED exemption rather than an oversight: verify-rls fails the deploy
-- on any new public table without org_id, and the fix is that edit, never a
-- fake org_id column. Same treatment app_releases (0081) has.

CREATE TABLE IF NOT EXISTS platform_operators (
  -- The identity is the email, so it is the key. Lowercased by CHECK rather
  -- than by trusting the caller: the console compares against the address
  -- Supabase reports, and `Max@…` failing to match `max@…` would present as a
  -- correct password being refused, with nothing in any log to say why.
  email      text PRIMARY KEY CHECK (email = lower(btrim(email)) AND email <> ''),
  -- Who granted it. Free text, because the granter is identified by their email
  -- too and platform staff have no row anywhere to point a foreign key at.
  added_by   text NOT NULL,
  -- Shown in the console so a list of standing privileges can be read as a
  -- history of decisions rather than a flat set of names.
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_operators IS
  'Superadmins added at runtime by the root operator. The root itself lives in PLATFORM_ROOT_OPERATOR_EMAIL and is deliberately absent here.';

-- REVOKE first, GRANT second. A GRANT-only migration in a database the Supabase
-- API roles can already reach narrows nothing - see 0075 and 0081 on the same
-- trap. `anon` is the public web key, and this table decides who administers
-- every tenant on the platform, so it is the last table that should be readable
-- by it.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON platform_operators FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON platform_operators FROM PUBLIC;

-- `aura_app` is the application's RLS-bound login and has no business here:
-- every read and write goes through the admin pool, exactly as app_releases
-- does, because this table has no tenant context to be scoped by.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
    EXECUTE 'REVOKE ALL ON platform_operators FROM aura_app';
  END IF;
END $$;
