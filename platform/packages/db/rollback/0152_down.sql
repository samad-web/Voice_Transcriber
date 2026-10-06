-- 0152_down.sql - reverse the invite-accepted notification.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0152_down.sql
--
-- The bell rows are DELETED first, because the narrowed CHECK below would
-- otherwise refuse to go back on. Nothing else is lost: `org_invites` already
-- records who accepted and when, and the audit_log rows are kept.

BEGIN;

DELETE FROM notifications WHERE kind = 'invite_accepted';

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
                  'call_escalation_update'));

DELETE FROM schema_migrations WHERE name = '0152_invite_accepted_notification.sql';

COMMIT;
