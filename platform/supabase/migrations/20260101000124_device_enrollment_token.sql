-- 0124_device_enrollment_token.sql - which pairing code a handset used.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
-- The owner console's pairing dialog shows a QR and then has to know the
-- moment a phone has used it, so the screen can move on by itself - the way
-- WhatsApp's "Link a device" does. Until now nothing recorded WHICH token a
-- device came in on: `POST /devices/register` bumped `use_count` and inserted
-- the device, and the only link between the two was "same instance, a few
-- seconds apart". That is a guess, and it is wrong the moment two people on
-- the same desk pair two phones at once.
--
-- So the device row carries the id of the token it spent. The dialog asks
-- "has a device used pairing X yet" and gets a yes or no, not an inference.
--
-- ── WHY ON devices, NOT ON enrollment_tokens ────────────────────────────────
--
-- Operator-issued keys can be multi-use (bulk / MDM enrolment, see
-- InstancesController), so one token can admit many devices. A column on the
-- device side holds that shape; a `device_id` on the token would only ever
-- remember the last phone through the door.
--
-- ── ON DELETE SET NULL ──────────────────────────────────────────────────────
--
-- A token is a spent credential; the device is a telecaller's call history.
-- Pruning old tokens must never take a handset with it. Devices enrolled
-- before this migration simply have NULL here - their pairing dialogs closed
-- long ago, and there is nothing to backfill that would be anything but a
-- guess.
--
-- No new table, so verify-rls.js is unaffected: `devices` already carries
-- `org_id` under FORCE RLS.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS enrollment_token_id uuid
    REFERENCES enrollment_tokens(id) ON DELETE SET NULL;

-- The dialog's status read is a lookup by token id, repeated while the QR is
-- on screen. Partial: every device enrolled before this migration is NULL and
-- has no business in the index.
CREATE INDEX IF NOT EXISTS devices_enrollment_token
  ON devices (enrollment_token_id)
  WHERE enrollment_token_id IS NOT NULL;
