-- 0140_attendance.sql - shifts, breaks, leave, handset presence and the
-- attendance timesheet (Build docs/33).
--
-- ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
--
-- Information, not payroll (doc 33 §12 Q3, decided 2026-09-25). Nothing here
-- deducts, locks a month, or counts leave against a balance. That is why the
-- classifier may excuse a technical gap on its own evidence, and why there is
-- no leave-balance table: an allowance nobody is paid against is a number that
-- only generates arguments.
--
-- ── PRESENCE COMES FROM CALL ACTIVITY, NOT AUDIO ────────────────────────────
--
-- The handset cannot hear the incoming side of a call on this fleet (doc 33
-- §2): Samsung phones leave the recording to the phone's own recorder. So the
-- phone reports its own state machine - active, in call, prompting, away,
-- technical, on break - as `presence_events`, and the worker turns those into
-- `attendance_segments` and `attendance_days`. Audio contributes only after the
-- fact, as `call_audio_quality` numbers from uploaded recordings.
--
-- ── OFF UNTIL SOMEBODY TURNS IT ON ──────────────────────────────────────────
--
-- `organizations.attendance_enabled` defaults false. While it is false the
-- device config carries no attendance block and the handset behaves exactly as
-- 1.1.x did. The two per-telecaller app switches default false as well, and so
-- does the WhatsApp alert toggle, which only an OWNER may turn on (API-side).

-- ── Workspace switches ──────────────────────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS attendance_enabled boolean NOT NULL DEFAULT false,
  -- Hours a leave request waits with the telecaller's manager before the
  -- owners are told as well (doc 33 §6.3). The "2 h before the leave starts"
  -- floor is applied in code, not here.
  ADD COLUMN IF NOT EXISTS leave_escalation_hours smallint NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS attendance_whatsapp_alerts boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attendance_whatsapp_channel_id uuid
    REFERENCES messaging_channels(id) ON DELETE SET NULL;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_leave_escalation_hours_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_leave_escalation_hours_check
  CHECK (leave_escalation_hours BETWEEN 1 AND 168);

-- The alert is sent FROM the workspace's own business number - never from a
-- personal channel (private to one person since 0125) and never from another
-- org's. Checked by trigger because a CHECK cannot look at another table.
CREATE OR REPLACE FUNCTION attendance_whatsapp_channel_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.attendance_whatsapp_channel_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM messaging_channels c
     WHERE c.id = NEW.attendance_whatsapp_channel_id
       AND c.org_id = NEW.id
       AND c.channel = 'whatsapp'
       AND c.provider IN ('waba', 'wasi')
       AND c.owner_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'attendance alerts must use this workspace''s own WhatsApp Business channel'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS organizations_attendance_whatsapp_channel_guard ON organizations;
CREATE TRIGGER organizations_attendance_whatsapp_channel_guard
  BEFORE INSERT OR UPDATE OF attendance_whatsapp_channel_id ON organizations
  FOR EACH ROW EXECUTE FUNCTION attendance_whatsapp_channel_guard();

-- ── Who a telecaller reports to, and what they may do from the phone ────────
--
-- Nothing recorded a reporting line before this. `reports_to_membership_id`
-- is the approver for that telecaller's leave (doc 33 §6.3); NULL means every
-- active owner. The two switches follow memberships.can_pair_devices (0107):
-- off until a manager turns them on for that one person.

ALTER TABLE telecallers
  ADD COLUMN IF NOT EXISTS reports_to_membership_id uuid REFERENCES memberships(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS app_leave_requests boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS app_break_booking boolean NOT NULL DEFAULT false;

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

DROP TRIGGER IF EXISTS telecallers_reports_to_guard ON telecallers;
CREATE TRIGGER telecallers_reports_to_guard
  BEFORE INSERT OR UPDATE OF reports_to_membership_id ON telecallers
  FOR EACH ROW EXECUTE FUNCTION telecaller_reports_to_guard();

-- ── Shift patterns ──────────────────────────────────────────────────────────
--
-- Wall times in the workspace zone (doc 30 R5), turned into instants per date
-- by `resolveAttendanceDay` in @aura/shared. `end_time < start_time` is a shift
-- that crosses midnight; it belongs to the day it starts.

CREATE TABLE IF NOT EXISTS shift_patterns (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                      text NOT NULL,
  work_days                 smallint[] NOT NULL,
  start_time                time NOT NULL,
  end_time                  time NOT NULL,
  grace_minutes             smallint NOT NULL DEFAULT 10,
  break_allowance_minutes   smallint NOT NULL DEFAULT 60,
  silence_threshold_minutes smallint NOT NULL DEFAULT 10,
  prompt_timeout_minutes    smallint NOT NULL DEFAULT 3,
  archived_at               timestamptz,
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_patterns_name_len CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT shift_patterns_work_days CHECK (
    cardinality(work_days) BETWEEN 1 AND 7 AND work_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  CONSTRAINT shift_patterns_not_zero_length CHECK (start_time <> end_time),
  CONSTRAINT shift_patterns_grace CHECK (grace_minutes BETWEEN 0 AND 240),
  CONSTRAINT shift_patterns_allowance CHECK (break_allowance_minutes BETWEEN 0 AND 480),
  CONSTRAINT shift_patterns_silence CHECK (silence_threshold_minutes BETWEEN 3 AND 120),
  CONSTRAINT shift_patterns_prompt CHECK (prompt_timeout_minutes BETWEEN 1 AND 30)
);

CREATE UNIQUE INDEX IF NOT EXISTS shift_patterns_live_name
  ON shift_patterns (org_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS shift_break_slots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shift_pattern_id  uuid NOT NULL REFERENCES shift_patterns(id) ON DELETE CASCADE,
  label             text NOT NULL,
  start_time        time NOT NULL,
  duration_minutes  smallint NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_break_slots_label_len CHECK (char_length(label) BETWEEN 1 AND 60),
  CONSTRAINT shift_break_slots_duration CHECK (duration_minutes BETWEEN 5 AND 240)
);

CREATE INDEX IF NOT EXISTS shift_break_slots_pattern ON shift_break_slots (shift_pattern_id);

-- One row per change, not a range: the pattern in force on a date is the row
-- with the latest effective_from on or before it. A range table would need an
-- exclusion constraint (btree_gist) to stop overlaps; this shape cannot
-- overlap at all. `shift_pattern_id` NULL = unassigned from that date.
CREATE TABLE IF NOT EXISTS telecaller_shift_assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  telecaller_id     uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,
  shift_pattern_id  uuid REFERENCES shift_patterns(id) ON DELETE RESTRICT,
  effective_from    date NOT NULL,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telecaller_shift_assignments_one_per_day UNIQUE (telecaller_id, effective_from)
);

CREATE INDEX IF NOT EXISTS telecaller_shift_assignments_lookup
  ON telecaller_shift_assignments (org_id, telecaller_id, effective_from DESC);

-- Holidays (telecaller_id NULL = the whole workspace), a day off, or
-- different hours for one person on one date.
CREATE TABLE IF NOT EXISTS attendance_exceptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  telecaller_id  uuid REFERENCES telecallers(id) ON DELETE CASCADE,
  on_date        date NOT NULL,
  kind           text NOT NULL,
  label          text,
  start_time     time,
  end_time       time,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_exceptions_kind CHECK (kind IN ('holiday', 'day_off', 'custom_hours')),
  CONSTRAINT attendance_exceptions_holiday_is_org CHECK (kind <> 'holiday' OR telecaller_id IS NULL),
  CONSTRAINT attendance_exceptions_person_kinds CHECK (kind = 'holiday' OR telecaller_id IS NOT NULL),
  CONSTRAINT attendance_exceptions_hours_shape CHECK (
    (kind = 'custom_hours') = (start_time IS NOT NULL AND end_time IS NOT NULL)),
  CONSTRAINT attendance_exceptions_hours_nonzero CHECK (start_time IS NULL OR start_time <> end_time)
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_exceptions_one_per_day
  ON attendance_exceptions (org_id, COALESCE(telecaller_id, '00000000-0000-0000-0000-000000000000'::uuid), on_date);

-- ── Requests: breaks, leave, hour changes - the authority loop ──────────────
--
-- Leave is stored as CALENDAR DATES (doc 30 R2): leave "on 3 Oct" is 3 Oct in
-- every zone. Breaks and hour changes are instants, because they are a time of
-- day on a day. `approver_membership_id` is resolved when the request arrives
-- and stored, so a later change of manager does not move a request somebody is
-- already looking at; NULL means every active owner.

CREATE TABLE IF NOT EXISTS attendance_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  telecaller_id           uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,
  kind                    text NOT NULL,
  leave_type              text,
  start_date              date,
  end_date                date,
  half_day                text,
  starts_at               timestamptz,
  ends_at                 timestamptz,
  reason                  text,
  status                  text NOT NULL DEFAULT 'pending',
  approver_membership_id  uuid REFERENCES memberships(id) ON DELETE SET NULL,
  escalated_at            timestamptz,
  decided_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at              timestamptz,
  decision_note           text,
  source                  text NOT NULL,
  device_id               uuid REFERENCES devices(id) ON DELETE SET NULL,
  created_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The handset's own id for an application written offline, so a queued
  -- request sent twice is stored once.
  client_ref              text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_requests_kind CHECK (kind IN ('break', 'leave', 'hours_change')),
  CONSTRAINT attendance_requests_status CHECK (
    status IN ('pending', 'approved', 'rejected', 'auto_approved', 'cancelled')),
  CONSTRAINT attendance_requests_source CHECK (source IN ('device', 'web', 'on_behalf')),
  CONSTRAINT attendance_requests_leave_type CHECK (
    leave_type IS NULL OR leave_type IN ('casual', 'sick', 'earned', 'unpaid', 'other')),
  CONSTRAINT attendance_requests_half_day CHECK (half_day IS NULL OR half_day IN ('am', 'pm')),
  CONSTRAINT attendance_requests_leave_shape CHECK (
    kind <> 'leave' OR (leave_type IS NOT NULL AND start_date IS NOT NULL AND end_date IS NOT NULL
                        AND end_date >= start_date AND starts_at IS NULL AND ends_at IS NULL
                        AND (half_day IS NULL OR start_date = end_date))),
  CONSTRAINT attendance_requests_timed_shape CHECK (
    kind = 'leave' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at
                       AND leave_type IS NULL AND half_day IS NULL
                       AND start_date IS NULL AND end_date IS NULL)),
  CONSTRAINT attendance_requests_reason_len CHECK (reason IS NULL OR char_length(reason) <= 500),
  -- A rejection always says why.
  CONSTRAINT attendance_requests_rejection_note CHECK (
    status <> 'rejected' OR (decision_note IS NOT NULL AND char_length(btrim(decision_note)) > 0)),
  CONSTRAINT attendance_requests_decided_shape CHECK (
    (status IN ('approved', 'rejected')) = (decided_at IS NOT NULL) OR status IN ('auto_approved', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_requests_client_ref
  ON attendance_requests (org_id, device_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS attendance_requests_pending
  ON attendance_requests (org_id, status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS attendance_requests_person
  ON attendance_requests (org_id, telecaller_id, created_at DESC);

-- ── Raw handset events ──────────────────────────────────────────────────────
--
-- Append-only, idempotent on (device, boot, monotonic ms, kind): a batch the
-- phone re-sends after a lost response is a no-op. `occurred_at` is the
-- server-corrected instant (see normalisePresenceBatch); `device_wall_at` is
-- what the phone's own clock said, kept to show skew. Purged after 90 days by
-- the worker - segments and days are the durable record.

CREATE TABLE IF NOT EXISTS presence_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  -- Resolved from devices.telecaller_id when RECEIVED, so moving a handset to
  -- somebody else never rewrites who did what yesterday.
  telecaller_id   uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  kind            text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  device_wall_at  timestamptz NOT NULL,
  boot_id         text NOT NULL,
  mono_ms         bigint NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT presence_events_kind CHECK (kind IN (
    'heartbeat', 'state', 'shift_start', 'shift_end', 'call_start', 'call_end',
    'prompt_shown', 'prompt_answered', 'prompt_expired',
    'break_started', 'break_ended', 'network_lost', 'network_restored',
    'boot', 'app_start', 'service_start', 'service_stop', 'screen_unlock',
    'notice_acknowledged')),
  CONSTRAINT presence_events_boot_len CHECK (char_length(boot_id) BETWEEN 1 AND 64),
  CONSTRAINT presence_events_idempotent UNIQUE (device_id, boot_id, mono_ms, kind)
);

CREATE INDEX IF NOT EXISTS presence_events_person_time
  ON presence_events (org_id, telecaller_id, occurred_at);
CREATE INDEX IF NOT EXISTS presence_events_received
  ON presence_events (received_at);

-- What the Today board reads: one row per telecaller, overwritten by every
-- presence batch. Cheap to read for a whole floor without scanning events.
CREATE TABLE IF NOT EXISTS attendance_live_state (
  telecaller_id     uuid PRIMARY KEY REFERENCES telecallers(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id         uuid REFERENCES devices(id) ON DELETE SET NULL,
  state             text NOT NULL,
  state_since       timestamptz NOT NULL,
  last_event_at     timestamptz NOT NULL,
  last_received_at  timestamptz NOT NULL,
  battery_pct       smallint,
  network_ok        boolean,
  -- When the worker last woke this phone with an FCM `presence_check` after
  -- its heartbeats stopped (doc 33 §4). Throttles the push to one per 10 min.
  presence_check_sent_at timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_live_state_state CHECK (state IN (
    'OFF_SHIFT', 'ACTIVE', 'IN_CALL', 'PROMPTING', 'AWAY', 'TECHNICAL', 'BREAK_DUE', 'ON_BREAK'))
);

CREATE INDEX IF NOT EXISTS attendance_live_state_org ON attendance_live_state (org_id);

-- ── Derived: segments and days (rebuilt by the worker) ──────────────────────

CREATE TABLE IF NOT EXISTS attendance_segments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  telecaller_id   uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,
  work_date       date NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  class           text NOT NULL,
  -- The doc 33 §4 rule number that produced it. 0 = plain phone state.
  rule            smallint NOT NULL DEFAULT 0,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  needs_review    boolean NOT NULL DEFAULT false,
  -- Copied from attendance_overrides on each rebuild, for display.
  override_class  text,
  override_id     uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_segments_order CHECK (ends_at > starts_at),
  CONSTRAINT attendance_segments_class CHECK (class IN (
    'working', 'break', 'break_overrun', 'unscheduled_break', 'technical', 'away',
    'leave', 'unknown', 'not_started', 'absent', 'overtime'))
);

CREATE INDEX IF NOT EXISTS attendance_segments_day
  ON attendance_segments (org_id, telecaller_id, work_date, starts_at);
CREATE INDEX IF NOT EXISTS attendance_segments_review
  ON attendance_segments (org_id, work_date) WHERE needs_review AND override_class IS NULL;

-- A manager's decision about a stretch of time. Separate from the segments so
-- a rebuild cannot erase it: the classifier re-applies every override that
-- covers a segment's time, whatever the segment boundaries came out as.
CREATE TABLE IF NOT EXISTS attendance_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  telecaller_id   uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,
  work_date       date NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  override_class  text NOT NULL,
  note            text NOT NULL,
  decided_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_overrides_order CHECK (ends_at > starts_at),
  CONSTRAINT attendance_overrides_class CHECK (override_class IN ('excused', 'unexcused')),
  CONSTRAINT attendance_overrides_note CHECK (char_length(btrim(note)) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS attendance_overrides_day
  ON attendance_overrides (org_id, telecaller_id, work_date);

CREATE TABLE IF NOT EXISTS attendance_days (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  telecaller_id          uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,
  work_date              date NOT NULL,
  status                 text NOT NULL,
  shift_start_at         timestamptz,
  shift_end_at           timestamptz,
  check_in_at            timestamptz,
  check_out_at           timestamptz,
  worked_seconds         int NOT NULL DEFAULT 0,
  break_seconds          int NOT NULL DEFAULT 0,
  booked_break_seconds   int NOT NULL DEFAULT 0,
  technical_seconds      int NOT NULL DEFAULT 0,
  away_seconds           int NOT NULL DEFAULT 0,
  unknown_seconds        int NOT NULL DEFAULT 0,
  late_seconds           int NOT NULL DEFAULT 0,
  overtime_seconds       int NOT NULL DEFAULT 0,
  review_count           int NOT NULL DEFAULT 0,
  flags                  text[] NOT NULL DEFAULT '{}',
  computed_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_days_one UNIQUE (telecaller_id, work_date),
  CONSTRAINT attendance_days_status CHECK (status IN (
    'present', 'late', 'half_day', 'absent', 'on_leave', 'holiday', 'off', 'upcoming'))
);

CREATE INDEX IF NOT EXISTS attendance_days_org_date ON attendance_days (org_id, work_date);

-- Days whose inputs changed since they were classified: a late presence
-- upload, a decided request, an override, an exception. The API marks them;
-- the worker's classifier rebuilds each one and clears the mark. Today and
-- yesterday are rebuilt on every pass anyway - this is how an OLDER day, or a
-- leave approved for next week, gets rebuilt without rescanning everything.
CREATE TABLE IF NOT EXISTS attendance_dirty_days (
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  telecaller_id  uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,
  work_date      date NOT NULL,
  marked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (telecaller_id, work_date)
);

CREATE INDEX IF NOT EXISTS attendance_dirty_days_org ON attendance_dirty_days (org_id, work_date);

-- ── WhatsApp alerts to approvers (doc 33 §6.4) ──────────────────────────────
--
-- One row per (request, recipient, reason), unique, so a retry can never
-- message a manager twice. The console notification is written first and never
-- waits on this.

CREATE TABLE IF NOT EXISTS attendance_whatsapp_outbox (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id               uuid NOT NULL REFERENCES attendance_requests(id) ON DELETE CASCADE,
  recipient_membership_id  uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  reason                   text NOT NULL,
  status                   text NOT NULL DEFAULT 'queued',
  attempts                 smallint NOT NULL DEFAULT 0,
  next_attempt_at          timestamptz NOT NULL DEFAULT now(),
  provider_message_id      text,
  last_error               text,
  sent_at                  timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_whatsapp_outbox_reason CHECK (reason IN ('new_request', 'escalation')),
  CONSTRAINT attendance_whatsapp_outbox_status CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  CONSTRAINT attendance_whatsapp_outbox_once UNIQUE (request_id, recipient_membership_id, reason)
);

CREATE INDEX IF NOT EXISTS attendance_whatsapp_outbox_due
  ON attendance_whatsapp_outbox (next_attempt_at) WHERE status = 'queued';

-- ── Dead air in recordings (doc 33 §5) ──────────────────────────────────────
--
-- Numbers only - never audio, never text. Computed for every uploaded
-- recording whether or not attendance is on, because it is call quality too.

CREATE TABLE IF NOT EXISTS call_audio_quality (
  call_id                   uuid PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dead_air_seconds          numeric(8,1) NOT NULL,
  longest_dead_air_seconds  numeric(8,1) NOT NULL,
  zero_signal               boolean NOT NULL,
  analysed_seconds          numeric(8,1) NOT NULL,
  analysed_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_audio_quality_org ON call_audio_quality (org_id, analysed_at DESC);

-- ── Row-level security, grants, triggers - the tenant pattern (0137) ────────

DO $do$
DECLARE
  t text;
  api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'shift_patterns', 'shift_break_slots', 'telecaller_shift_assignments',
    'attendance_exceptions', 'attendance_requests', 'presence_events',
    'attendance_live_state', 'attendance_segments', 'attendance_overrides',
    'attendance_days', 'attendance_whatsapp_outbox', 'call_audio_quality',
    'attendance_dirty_days'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'shift_patterns', 'shift_break_slots', 'telecaller_shift_assignments',
    'attendance_exceptions', 'attendance_requests', 'attendance_live_state',
    'attendance_overrides', 'attendance_whatsapp_outbox'
  ] LOOP
    BEGIN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
        t || '_set_updated_at', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $do$;

-- ── Notification kinds ──────────────────────────────────────────────────────
--
-- Re-added in full, the 0135 way. The four new kinds are console notifications
-- to owners and managers; nothing here reaches a phone or an inbox. Kept in
-- lockstep with NotificationKind in @aura/shared (notification-kinds.test.ts).
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
                  'attendance_review'));
