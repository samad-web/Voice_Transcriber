-- 0048_notifications.sql — telling a person something happened.
--
-- The CRM has been able to assign work since A3 and has had no way to say so.
-- A manager assigns a follow-up to a rep, the row is written correctly, and
-- the rep finds out when they next happen to open the tasks page. That is a
-- to-do list, not a system of record — and Layer 2's rule engine makes it
-- worse, because a rule that fires silently is indistinguishable from a rule
-- that never fired.
--
-- IN-APP ONLY, deliberately. No email, no SMS, no push. Everything in this
-- table is visible only to somebody who has already signed in to the console,
-- so nothing here can reach a person who is not looking — which keeps
-- notifications out of the risk class that outbound mail lives in, and out of
-- the "an automated sender put something in front of a real customer"
-- failure mode entirely. If a digest email is wanted later, it is a separate
-- decision with a separate consent question, not a flag on this table.

CREATE TABLE IF NOT EXISTS notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Who it is for. CASCADE: a removed user's unread notifications are not
  -- something anyone needs to keep.
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- task_assigned | task_due | deal_stage_changed | deal_idle | automation
  -- App-validated, like every other small open set in this schema.
  kind         text NOT NULL,
  title        text NOT NULL,
  body         text,

  -- Where clicking it should go. A relative path, validated app-side; an
  -- absolute URL here would make every notification a potential redirect out
  -- of the console.
  link_path    text,

  -- What it is about, so the row survives being read out of context and so a
  -- future "show me everything about this deal" can find it.
  deal_id      uuid REFERENCES deals(id) ON DELETE CASCADE,
  contact_id   uuid REFERENCES contacts(id) ON DELETE CASCADE,
  task_id      uuid REFERENCES tasks(id) ON DELETE CASCADE,

  -- The idempotency key, and the reason this table can be written from a
  -- SWEEP rather than only from an event. "This task is overdue" is a
  -- condition that stays true every time the sweep runs; without a dedupe key
  -- the rep would get the same notice every ten minutes until they act on it,
  -- which trains people to ignore the bell. Nullable, because an
  -- event-triggered notification ("Priya replied") is a distinct occurrence
  -- every time and should not be collapsed.
  dedupe_key   text,

  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One notification per (user, dedupe_key). Partial, so un-keyed rows are
-- unconstrained — the same shape as interactions_call and deals(source_lead_id).
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe
  ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- "My unread ones, newest first" — the bell's only query.
CREATE INDEX IF NOT EXISTS notifications_user_unread
  ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_user_all
  ON notifications (user_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON notifications
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON notifications FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON notifications FROM PUBLIC;

-- NOTE ON RLS AND PER-USER SCOPING. The policy above is the ORG boundary,
-- which is all RLS has ever enforced in this schema. "Only my own
-- notifications" is a second, narrower question, and it is answered in the
-- controller by a `user_id = <caller>` predicate on every query — the same
-- place `tasks?mine=1` answers it. Putting a user predicate in the policy
-- would break every legitimate cross-user write (a manager assigning work
-- notifies someone else) and would be the first policy in this database to
-- depend on a setting nothing currently sets.
