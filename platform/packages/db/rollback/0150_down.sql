-- 0150_down.sql - reverse the phone alerts.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0150_down.sql
--
-- 0150 is additive: one table, one column with its trigger, five indexes.
-- Dropping `handset_alerts` discards the delivery receipts of manager messages
-- (who read what, when) - there is nowhere else they live. Phones already
-- holding an alert keep showing it; they simply get a 404 when they ack it,
-- which they treat as done.

BEGIN;

DROP TABLE IF EXISTS handset_alerts;

DROP TRIGGER IF EXISTS leads_assigned_at ON leads;
DROP FUNCTION IF EXISTS leads_stamp_assigned_at();
DROP INDEX IF EXISTS leads_assigned_recent;
ALTER TABLE leads DROP COLUMN IF EXISTS assigned_at;

DROP INDEX IF EXISTS task_assignees_assigned_recent;
DROP INDEX IF EXISTS tasks_created_recent;
DROP INDEX IF EXISTS tasks_due_at_open;
DROP INDEX IF EXISTS calls_missed_recent;

DELETE FROM schema_migrations WHERE name = '0150_handset_alerts.sql';

COMMIT;
