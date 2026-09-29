-- 0143: tell a manager when a telecaller never started their shift, in the
-- workspace's own words.
--
-- 0140 detects absence perfectly well - `attendance_days.status` has said
-- 'absent' since it shipped - and then tells nobody. The live board shows it
-- to whoever is looking at the live board. A manager on the road finds out at
-- the end of the day, from a timesheet.
--
-- This adds the alert, and makes its WORDING the workspace's. The trigger
-- stays ours: it fires from the shift pattern and its grace period, which are
-- already the rules the workspace set (doc 33 §3).
--
-- Three changes, no new tables:
--   1. organizations.attendance_absent_message - the chosen wording, NULL for
--      "use the default". Ten presets ship in @aura/shared, not here: they are
--      copy, they will be reworded, and a migration is a bad place to keep
--      anything that gets reworded.
--   2. attendance_whatsapp_outbox learns a second SUBJECT. It was built around
--      a request row; an absence has no request.
--   3. one more notification kind.

-- ── 1. The wording ──────────────────────────────────────────────────────────
--
-- Bounded here as well as in the API. The API's limit is the one a person
-- sees; this one is the one that holds when somebody writes to the database by
-- another route, which on this product has happened.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS attendance_absent_message text;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_attendance_absent_message_len;
ALTER TABLE organizations ADD CONSTRAINT organizations_attendance_absent_message_len
  CHECK (attendance_absent_message IS NULL OR char_length(attendance_absent_message) <= 600);

COMMENT ON COLUMN organizations.attendance_absent_message IS
  'Wording for the shift-not-started alert. NULL = the default preset in @aura/shared.';

-- ── 2. The outbox gets a second subject ─────────────────────────────────────
--
-- `request_id` was NOT NULL and the only identity a row had. An absence is
-- about a PERSON on a DATE, so both are added and the pair carries the
-- identity instead.
--
-- The 0140 unique key `(request_id, recipient_membership_id, reason)` cannot
-- do that job even once request_id is nullable: in Postgres two NULLs are
-- distinct, so every absence row would be unique and a sweep that ran twice
-- would message the manager twice. Hence the second, partial unique index -
-- and the first one is left exactly as it is, still guarding requests.

ALTER TABLE attendance_whatsapp_outbox ALTER COLUMN request_id DROP NOT NULL;

ALTER TABLE attendance_whatsapp_outbox
  ADD COLUMN IF NOT EXISTS telecaller_id uuid REFERENCES telecallers(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS work_date date,
  -- The already-rendered text, written when the row is queued.
  --
  -- A request row builds its sentence at SEND time from the request, which is
  -- right there: the wording is ours and cannot have changed. An absence
  -- cannot do that. Re-rendering would mean re-resolving the shift pattern
  -- hours later, and if somebody edited the wording in between, the WhatsApp
  -- message and the console notification about the SAME event would differ -
  -- which is exactly the kind of thing that makes a manager stop believing
  -- either of them.
  ADD COLUMN IF NOT EXISTS message text;

ALTER TABLE attendance_whatsapp_outbox DROP CONSTRAINT IF EXISTS attendance_whatsapp_outbox_reason;
ALTER TABLE attendance_whatsapp_outbox ADD CONSTRAINT attendance_whatsapp_outbox_reason
  CHECK (reason IN ('new_request', 'escalation', 'absent'));

-- Each reason carries the columns its sender reads, and no others. Without
-- this an 'absent' row with a NULL telecaller_id would sit in the queue and
-- fail on every attempt until it exhausted its retries.
ALTER TABLE attendance_whatsapp_outbox DROP CONSTRAINT IF EXISTS attendance_whatsapp_outbox_subject;
ALTER TABLE attendance_whatsapp_outbox ADD CONSTRAINT attendance_whatsapp_outbox_subject
  CHECK (
    CASE WHEN reason = 'absent'
      THEN request_id IS NULL AND telecaller_id IS NOT NULL AND work_date IS NOT NULL
           AND message IS NOT NULL AND btrim(message) <> ''
      ELSE request_id IS NOT NULL AND telecaller_id IS NULL AND work_date IS NULL
    END
  );

CREATE UNIQUE INDEX IF NOT EXISTS attendance_whatsapp_outbox_absent_once
  ON attendance_whatsapp_outbox (telecaller_id, work_date, recipient_membership_id)
  WHERE reason = 'absent';

-- ── 3. The notification kind ────────────────────────────────────────────────
--
-- Re-added in full, the 0135/0140 way. Kept in lockstep with NotificationKind
-- in @aura/shared (notification-kinds.test.ts) - the two have drifted before
-- and the symptom is a 23514 at the moment of writing the notification, long
-- after the code that caused it was reviewed.

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
                  -- 0140: attendance (doc 33).
                  'attendance_request',
                  'attendance_break_overrun',
                  'attendance_away',
                  'attendance_review',
                  -- 0143: never started the shift.
                  'attendance_absent'));
