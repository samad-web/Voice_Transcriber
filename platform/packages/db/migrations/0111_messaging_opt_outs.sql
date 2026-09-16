-- 0111_messaging_opt_outs.sql - somebody asked to stop being messaged, and the
-- product remembering it.
--
-- ── WHAT DOES NOT EXIST TODAY ───────────────────────────────────────────────
--
-- Nothing. Aura has no opt-out concept at all: no column, no table, no check on
-- the send path. A customer who replies "stop sending me messages" is stored as
-- an ordinary inbound message and the composer will happily send again.
--
-- That is not merely impolite. An approved WhatsApp template whose footer says
-- "Reply STOP to opt out" is a promise made with Meta's approval, and a
-- business that breaks it collects spam reports. On WhatsApp a spam report
-- costs the WABA's quality rating, and the quality rating gates every future
-- template approval - so the cost of ignoring an opt-out is not a complaint, it
-- is losing the ability to send templates at all.
--
-- ── WHY IT IS KEYED ON THE PEER ADDRESS AND NOT ON A CONTACT ────────────────
--
-- An opt-out arrives from a phone number, and at the moment it arrives that
-- number often has no contact behind it: conversations.service.ts matches on
-- `phone_hash` and its own header documents the case where a WhatsApp reply
-- never matches the contact a call created (national vs international form).
--
-- Hanging the record off `contacts` would therefore drop exactly the opt-outs
-- that arrive on unmatched threads - the ones nobody is watching. Keyed on
-- (org_id, channel, peer_address) it uses the same natural key
-- `conversations_peer_unique` already uses, so it is true regardless of whether
-- the person is a contact today, becomes one tomorrow, or gets merged into
-- another.
--
-- ── TWO LEVELS, AND ONLY ONE OF THEM SILENCES ANYBODY ───────────────────────
--
-- `certain` is an unambiguous request ("stop messaging me", or the bare
-- keyword). It blocks the send path.
--
-- `probable` is the ambiguous half ("leave me alone", "enough"). It records the
-- fact and raises a notification, and it does NOT block: the power to stop
-- talking to a customer for good belongs to a person, and the difference
-- between an opt-out and an exasperated customer who wants a HUMAN is exactly
-- what the machine cannot tell. A person promotes it or dismisses it.
--
-- The rule this respects, stated plainly: this feature only ever SUPPRESSES
-- sending. It cannot send, cannot contact anybody, and cannot change a lead. It
-- is the safe half of "nothing automated reaches a person without a human
-- saying yes", not an exception to it.
--
-- ── WHY RELEASING IS A COLUMN AND NOT A DELETE ──────────────────────────────
--
-- A person can undo an opt-out (a customer says "actually, do text me"), and
-- when they do, the fact that someone opted out and someone else released it is
-- the record that matters if it is ever questioned. Deleting the row would
-- leave the system unable to answer "did they ever ask us to stop?" - which is
-- the only question anybody asks afterwards.

CREATE TABLE IF NOT EXISTS messaging_opt_outs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  channel        text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  -- Normalised the same way conversations.peer_address is (normalizePeerAddress
  -- in @aura/shared). A differently-normalised value here would be an opt-out
  -- that never matches the thread it came from.
  peer_address   text NOT NULL,

  -- 'certain' blocks the send path; 'probable' only asks a person. See header.
  -- A CHECK rather than an enum type, matching every other kind/status column
  -- in this schema.
  level          text NOT NULL CHECK (level IN ('certain', 'probable')),

  -- The message that caused it, so a person reviewing a `probable` can read
  -- what was actually said rather than trusting the classifier. ON DELETE SET
  -- NULL: erasing the message must not erase the request it carried.
  source_message_id uuid REFERENCES conversation_messages(id) ON DELETE SET NULL,

  -- Who undid it, and when. NULL means the opt-out stands. See header for why
  -- this is not a DELETE.
  released_at    timestamptz,
  released_by    uuid REFERENCES users(id) ON DELETE SET NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- One row per person per channel. The ingest path upserts onto this, which
  -- is what lets a `probable` be PROMOTED to `certain` when the customer says
  -- it again more plainly, without a second row and without a prior SELECT.
  CONSTRAINT messaging_opt_outs_peer_unique UNIQUE (org_id, channel, peer_address),
  -- Released rows must name who released them. A release with no actor is an
  -- audit record that answers the wrong half of the question.
  CONSTRAINT messaging_opt_outs_release_has_actor
    CHECK ((released_at IS NULL) = (released_by IS NULL))
);

-- The send path's question is "is this person opted out RIGHT NOW", which is
-- the unique key above plus `released_at IS NULL`. Partial, because a released
-- row is history and never appears in that lookup.
CREATE INDEX IF NOT EXISTS messaging_opt_outs_active
  ON messaging_opt_outs (org_id, channel, peer_address)
  WHERE released_at IS NULL;

ALTER TABLE messaging_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_opt_outs FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON messaging_opt_outs
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE ON messaging_opt_outs TO aura_app;
-- No DELETE grant, and that is the point: see the header. A release is an
-- UPDATE, so the record of the request survives it.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON messaging_opt_outs FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON messaging_opt_outs FROM PUBLIC;

-- ── the notification kinds ──────────────────────────────────────────────────
--
-- `notifications.kind` is a CHECK, widened the same way 0077 widened it.
--
-- ⚠️ ONE OF THESE THREE IS A BUG FIX, NOT A NEW FEATURE.
--
-- `lead_assigned` has been in @aura/shared's NotificationKind since 0105 and is
-- INSERTed directly by packages/db/src/lead-routing.ts (`notifyAssignee`, and
-- `notifyBackfillSummary`), but 0105 never widened this CHECK. Measured against
-- a database migrated to 0110:
--
--   INSERT INTO notifications (..., kind, ...) VALUES (..., 'lead_assigned', ...);
--   ERROR: new row for relation "notifications" violates check constraint
--          "notifications_kind_check"
--
-- So every routed lead raises a 23514 rather than a notification. It is fixed
-- here because this migration has to rewrite the same constraint anyway, and
-- leaving a known-broken value out of a list being rewritten for other reasons
-- would be choosing to keep the bug.
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
                  'automation', 'report_ready',
                  -- Shipped broken in 0105. See above.
                  'lead_assigned',
                  -- A customer may have asked to stop being messaged, and it
                  -- was ambiguous enough that a person has to decide.
                  'opt_out_requested',
                  -- A WhatsApp channel cannot carry messages (migration 0110).
                  'channel_needs_attention'));
