-- 0153_down.sql - put 0140's reports-to guard back, null persona and all.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0153_down.sql
--
-- NOTE what going back costs: any telecaller whose `reports_to_membership_id`
-- points at a membership with a NULL persona keeps that value (this only
-- restores the guard, it does not re-validate existing rows), but the next
-- UPDATE of that column on such a row will start raising 23514 again.

BEGIN;

CREATE OR REPLACE FUNCTION telecaller_reports_to_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.reports_to_membership_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.id = NEW.reports_to_membership_id
       AND m.org_id = NEW.org_id
       AND m.owner_role IN ('owner', 'manager')
  ) THEN
    RAISE EXCEPTION 'a telecaller can only report to an owner or manager of the same workspace'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

DELETE FROM schema_migrations WHERE name = '0153_owner_persona_null_approvers.sql';

COMMIT;
