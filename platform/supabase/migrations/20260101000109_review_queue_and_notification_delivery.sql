-- 0109_review_queue_and_notification_delivery.sql - CRM dashboard, Phase 7:
-- the two notifications the review queue and the response SLA need, and a
-- person's choice between hearing about things now or once a day.
--
-- ── 1. TWO NEW NOTIFICATION KINDS ───────────────────────────────────────────
--
--   sla_breach     - a lead has waited longer than the org's response SLA for
--                    a first response (the worker's sla-breach sweep).
--   review_pending - something a machine proposed is waiting for a person to
--                    approve (the WhatsApp qualification sweep).
--
-- The CHECK is restated in full, the way 0100 did it. @aura/shared's
-- NotificationKind is the other copy; notification-kinds.test.ts reads this
-- file's CHECK and fails if the two drift - which is the bug 0100's header
-- records, where an INSERT threw 23514 in production because the enum knew a
-- kind the database did not.
--
-- ── 2. INSTANT OR DIGEST, DECIDED BY THE DATABASE ───────────────────────────
--
-- Notifications are written from at least five places: the API's notify(),
-- the lead-routing library, the worker's channel watchdog, the qualification
-- sweep and the SLA sweep - several of them as a raw INSERT. A preference each
-- writer had to remember to consult would be honoured by whichever writers
-- were written after the preference existed. So the preference is applied by
-- a BEFORE INSERT trigger, and every writer, present and future, gets it free.
--
-- "Digest" does not batch or rewrite anything. The row is written exactly as
-- it would have been, with `deliver_after` set to the person's next digest
-- hour in the org's reporting timezone; the bell lists only rows whose
-- deliver_after has passed. At nine o'clock the day's held rows simply appear,
-- together. Nothing is sent anywhere: this is still the in-app bell and
-- nothing else (see @aura/shared notifications.ts - a digest EMAIL would be a
-- different consent question, and is not built).
--
-- ── 3. THE RESPONSE SLA ─────────────────────────────────────────────────────
--
-- `organizations.response_sla_minutes`: how long a new lead may wait for a
-- first response (leads.first_responded_at, 0090) before the floor is told.
-- Sixty minutes by default - the "within the hour" bucket the response-time
-- report already draws (sla.ts).
--
-- ── 4. A PERSON'S VERDICT ON A PROBABLE OPT-OUT ─────────────────────────────
--
-- 0100 says a `probable` opt-out waits for a person to "promote it or dismiss
-- it", and built only the promote-adjacent half (release, on the conversation).
-- Dismissing CANNOT be a release: the ingest upsert refuses to touch a released
-- row, so a dismissed "leave me alone" followed a week later by a plain "STOP"
-- would never block anything. So a dismissal is its own stamp. A reviewed
-- probable leaves the review queue, still blocks nothing, and is still
-- promoted to `certain` by the next unambiguous request, exactly as before.

-- 1 ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE conname text;
BEGIN
  SELECT c.conname INTO conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'notifications' AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%kind%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', conname);
  END IF;
END $$;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'task_due', 'deal_stage_changed', 'deal_idle',
                  'automation', 'report_ready', 'lead_assigned',
                  'opt_out_requested', 'channel_needs_attention',
                  -- 0109: a lead waited past the response SLA.
                  'sla_breach',
                  -- 0109: a machine's proposal is waiting for a person.
                  'review_pending'));

-- 2 ────────────────────────────────────────────────────────────────────────
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS deliver_after timestamptz;
UPDATE notifications SET deliver_after = created_at WHERE deliver_after IS NULL;
ALTER TABLE notifications
  ALTER COLUMN deliver_after SET DEFAULT now(),
  ALTER COLUMN deliver_after SET NOT NULL;

COMMENT ON COLUMN notifications.deliver_after IS
  'When the bell may show this row. now() for instant delivery; the person''s next '
  'digest hour when they chose digest for this kind (0109 trigger). The bell and the '
  'unread count read only rows at or past it.';

CREATE INDEX IF NOT EXISTS notifications_user_delivered
  ON notifications (user_id, deliver_after DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The kinds this person wants once a day. Everything not listed is instant,
  -- so a person with no row - everyone, until they choose - loses nothing.
  -- Validated against NotificationKind by the API, not by a CHECK: a kind the
  -- API retires must not make old preference rows unwritable.
  digest_kinds text[] NOT NULL DEFAULT '{}',
  -- Local hour, in the org's reporting timezone.
  digest_hour  smallint NOT NULL DEFAULT 9 CHECK (digest_hour BETWEEN 0 AND 23),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON notification_preferences
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Whose row it is, is the API's filter: the connection carries the org, not the person.
GRANT SELECT, INSERT, UPDATE ON notification_preferences TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON notification_preferences FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON notification_preferences FROM PUBLIC;

/**
 * The next time the clock in `org`'s reporting timezone reads `hour`:00.
 * Today's slot if it is still ahead, otherwise tomorrow's. One definition,
 * shared by the trigger and by the API when a person changes their hour.
 */
CREATE OR REPLACE FUNCTION notification_next_digest_at(p_org uuid, p_hour integer)
RETURNS timestamptz
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tz        text;
  local_now timestamp;
  slot      timestamp;
BEGIN
  SELECT reporting_timezone INTO tz FROM organizations WHERE id = p_org;
  tz := COALESCE(tz, 'Asia/Kolkata');
  local_now := now() AT TIME ZONE tz;
  slot := date_trunc('day', local_now) + make_interval(hours => p_hour);
  IF slot <= local_now THEN
    slot := slot + interval '1 day';
  END IF;
  RETURN slot AT TIME ZONE tz;
END;
$$;

-- SECURITY DEFINER so the lookup works from every writer whatever its role -
-- the worker's admin pool included - with the org and user named explicitly
-- rather than left to RLS.
CREATE OR REPLACE FUNCTION notifications_apply_delivery_preference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pref notification_preferences%ROWTYPE;
BEGIN
  SELECT * INTO pref
    FROM notification_preferences
   WHERE org_id = NEW.org_id AND user_id = NEW.user_id;
  IF FOUND AND NEW.kind = ANY(pref.digest_kinds) THEN
    NEW.deliver_after := GREATEST(
      COALESCE(NEW.deliver_after, now()),
      notification_next_digest_at(NEW.org_id, pref.digest_hour)
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notifications_delivery_preference ON notifications;
CREATE TRIGGER notifications_delivery_preference
  BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_apply_delivery_preference();

REVOKE ALL ON FUNCTION notification_next_digest_at(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notification_next_digest_at(uuid, integer) TO aura_app;

-- 3 ────────────────────────────────────────────────────────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS response_sla_minutes integer NOT NULL DEFAULT 60
    CHECK (response_sla_minutes BETWEEN 5 AND 1440);

COMMENT ON COLUMN organizations.response_sla_minutes IS
  'How long a new lead may wait for a first response before the sla_breach sweep tells '
  'the assigned telecaller and the owners/managers (0109).';

-- The SLA sweep's scan (open leads nobody has answered) needs no new index:
-- 0090's leads_org_unresponded is exactly that partial index.

-- 4 ────────────────────────────────────────────────────────────────────────
-- No pairing CHECK like 0100's release: with ON DELETE SET NULL, a CHECK would
-- make removing a user fail on every opt-out they ever reviewed.
ALTER TABLE messaging_opt_outs
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN messaging_opt_outs.reviewed_at IS
  'A person looked at this probable opt-out and judged it not a request to stop (0109). '
  'Takes it out of the review queue; a later plain request still promotes it to certain.';

CREATE INDEX IF NOT EXISTS messaging_opt_outs_awaiting_review
  ON messaging_opt_outs (org_id, created_at DESC)
  WHERE level = 'probable' AND released_at IS NULL AND reviewed_at IS NULL;
