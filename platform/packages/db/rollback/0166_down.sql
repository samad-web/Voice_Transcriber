-- 0166_down.sql - reverse the `appointments` primitive.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0166_down.sql
--
-- ── RUN THIS BEFORE 0165_down.sql ───────────────────────────────────────────
--
-- `appointments.resource_id` references `resources`, so dropping 0165 first
-- fails on the dependency. The failure is loud and harmless, but this is the
-- order.
--
-- ── READ THIS FIRST: THIS DESTROYS THE DIARY ────────────────────────────────
--
-- `appointments` is every booking a tenant has taken, including the attendance
-- record that the no-show report is computed from. Nothing else in the schema
-- can reconstruct it. Keep it:
--
--   \copy (SELECT * FROM appointments) TO 'appointments.csv' CSV HEADER
--
-- `appointment_notifications` is the record of what was sent to whom and what
-- was deliberately NOT sent, which is what an operator consults when a customer
-- asks why they got a message. Worth keeping for the same reason 0032 keeps a
-- dead row rather than deleting it:
--
--   \copy (SELECT * FROM appointment_notifications) TO 'appointment-outbox.csv' CSV HEADER
--
-- ── NOTHING IN THE marketing SCHEMA IS TOUCHED ──────────────────────────────
--
-- 0166 never wrote to it, so there is nothing there to put back. In particular
-- this file does NOT re-grant, re-revoke or otherwise go near
-- `marketing.booking_slots`: a rollback that issued a GRANT in that schema
-- would be the exact trap 0166's header opens with, arriving by the back door.
--
-- ── THE ORGANIZATIONS COLUMN ────────────────────────────────────────────────
--
-- `appointment_reminders_enabled` is dropped. It is a boolean an owner may have
-- turned ON, and re-running 0166 brings it back at the DEFAULT of false - which
-- is the safe direction to lose a setting in. Note which orgs had it first if
-- you intend to re-apply:
--
--   SELECT id, name FROM organizations WHERE appointment_reminders_enabled;

BEGIN;

-- 1. Children first and explicitly, rather than relying on the CASCADE, so each
--    statement says what it destroys.
DROP TABLE IF EXISTS appointment_reschedule_tokens;
DROP TABLE IF EXISTS appointment_notifications;
DROP TABLE IF EXISTS appointments;

-- 2. The owner's send switch.
ALTER TABLE organizations DROP COLUMN IF EXISTS appointment_reminders_enabled;

-- 3. The permission grants. Custom roles are included even though 0166 never
--    seeded them, for the reason 0158_down.sql gives: a row for this object
--    type can only have come from 0166 or from a hand edit afterwards, and an
--    orphan grant for an object the API no longer knows is worse than losing an
--    edit the header told you to check for.
DELETE FROM role_permissions WHERE object_type = 'appointment';

DELETE FROM schema_migrations WHERE name = '0166_appointments.sql';

COMMIT;
