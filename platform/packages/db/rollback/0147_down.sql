-- 0147_down.sql - reverse the call-issue escalation tables.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0147_down.sql
--
-- ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
--
-- 0147 is purely additive: two new tables and one widened CHECK. Nothing it did
-- can corrupt existing data, so this file exists for one situation only - the
-- feature is withdrawn before any customer has used it, and we would rather not
-- leave two empty tables and an unreachable notification kind standing.
--
-- ── READ THIS BEFORE RUNNING IT ─────────────────────────────────────────────
--
-- This DROPS customer complaints. Every report a tenant filed, every reply they
-- wrote and every answer we gave goes with the tables. There is no version of
-- this that keeps them, because the rows have nowhere else to live.
--
-- So: only run it when `SELECT count(*) FROM call_issue_reports` is 0, or when
-- you have exported what is there and can say where the export went. The guard
-- below refuses outright if the table has rows; delete the RAISE if you truly
-- mean to discard them.
--
-- ── WHAT IT DELIBERATELY LEAVES STANDING ────────────────────────────────────
--
--   * `audit_log` rows for `call_issue.filed` / `.resolved`. That is the
--     tenant's own compliance record of what happened, it is append-only by
--     design, and a rollback of our feature is not a reason to edit their
--     history.
--   * Any `notifications` row already written with kind 'call_issue_update'.
--     The CHECK is restored to 0143's list, which would REFUSE new rows of that
--     kind - but a CHECK is not re-validated against existing rows on ADD unless
--     you ask, so the constraint below is added NOT VALID-free on purpose: if
--     any such row exists, the ADD fails loudly and you must delete those rows
--     first. Better a failed rollback than a table that silently disagrees with
--     its own constraint.
--   * The reprocess route this migration's feature replaced. Restoring
--     `POST /owner/calls/:id/reprocess` is a code change (doc 36 §2), not a SQL
--     one, and doing half of it here would leave the product in a state no
--     commit describes.

DO $$
DECLARE n bigint;
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'call_issue_reports') THEN
    EXECUTE 'SELECT count(*) FROM call_issue_reports' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'refusing to drop % call issue report(s) - export them first, then delete this guard', n;
    END IF;
  END IF;
END $$;

-- Events first: it references the reports table.
DROP TABLE IF EXISTS call_issue_events;
DROP TABLE IF EXISTS call_issue_reports;

-- Restore 0143's kind list exactly. Anything still holding
-- 'call_issue_update' makes this statement fail, which is the intent.
DO $do$
DECLARE con text;
BEGIN
  SELECT c.conname INTO con
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
   WHERE t.relname = 'notifications' AND c.contype = 'c' AND a.attname = 'kind'
     AND c.conkey = ARRAY[a.attnum];
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', con);
  END IF;
END $do$;

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
                  'attendance_absent'));
