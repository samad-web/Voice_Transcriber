-- 0007_supabase_hardening.sql — safe to run on ANY Postgres.
--
-- On Supabase the schema lives in a database that also hosts PostgREST ("the
-- Data API"), whose `anon` / `authenticated` roles are granted table access by
-- Supabase's default privileges. Our tenancy model does NOT use Supabase Auth —
-- isolation comes from RLS keyed on current_setting('app.org_id'), which those
-- roles can never set. Worse, tables without RLS (users, sessions bookkeeping,
-- schema_migrations) would be plainly readable with the public anon key.
--
-- So: strip every privilege from the Supabase API roles and stop future tables
-- from inheriting them. Every statement is guarded on the role existing, so on a
-- plain Postgres (local docker) this file is a no-op.

DO $$
DECLARE
  api_role text;
  owner_role text := current_user;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', api_role);

      -- Future tables created by the migration owner must not be granted either.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
        owner_role, api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
        owner_role, api_role);

      RAISE NOTICE 'revoked public-schema access from %', api_role;
    END IF;
  END LOOP;
END $$;

-- PUBLIC (i.e. every role) must not reach the tables either — only aura_app,
-- which 0001/0003/0004 grant explicitly, and the owner running migrations.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO aura_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aura_app;

-- Re-assert the append-only tables and the runner's own bookkeeping (the blanket
-- GRANT above would otherwise hand them back).
REVOKE UPDATE, DELETE ON audit_log    FROM aura_app;
REVOKE UPDATE, DELETE ON usage_events FROM aura_app;
REVOKE ALL    ON schema_migrations    FROM aura_app;

-- Supabase's managed Postgres has no superuser available to the project, so the
-- migration owner (`postgres`) owns these tables. FORCE RLS is what makes the
-- policies bind for aura_app; assert it here rather than trusting 0001 ran on
-- the same role.
-- Derived from the policies themselves, never a hand-kept list: enabling FORCE
-- RLS on a table that has no policy is a deny-all outage, so only tables that
-- already carry one are touched.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
