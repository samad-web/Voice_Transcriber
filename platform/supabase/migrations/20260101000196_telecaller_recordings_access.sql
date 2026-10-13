-- 0196_telecaller_recordings_access.sql - whether a telecaller may reach the
-- call recordings held on their own handset.
--
-- ── WHY A TELECALLER FLAG AND NOT A MEMBERSHIP ONE ──────────────────────────
--
-- `memberships.recordings_listen` / `recordings_export` (0001) already answer
-- this question for a CONSOLE user. They cannot answer it for a handset,
-- because most telecallers have no console login at all - the same reason
-- `handset_alerts` (0150) is keyed on the telecaller rather than the user.
--
-- So this sits beside `app_leave_requests` and `app_break_booking` (0140),
-- which are exactly this shape already: per-telecaller booleans that the
-- handset reads out of `GET /devices/me/config` and that the owner flips on
-- the Staff page. One more column in that family, not a new mechanism.
--
-- ── DEFAULT false, INCLUDING FOR TELECALLERS THAT ALREADY EXIST ─────────────
--
-- Deny until somebody says otherwise. That is the requested policy, and it is
-- a REAL CHANGE for every workspace already running: the moment an API
-- carrying this column is deployed, every existing telecaller loses the
-- recordings list on their phone until an owner turns it back on per person.
--
-- That is deliberate and it is also the single most disruptive line in this
-- migration, so it is written down rather than discovered. To grandfather the
-- people already using it instead, run ONCE, before the API deploy:
--
--     UPDATE telecallers SET app_recordings_access = true
--      WHERE status = 'active';
--
-- ── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────
--
-- Capture and upload. A telecaller who may not open a recording still records
-- and still uploads: the flag governs the LIBRARY on the phone, never the
-- pipeline. Local files are already removed after a successful upload unless
-- `keepLocalAfterUpload` is set (UploadWorker.kt), so withdrawing the delete
-- button cannot fill a phone - the cleanup was never the rep's job.

ALTER TABLE telecallers
  ADD COLUMN IF NOT EXISTS app_recordings_access boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN telecallers.app_recordings_access IS
  'Handset library access: may this telecaller open, rename or delete the call '
  'recordings on their own phone. Default false - the owner grants it per person '
  'on the Staff page. Does not affect capture or upload.';
