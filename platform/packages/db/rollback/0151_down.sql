-- 0151_down.sql - reverse call escalations.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0151_down.sql
--
-- Dropping the two tables discards every escalation and its history - there
-- is nowhere else they live. The bell rows and phone alerts that mention them
-- are DELETED first, because the narrowed CHECKs below would otherwise refuse
-- to go back on. The audit_log rows are kept.

BEGIN;

DELETE FROM notifications WHERE kind IN ('call_escalated', 'call_escalation_update');
DELETE FROM handset_alerts WHERE kind IN ('escalation_received', 'escalation_update');

ALTER TABLE handset_alerts DROP CONSTRAINT IF EXISTS handset_alerts_kind_check;
ALTER TABLE handset_alerts ADD CONSTRAINT handset_alerts_kind_check
  CHECK (kind IN ('lead_assigned', 'task_assigned', 'followup_due',
                  'missed_callback', 'manager_message'));

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
                  'export_created'));

DROP TABLE IF EXISTS call_escalation_events;
DROP TABLE IF EXISTS call_escalations;

DROP TRIGGER IF EXISTS telecallers_escalate_to_guard ON telecallers;
DROP FUNCTION IF EXISTS telecaller_escalate_to_guard();
ALTER TABLE telecallers DROP COLUMN IF EXISTS escalate_to_membership_id;

ALTER TABLE memberships DROP COLUMN IF EXISTS escalation_senior;
ALTER TABLE organizations DROP COLUMN IF EXISTS call_escalation_enabled;

DELETE FROM schema_migrations WHERE name = '0151_call_escalations.sql';

COMMIT;
