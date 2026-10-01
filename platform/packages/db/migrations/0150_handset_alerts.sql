-- 0150_handset_alerts.sql - put a lead, a task or a manager's message in front
-- of a telecaller ON THEIR PHONE, even with the app closed.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--
-- Until now the only thing the server could push to a handset was
-- `config_refresh` (and, during a shift, `presence_check`). Everything a
-- telecaller should act on - a lead routed to them, a task, a follow-up whose
-- time has come - went to the console bell, and the bell only reaches someone
-- signed in to the console. On a handset-only fleet that is nobody: lead
-- routing has been silently skipping the notification for every telecaller
-- without a login since 0094, which is most of them.
--
-- `handset_alerts` is keyed on the TELECALLER, because that is what a phone is
-- bound to. The worker raises rows for new leads, tasks, timed follow-ups and
-- missed calls on someone else's phone (handset-alerts.ts); an owner or
-- manager writes them by hand from the Phones page. Either way the worker
-- pushes `{action: "alert"}` and the phone fetches the text from
-- GET /devices/me/alerts - the push itself carries nothing a customer could be
-- identified by.
--
-- ── DELIVERED MEANS COLLECTED ───────────────────────────────────────────────
--
-- `delivered_at` is stamped when a phone reports it SHOWED the alert, not when
-- FCM accepted the push. FCM accepts pushes to phones that never wake (the
-- 2026-09-21 wake test), and a console that said "sent" for those would be
-- telling a manager their message arrived when it did not. Until a phone
-- collects it the worker keeps pushing on a backing-off ladder, up to
-- `expires_at`; after that the console says the phone was not reached.
--
-- ── leads.assigned_at ───────────────────────────────────────────────────────
--
-- "Which leads were just given to someone" had no answer: routing, the bulk
-- reassign, intake and imports all write `assigned_telecaller_id`, and none
-- of them records when. A trigger stamps it on every change, so all of those
-- paths - and any added later - are covered without touching one of them.
-- Existing assigned leads keep NULL: they were assigned before anyone was
-- tracking, and must not all pop up on the first sweep.

-- 1 ── leads.assigned_at ─────────────────────────────────────────────────────

ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_at timestamptz;

COMMENT ON COLUMN leads.assigned_at IS
  'When assigned_telecaller_id last changed (0150, stamped by trigger). NULL = unassigned, or assigned before 0150.';

CREATE OR REPLACE FUNCTION leads_stamp_assigned_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_telecaller_id IS NULL THEN
    NEW.assigned_at := NULL;
  ELSIF TG_OP = 'INSERT'
     OR NEW.assigned_telecaller_id IS DISTINCT FROM OLD.assigned_telecaller_id THEN
    NEW.assigned_at := now();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS leads_assigned_at ON leads;
CREATE TRIGGER leads_assigned_at
  BEFORE INSERT OR UPDATE OF assigned_telecaller_id ON leads
  FOR EACH ROW EXECUTE FUNCTION leads_stamp_assigned_at();

-- The sweep reads only the last few minutes of assignments.
CREATE INDEX IF NOT EXISTS leads_assigned_recent
  ON leads (assigned_at) WHERE assigned_at IS NOT NULL;

-- 2 ── the other sources' recent edges ───────────────────────────────────────

-- Task assignments, newest first (task_assignees had only a per-person index).
CREATE INDEX IF NOT EXISTS task_assignees_assigned_recent
  ON task_assignees (assigned_at);

-- Tasks a machine assigned (automation, missed-call call-backs) write only
-- `tasks.assignee_user_id`, so their creation time is their assignment time.
CREATE INDEX IF NOT EXISTS tasks_created_recent
  ON tasks (created_at);

-- Follow-ups with a time of day. Most tasks carry only `due_on`, so partial.
CREATE INDEX IF NOT EXISTS tasks_due_at_open
  ON tasks (due_at) WHERE status = 'open' AND due_at IS NOT NULL;

-- Missed calls (0133's NO_AUDIO rows), newest first.
CREATE INDEX IF NOT EXISTS calls_missed_recent
  ON calls (created_at) WHERE status = 'NO_AUDIO';

-- 3 ── handset_alerts ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS handset_alerts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- CASCADE: an alert for a telecaller who no longer exists is for nobody.
  telecaller_id  uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN (
                   'lead_assigned', 'task_assigned', 'followup_due',
                   'missed_callback', 'manager_message')),
  style          text NOT NULL CHECK (style IN ('popup', 'notify')),
  title          text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body           text CHECK (body IS NULL OR char_length(body) <= 600),
  -- What it is about. CASCADE: a deleted lead's popup has nothing to point at.
  lead_id        uuid REFERENCES leads(id) ON DELETE CASCADE,
  task_id        uuid REFERENCES tasks(id) ON DELETE CASCADE,
  call_id        uuid REFERENCES calls(id) ON DELETE CASCADE,
  -- A manager message: who sent it, and the send it was one recipient of.
  sent_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  batch_id       uuid,
  dedupe_key     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  -- The push ladder. `next_push_at` is when the worker may push again.
  push_attempts  int NOT NULL DEFAULT 0 CHECK (push_attempts >= 0),
  last_push_at   timestamptz,
  next_push_at   timestamptz NOT NULL DEFAULT now(),
  -- Receipts, from the phone. Opened implies delivered (the ack route sets both).
  delivered_at        timestamptz,
  delivered_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  opened_at           timestamptz,
  CHECK (opened_at IS NULL OR delivered_at IS NOT NULL),
  CHECK (kind <> 'manager_message' OR batch_id IS NOT NULL)
);

-- One alert per telecaller per fact. The sweep re-reads the same window every
-- tick; this, not a timestamp comparison, is what stops the repeat.
CREATE UNIQUE INDEX IF NOT EXISTS handset_alerts_dedupe
  ON handset_alerts (telecaller_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- The worker's push queue.
CREATE INDEX IF NOT EXISTS handset_alerts_push_due
  ON handset_alerts (next_push_at) WHERE delivered_at IS NULL;

-- The phone's fetch.
CREATE INDEX IF NOT EXISTS handset_alerts_pending
  ON handset_alerts (telecaller_id, created_at) WHERE delivered_at IS NULL;

-- The console's "Sent messages" list.
CREATE INDEX IF NOT EXISTS handset_alerts_batches
  ON handset_alerts (org_id, batch_id, created_at DESC) WHERE batch_id IS NOT NULL;

-- Retention.
CREATE INDEX IF NOT EXISTS handset_alerts_created
  ON handset_alerts (created_at);

-- 4 ── RLS AND GRANTS ───────────────────────────────────────────────────────
--
-- Org-scoped, so the standard tenant policy applies and verify-rls passes with
-- no allowlist entry. REVOKE before GRANT: a GRANT-only migration narrows
-- nothing where the Supabase API roles can already reach the schema (0075,
-- 0081, 0089, 0145).

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['handset_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    END IF;
  END LOOP;
END $$;
