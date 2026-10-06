-- 0154_down.sql - reverse the lead archive.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0154_down.sql
--
-- Dropping `archived_at` makes every archived lead reappear in the list and on
-- the board. Nothing is lost - archiving never removed anything - but a tenant
-- who had put a hundred leads away gets them all back in their pipeline, so
-- count them first:
--
--   SELECT org_id, count(*) FROM leads WHERE archived_at IS NOT NULL GROUP BY 1;

BEGIN;

DROP INDEX IF EXISTS leads_org_stage_live;
DROP INDEX IF EXISTS leads_org_activity_live;
DROP INDEX IF EXISTS leads_org_archived;

ALTER TABLE leads DROP COLUMN IF EXISTS archived_by;
ALTER TABLE leads DROP COLUMN IF EXISTS archived_at;

DELETE FROM schema_migrations WHERE name = '0154_lead_archive.sql';

COMMIT;
