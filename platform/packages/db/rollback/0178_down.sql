-- 0178_down.sql - reverse the org chart module in full (0177 + 0178).
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0178_down.sql
--
-- ── ONE FILE FOR TWO MIGRATIONS, AND WHY ────────────────────────────────────
--
-- 0177 and 0178 are one module. `employment_contracts.position_id` points back
-- into 0177's `positions`, and `positions`/`teams` reference each other, so
-- there is no order in which 0177 can be dropped while 0178 is still present.
-- A per-migration file would be two files, one of which only works if the
-- other has already run.
--
-- ── READ THIS FIRST: WHAT CANNOT BE RECONSTRUCTED ───────────────────────────
--
-- `org_change_log` is the append-only record of every reorganization - who
-- moved which seat, on what effective date, and why. §16's as-of view is
-- reproducible only from it. Nothing else in the schema holds it: `audit_log`
-- has the actor and the action but not `effective_date` or the before/after
-- pair, which is the whole reason the table exists.
--
-- `document_access_log` is the record of who read whose contract. It is the
-- artefact an audit asks for and the one thing that cannot be re-derived from
-- anything at all.
--
-- Keep them, before anything else:
--
--   \copy (SELECT * FROM org_change_log)       TO 'org_change_log.csv'   CSV HEADER
--   \copy (SELECT * FROM document_access_log)  TO 'doc_access_log.csv'   CSV HEADER
--   \copy (SELECT * FROM employment_contracts) TO 'contracts.csv'        CSV HEADER
--   \copy (SELECT * FROM positions)            TO 'positions.csv'        CSV HEADER
--   \copy (SELECT * FROM reporting_lines)      TO 'reporting_lines.csv'  CSV HEADER
--   \copy (SELECT * FROM position_assignments) TO 'assignments.csv'      CSV HEADER
--
-- ── WHAT THIS DOES NOT TOUCH ────────────────────────────────────────────────
--
-- The CONTRACT DOCUMENTS THEMSELVES, in object storage. `contract_documents`
-- holds `s3_key`, and dropping the table orphans every object rather than
-- deleting it. That is the deliberate choice - a rollback that destroyed
-- somebody's signed paperwork would be unrecoverable - but it means the
-- objects stay in the bucket and are no longer reachable from the
-- application. Export the keys first if they matter:
--
--   \copy (SELECT id, contract_id, s3_key, file_name FROM contract_documents) TO 'doc_keys.csv' CSV HEADER
--
-- `notifications` rows of the four org-chart kinds are left in place. The
-- CHECK is narrowed at the end of this file, which would REFUSE a new row of
-- those kinds but does not validate existing ones - so the restore is not
-- blocked by a notification somebody has already read. If the deploy is being
-- reverted rather than the module removed, delete them first:
--
--   DELETE FROM notifications
--    WHERE kind IN ('position_vacant', 'reporting_change', 'contract_expiring', 'probation_ending');

BEGIN;

-- 0178's tables first: `employment_contracts` references `positions`.
DROP TABLE IF EXISTS document_access_log;
DROP TABLE IF EXISTS contract_documents;
DROP TABLE IF EXISTS employment_contracts;

-- The forward reference between `positions` and `teams`, broken before either
-- is dropped.
ALTER TABLE IF EXISTS positions DROP CONSTRAINT IF EXISTS positions_team_id_fkey;

DROP TABLE IF EXISTS org_change_log;
DROP TABLE IF EXISTS org_chart_settings;
DROP TABLE IF EXISTS position_kpi_defaults;
DROP TABLE IF EXISTS position_skills;
DROP TABLE IF EXISTS position_authorities;
DROP TABLE IF EXISTS position_responsibilities;
DROP TABLE IF EXISTS position_assignments;
-- Drops the trigger with it.
DROP TABLE IF EXISTS reporting_lines;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS positions;
DROP TABLE IF EXISTS departments;

DROP FUNCTION IF EXISTS org_chart_assert_acyclic();

-- The grid rows. Left behind, these would go on granting an object no route
-- serves - harmless, but the permissions screen would show two objects that
-- are not there, which is how a role looks configured and does nothing.
DELETE FROM role_permissions WHERE object_type IN ('position', 'employment_contract');

-- The CHECK, back to 0152's list. Narrowing it does not validate rows already
-- in the table (see the header), so this blocks new writes only.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'task_due', 'deal_stage_changed', 'deal_idle',
                  'automation', 'report_ready', 'lead_assigned',
                  'opt_out_requested', 'channel_needs_attention',
                  'sla_breach', 'review_pending',
                  'call_access_requested',
                  'storage_quota',
                  'missed_call',
                  'task_response',
                  'attendance_request',
                  'attendance_break_overrun',
                  'attendance_away',
                  'attendance_review',
                  'attendance_absent',
                  'call_issue_update',
                  'export_ready',
                  'export_failed',
                  'export_created',
                  'call_escalated',
                  'call_escalation_update',
                  'invite_accepted'));

DELETE FROM schema_migrations
 WHERE name IN ('0177_org_chart_foundations.sql', '0178_org_chart_contracts.sql');

COMMIT;
