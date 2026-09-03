-- 0087_device_removal.sql - taking a handset out of the fleet without
-- destroying what it recorded.
--
-- The console had Logout and Wipe and nothing that REMOVES a phone. Both of
-- those are states a device stays in forever, so a handset that left the
-- company a year ago still sits in the fleet table looking exactly like one
-- that is merely offline this afternoon.
--
-- A plain DELETE is not available. `calls.device_id` is NOT NULL REFERENCES
-- devices(id) with no cascade (0001), deliberately, so that call history can
-- never be destroyed as a side effect of tidying the fleet - the same reason
-- instances.controller's decommission refuses at 409 rather than cascading.
--
-- So: a nullable timestamp, NOT a new `status` value. `status` says what the
-- handset is doing (active / logged_out / wiped / lost); removal is a
-- different axis, and a removed phone still has a last status worth reading in
-- the audit trail. Keeping them separate also means no CHECK constraint change
-- and no back-fill - every existing row is `removed_at IS NULL`, which is
-- already the right answer for all of them.
--
-- The API sets `status = 'logged_out'` alongside this so a removed handset also
-- stops authenticating, and hard-DELETEs the row instead when the device has no
-- calls at all: nothing to preserve, so nothing to keep.
--
-- Numbered 0087 rather than 0084 to leave 0084-0086 free for the ASR
-- cost/enrichment work already allocated to them on another branch. Order does
-- not matter here - this touches only `devices`, and migrate.js picks pending
-- work by filename-not-in-schema_migrations, so a lower number landing later
-- still runs (see the runbook's note on migration drift).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS removed_at timestamptz;

COMMENT ON COLUMN devices.removed_at IS
  'When this handset was taken out of the fleet. NULL = live. A removed device is '
  'excluded from every fleet listing and count but keeps its calls resolvable.';

-- Every fleet read filters on this, alongside org_id (RLS) and usually
-- instance_id. Partial, because the rows anyone actually lists are the live
-- ones - a removed handset is read only when following a call back to it.
CREATE INDEX IF NOT EXISTS devices_live
  ON devices (org_id, instance_id)
  WHERE removed_at IS NULL;
