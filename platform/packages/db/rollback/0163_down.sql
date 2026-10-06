-- 0163_down.sql - reverse the portal's access model and take the wall down.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0163_down.sql
--
-- RUN THIS BEFORE 0163's sibling `0162_down.sql`, not after - see that file's
-- header. The `memberships` trigger below reads `partner_users`, so dropping
-- 0162's tables first would leave every membership INSERT on the platform
-- raising 42P01.
--
-- ── WHAT THIS DESTROYS ─────────────────────────────────────────────────────
--
-- Pending invitations. An unaccepted `partner_invites` row is a link somebody
-- is holding; after this it is a dead URL and they will need a new one.
-- Accepted rows are history only - the `partner_users` row they produced is
-- what grants access, and that lives in 0162's table.
--
--   \copy (SELECT id, org_id, partner_id, email, name, role, expires_at,
--                 accepted_at, revoked_at, created_at FROM partner_invites)
--     TO 'partner-invites.csv' CSV HEADER
--
-- The token hashes are deliberately left out of that export: they are the only
-- secret in the table and a CSV of them on somebody's laptop is worse than
-- re-issuing three links.
--
-- ── WHAT TAKING THE WALL DOWN MEANS ────────────────────────────────────────
--
-- `partner_wall` is what stops a partner principal reading `leads`, `contacts`,
-- `calls` and everything else org-scoped. With it gone, any transaction that
-- sets `app.partner_id` can read the whole tenant.
--
-- That is safe ONLY because `withPartnerContext` is the single caller that ever
-- sets that GUC, and 0162_down.sql removes the tables its module is built on.
-- So the order is not a preference: running this while the partners API is
-- still deployed and serving would open every tenant's pipeline to every
-- broker. Take the API down, or run both files, in order, in one sitting.

BEGIN;

-- 1. The wall, and the one narrowed exception beside it. Enumerated from the
--    catalog exactly as 0163 added them, so a table added between the two runs
--    is handled rather than skipped.
DO $do$
DECLARE t text; dropped int := 0;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_policies
     WHERE schemaname = 'public' AND policyname = 'partner_wall'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS partner_wall ON %I', t);
    dropped := dropped + 1;
  END LOOP;
  RAISE NOTICE '0163_down: dropped partner_wall from % table(s)', dropped;
END $do$;

DROP POLICY IF EXISTS partner_isolation ON commission_plans;

-- 2. The exclusivity triggers. `memberships_not_partner` first: until it is
--    gone, nobody holding a partner_users row can be added to a workspace, and
--    0162_down.sql is about to delete those rows out from under the check.
DROP TRIGGER IF EXISTS memberships_not_partner ON memberships;
DROP FUNCTION IF EXISTS membership_not_partner_guard();

DROP TRIGGER IF EXISTS partner_users_not_member ON partner_users;
DROP FUNCTION IF EXISTS partner_user_not_member_guard();

-- 3. The invites. Its policies and indexes go with it.
DROP TABLE IF EXISTS partner_invites;

DELETE FROM schema_migrations WHERE name = '0163_partner_portal_access.sql';

COMMIT;
