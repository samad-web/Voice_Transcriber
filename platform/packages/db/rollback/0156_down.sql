-- 0156_down.sql - reverse the owner self-task switch.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0156_down.sql
--
-- Dropping the column returns every workspace to the pre-0156 rule: an owner
-- or manager may assign a task to themselves, with no switch. Nothing is lost -
-- the column only ever gated a write - but any tenant who had deliberately
-- turned it ON is indistinguishable from one that never looked, so note them
-- first if the intent matters:
--
--   SELECT id, name FROM organizations WHERE owner_self_tasks;

BEGIN;

ALTER TABLE organizations DROP COLUMN IF EXISTS owner_self_tasks;

DELETE FROM schema_migrations WHERE name = '0156_owner_self_tasks.sql';

COMMIT;
