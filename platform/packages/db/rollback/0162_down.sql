-- 0162_down.sql - reverse channel partners.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0162_down.sql
--
-- ── RUN 0163_down.sql FIRST ────────────────────────────────────────────────
--
-- 0163 puts a foreign key on `partners` (partner_invites.partner_id) and two
-- triggers that read `partner_users`. Dropping these tables underneath it would
-- either fail on the dependency or leave `membership_not_partner_guard()`
-- querying a table that no longer exists - which would make EVERY membership
-- INSERT raise 42P01, i.e. nobody could be added to any workspace on the
-- platform. The guard against that is simply the order, and this is it.
--
-- ── READ THIS FIRST: THIS ONE DELETES THE TENANT'S ATTRIBUTION ─────────────
--
-- Dropping `partner_submissions` discards the record of which broker sent which
-- lead. The LEADS survive - they were written through the ordinary intake path
-- into `leads`, and `partner_submissions.lead_id` is the only thing being lost -
-- but "where did this customer come from" becomes unanswerable for every lead a
-- partner ever submitted, and it is the question commission is reconciled
-- against.
--
-- Keep it before running this. It is small and it is the only copy:
--
--   \copy (SELECT s.*, p.name AS partner_name, p.code AS partner_code
--            FROM partner_submissions s JOIN partners p ON p.id = s.partner_id)
--     TO 'partner-submissions.csv' CSV HEADER
--
-- The seeded `role_permissions` rows go too. Nothing is lost there: nobody held
-- `partner` before 0162, so taking the grants away returns the grid to exactly
-- what it was. An owner who hand-edited those cells afterwards loses that edit,
-- which is the one thing worth checking first:
--
--   SELECT r.key, rp.action, rp.scope FROM role_permissions rp
--     JOIN roles r ON r.id = rp.role_id
--    WHERE rp.object_type = 'partner' AND NOT r.is_system;
--
-- ── WHAT IS DELIBERATELY LEFT STANDING ─────────────────────────────────────
--
-- `commission_plans.payee_kind` is KEPT. Dropping the column would silently
-- merge every partner-facing rate back into the list the console offers for
-- staff, where somebody would attach one to a telecaller and be paid a broker's
-- flat fee per deal. The column is harmless with the partner tables gone - every
-- row reads 'user' except the ones somebody deliberately set - and re-applying
-- 0162 afterwards finds it already there (ADD COLUMN IF NOT EXISTS). Drop it by
-- hand, after checking nothing points at those plans:
--
--   SELECT id, name, rate_type, rate FROM commission_plans WHERE payee_kind = 'partner';

BEGIN;

-- 1. The three tables. `partner_submissions` and `partner_users` go first and
--    explicitly, rather than relying on the CASCADE from `partners`, so the
--    statements say what they destroy.
DROP TABLE IF EXISTS partner_submissions;
DROP TABLE IF EXISTS partner_users;

-- 2. The commission-plan guard, before the table it hangs off.
DROP TRIGGER IF EXISTS partners_commission_plan_guard ON partners;
DROP TRIGGER IF EXISTS partners_set_updated_at ON partners;
DROP TABLE IF EXISTS partners;
DROP FUNCTION IF EXISTS partner_commission_plan_guard();

-- 3. The permission grants. Custom roles are included even though 0162 never
--    seeded them: a `partner` row can only have come from 0162 or from somebody
--    editing the grid afterwards, and leaving orphan grants for an object type
--    the API no longer knows is worse than losing a hand edit the header told
--    you to check for. (0158_down.sql takes the same line.)
DELETE FROM role_permissions WHERE object_type = 'partner';

-- 4. `commission_plans.payee_kind` stays - see the header. Only the CHECK that
--    constrains it to the two-value vocabulary is kept too; there is nothing to
--    reverse.

DELETE FROM schema_migrations WHERE name = '0162_channel_partners.sql';

COMMIT;
