-- 0135_task_assignees.sql - a task can be given to several people, and each of
-- them says yes or no to it.
--
-- ── WHY A TABLE, AND WHY `tasks.assignee_user_id` STAYS ─────────────────────
--
-- Until now a task had one assignee column and no way to ask whether that
-- person had agreed to do it: "I gave it to Ravi" and "Ravi knows he has it"
-- were the same fact, and the first anyone learned otherwise was the overdue
-- reminder. This table holds one row per person asked, with their answer.
--
-- `tasks.assignee_user_id` is kept as the PRIMARY assignee - the first person
-- still on the task. Reminders, the SLA and compliance reports, the owned
-- record scope and the worker's automation all read that column, and moving
-- every one of them onto a join in the same change is how a follow-up stops
-- reminding anybody. The API keeps the two in step (tasks.controller.ts);
-- when the primary declines, the next person still on the task becomes it.
--
-- A task with an assignee and NO rows here - everything created before this
-- migration is backfilled, but the worker's automation and missed-call sweeps
-- still write the column alone - reads as that one person, already accepted.
-- Work a machine routed was never "offered", so there is nobody to ask.
--
-- ── WHAT `pending` DOES AND DOES NOT DO ─────────────────────────────────────
--
-- It is visibility, not a lock. A pending task is on the person's list and in
-- the bell with Accept / Decline beside it; nothing stops them working it
-- first. Declining takes them off it and tells whoever created the task.

CREATE TABLE IF NOT EXISTS task_assignees (
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id        uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- CASCADE, not SET NULL: a row with no person is not an answer from anyone.
  -- `tasks.assignee_user_id` already SETs NULL on user delete, returning the
  -- work itself to the shared queue.
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'declined')),
  assigned_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  responded_at   timestamptz,
  decline_reason text CHECK (decline_reason IS NULL OR char_length(decline_reason) <= 500),
  PRIMARY KEY (task_id, user_id)
);

-- "What is waiting for my answer" - the Tasks page's banner and the ?who=awaiting filter.
CREATE INDEX IF NOT EXISTS task_assignees_user_status
  ON task_assignees (org_id, user_id, status);

ALTER TABLE task_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_assignees FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON task_assignees
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON task_assignees TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON task_assignees FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON task_assignees FROM PUBLIC;

-- Every existing assignment was made before anybody could be asked, so it
-- stands as accepted - pending would drop a banner on every rep's list for
-- work they have been doing for weeks.
INSERT INTO task_assignees (org_id, task_id, user_id, status, assigned_by, assigned_at, responded_at)
SELECT t.org_id, t.id, t.assignee_user_id, 'accepted', t.created_by, t.created_at, t.created_at
  FROM tasks t
 WHERE t.assignee_user_id IS NOT NULL
ON CONFLICT (task_id, user_id) DO NOTHING;

-- ── task_response: the creator hears the answer ─────────────────────────────
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
                  -- 0135: somebody accepted or declined a task you gave them.
                  'task_response'));

-- ── A staff member's WhatsApp number ────────────────────────────────────────
--
-- Beside 0102's `phone`, not instead of it. For most of a floor the two are
-- the same number - the Add someone form mirrors one into the other with a
-- tick - but a rep who calls from a work SIM and chats from a personal one is
-- common enough that one column would force somebody to pick which is wrong.
-- Clear text for the same reason `phone` is: the tenant's own employee,
-- entered by their own manager.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS whatsapp_number text;
