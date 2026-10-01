-- 0151_call_escalations.sql - a telecaller hands a call up to a senior or a
-- manager (Build docs/38).
--
-- ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
--
-- Inside the business only. A telecaller who cannot settle a call - the
-- customer wants a senior, a discount needs approval, a question they cannot
-- answer - presses "Escalate" on that call, from the phone or from the console,
-- and it lands with the person they escalate to. That person picks it up,
-- answers it, or passes it further up.
--
-- NOT `call_issue_reports` (0147). That is a CLIENT telling the VENDOR the
-- product got a call wrong, and it ends on the platform's support board. This
-- never leaves the tenant: every row, recipient and alert below belongs to one
-- org, and no platform operator reads it.
--
-- ── OFF UNTIL THE OWNER TURNS IT ON ─────────────────────────────────────────
--
-- `organizations.call_escalation_enabled` defaults false, and only an OWNER may
-- flip it (API-side). While it is false the phone is sent no escalation block,
-- the console shows no Escalate button and no Escalations page, and the API
-- refuses a new escalation outright - the user's words were "if they did not,
-- we must not show this option; they must handle it". Escalations already open
-- when it is switched off stay answerable, so turning it off strands nobody.
--
-- ── WHO RECEIVES IT ─────────────────────────────────────────────────────────
--
-- Resolved when the escalation is raised, and stored, so a later change of
-- routing does not move an escalation somebody is already looking at (the
-- attendance_requests rule, 0140):
--
--   1. `telecallers.escalate_to_membership_id`, if that person may still
--      receive escalations - an owner, a manager, or a member marked
--      `escalation_senior`;
--   2. else `telecallers.reports_to_membership_id` (0140), if it is an active
--      owner or manager;
--   3. else NULL: every active owner and manager.
--
-- A senior is a member with a console login - receiving an escalation means
-- opening the call and answering it, which a phone alone cannot do. The flag
-- is meaningful for the telecaller and sales personas; owners and managers
-- always qualify.

-- ── Workspace switch ────────────────────────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS call_escalation_enabled boolean NOT NULL DEFAULT false;

-- ── Seniors ─────────────────────────────────────────────────────────────────

ALTER TABLE memberships
  ADD COLUMN IF NOT EXISTS escalation_senior boolean NOT NULL DEFAULT false;

-- ── Who a telecaller escalates to ───────────────────────────────────────────
--
-- Separate from `reports_to_membership_id` on purpose. That column is the
-- APPROVER of a telecaller's leave, and only an owner or manager may approve
-- leave; a call can go to a senior colleague. One column doing both would
-- either let a senior approve leave or stop a call reaching a senior.

ALTER TABLE telecallers
  ADD COLUMN IF NOT EXISTS escalate_to_membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION telecaller_escalate_to_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.escalate_to_membership_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.id = NEW.escalate_to_membership_id
       AND m.org_id = NEW.org_id
       -- NULL is the pre-persona owner, the resolveOwnerRole rule.
       AND (COALESCE(m.owner_role, 'owner') IN ('owner', 'manager') OR m.escalation_senior)
       -- Escalating to yourself is not escalating.
       AND (NEW.user_id IS NULL OR m.user_id <> NEW.user_id)
  ) THEN
    RAISE EXCEPTION 'a telecaller can only escalate to an owner, a manager or a senior of the same workspace, and not to themselves'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS telecallers_escalate_to_guard ON telecallers;
CREATE TRIGGER telecallers_escalate_to_guard
  BEFORE INSERT OR UPDATE OF escalate_to_membership_id ON telecallers
  FOR EACH ROW EXECUTE FUNCTION telecaller_escalate_to_guard();

-- ── call_escalations ────────────────────────────────────────────────────────
--
-- The telecaller's own words plus who has it. No transcript, summary or audio
-- is copied in: whoever opens the escalation reads the call through the
-- call's own routes and their own `recordings_listen`, so this table cannot
-- become a way round either.

CREATE TABLE IF NOT EXISTS call_escalations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id                 uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  -- Who raised it: the telecaller the call belongs to. CASCADE for the reason
  -- handset_alerts gives - an escalation from nobody is about nothing.
  telecaller_id           uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,
  reason                  text NOT NULL CHECK (reason IN (
                            'wants_senior', 'price_approval', 'complaint',
                            'cant_answer', 'hot_lead', 'other')),
  note                    text,
  status                  text NOT NULL DEFAULT 'open' CHECK (status IN (
                            'open', 'acknowledged', 'resolved', 'withdrawn')),
  -- NULL = every active owner and manager (see the header).
  assigned_membership_id  uuid REFERENCES memberships(id) ON DELETE SET NULL,
  source                  text NOT NULL CHECK (source IN ('device', 'console')),
  device_id               uuid REFERENCES devices(id) ON DELETE SET NULL,
  raised_by_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The handset's own id for the escalation, so a press that is retried after
  -- a lost response is stored once.
  client_ref              text,
  acknowledged_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at         timestamptz,
  resolved_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at             timestamptz,
  resolution_note         text,
  forward_count           smallint NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_escalations_note_len CHECK (note IS NULL OR char_length(note) <= 500),
  -- "Something else" has to say what.
  CONSTRAINT call_escalations_other_has_note CHECK (
    reason <> 'other' OR (note IS NOT NULL AND char_length(btrim(note)) > 0)),
  CONSTRAINT call_escalations_resolution_len CHECK (
    resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  CONSTRAINT call_escalations_resolved_shape CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT call_escalations_ack_shape CHECK (status <> 'acknowledged' OR acknowledged_at IS NOT NULL),
  CONSTRAINT call_escalations_resolution_only_when_resolved CHECK (
    resolution_note IS NULL OR status = 'resolved'),
  CONSTRAINT call_escalations_forward_count CHECK (forward_count BETWEEN 0 AND 50),
  CONSTRAINT call_escalations_client_ref_len CHECK (client_ref IS NULL OR char_length(client_ref) BETWEEN 8 AND 80)
);

-- One live escalation per call. A second press while one is open is the same
-- escalation, not a new one; the API returns the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS call_escalations_live
  ON call_escalations (call_id) WHERE status IN ('open', 'acknowledged');

CREATE UNIQUE INDEX IF NOT EXISTS call_escalations_client_ref
  ON call_escalations (org_id, device_id, client_ref) WHERE client_ref IS NOT NULL;

-- The console queue.
CREATE INDEX IF NOT EXISTS call_escalations_queue
  ON call_escalations (org_id, status, created_at DESC);

-- "Assigned to me".
CREATE INDEX IF NOT EXISTS call_escalations_assignee
  ON call_escalations (assigned_membership_id, status) WHERE assigned_membership_id IS NOT NULL;

-- The latest escalation on a call - the lead drawer reads it for every call in
-- a history of up to 50, and the live index above covers only open ones.
CREATE INDEX IF NOT EXISTS call_escalations_call
  ON call_escalations (call_id, created_at DESC);

-- "Raised by me", the phone's list and the per-telecaller ceiling.
CREATE INDEX IF NOT EXISTS call_escalations_telecaller
  ON call_escalations (org_id, telecaller_id, created_at DESC);

-- ── call_escalation_events ──────────────────────────────────────────────────
--
-- The history: raised, picked up, passed up (and to whom), answered, withdrawn.
-- Names are frozen at write time, so the history still reads after somebody
-- leaves. `to_membership_id` NULL with `to_name` set means "every owner and
-- manager"; both NULL means the event has no recipient.

CREATE TABLE IF NOT EXISTS call_escalation_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  escalation_id     uuid NOT NULL REFERENCES call_escalations(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN (
                      'raised', 'acknowledged', 'forwarded', 'resolved', 'withdrawn')),
  actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_name        text NOT NULL CHECK (char_length(actor_name) BETWEEN 1 AND 200),
  to_membership_id  uuid REFERENCES memberships(id) ON DELETE SET NULL,
  to_name           text CHECK (to_name IS NULL OR char_length(to_name) <= 200),
  note              text CHECK (note IS NULL OR char_length(note) <= 1000),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_escalation_events_escalation
  ON call_escalation_events (escalation_id, created_at);

-- ── Row-level security, grants, triggers - the tenant pattern ───────────────
--
-- Org-scoped, so the standard policy applies and verify-rls needs no allowlist
-- entry. REVOKE before GRANT (see 0150's note).

DO $do$
DECLARE
  t text;
  api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['call_escalations', 'call_escalation_events'] LOOP
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

  BEGIN
    CREATE TRIGGER call_escalations_set_updated_at
      BEFORE UPDATE ON call_escalations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $do$;

-- ── Notification kinds ──────────────────────────────────────────────────────
--
-- Rewritten WHOLESALE, as every migration that adds a kind does, in lockstep
-- with NotificationKind in @aura/shared and NOTIFICATION_KINDS in the console
-- (notification-kinds.test.ts reads the LAST check in apply order).
--   call_escalated          - to whoever an escalation now sits with.
--   call_escalation_update  - to the telecaller's login, when it is answered.

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
                  'attendance_absent',
                  -- 0147: we answered a problem you reported (doc 36).
                  'call_issue_update',
                  -- 0148: the data export engine (doc 35).
                  'export_ready',
                  'export_failed',
                  'export_created',
                  -- 0151: call escalations (doc 38).
                  'call_escalated',
                  'call_escalation_update'));

-- ── Phone alert kinds ───────────────────────────────────────────────────────
--
-- 0150 declared this CHECK inline, so it is found by catalog and replaced with
-- a NAMED one, which the next widening can drop by name. Kept in lockstep with
-- HandsetAlertKind in @aura/shared (call-escalations.test.ts).
--   escalation_received - on the phone of a recipient who also has one.
--   escalation_update   - on the raiser's phone, when it is answered.

DO $do$
DECLARE con text;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
     WHERE t.relname = 'handset_alerts' AND c.contype = 'c' AND a.attname = 'kind'
       AND c.conkey = ARRAY[a.attnum]
  LOOP
    EXECUTE format('ALTER TABLE handset_alerts DROP CONSTRAINT %I', con);
  END LOOP;
END $do$;

ALTER TABLE handset_alerts ADD CONSTRAINT handset_alerts_kind_check
  CHECK (kind IN ('lead_assigned', 'task_assigned', 'followup_due',
                  'missed_callback', 'manager_message',
                  -- 0151: call escalations (doc 38).
                  'escalation_received', 'escalation_update'));
