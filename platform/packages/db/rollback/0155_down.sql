-- 0155_down.sql - reverse the script-adherence mode switch.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0155_down.sql
--
-- Dropping the column returns the worker to its pre-0155 rule: an org with an
-- active SOP is scored against it, an org without one is not. Any tenant who
-- had switched to 'ai' WHILE keeping their checklist active will start being
-- scored against that checklist again - so note who that is before running
-- this, because the column that records their choice is about to be gone:
--
--   SELECT id, name FROM organizations o
--    WHERE script_adherence_mode = 'ai'
--      AND EXISTS (SELECT 1 FROM call_sops s WHERE s.org_id = o.id AND s.is_active);
--
-- No `call_sop_results` are touched. They are the record of what was judged.

BEGIN;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_script_adherence_mode_check;
ALTER TABLE organizations DROP COLUMN IF EXISTS script_adherence_mode;

DELETE FROM schema_migrations WHERE name = '0155_script_adherence_mode.sql';

COMMIT;
