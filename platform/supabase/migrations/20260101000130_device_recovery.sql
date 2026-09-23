-- 0130_device_recovery.sql - a handset that comes back is the SAME handset.
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
--
-- Every enrollment INSERTed a fresh `devices` row. Uninstalling the app
-- destroys its Keystore key and its preferences, so a reinstalled phone could
-- only re-enrol, and it arrived as a stranger: a new device id, no telecaller,
-- no call history, while its old row sat "active" and silent forever. A phone
-- an owner retired by mistake was worse off still - `authenticate` refuses any
-- status but 'active', and nothing could set it back.
--
-- This migration lets a returning phone take its old row back, so calls,
-- leads, health beacons and the telecaller link all carry on under one id.
--
-- ── FOUR WAYS BACK, ONE WRITE ───────────────────────────────────────────────
--
-- Each path differs only in how it identifies the row and what authorises it
-- (devices.controller.ts / owner-devices.controller.ts):
--
--   restore        owner/manager (or operator org_admin) undoes a retire, logout
--                  or wipe. The app is still installed, so its key still works.
--   secret         a reinstalled app reads its recovery secret back from Google
--                  Block Store and reclaims the row with no QR at all.
--   hardware match a re-scanned pairing QR; the phone's hardware hash names the
--                  row it used to be.
--   relink         an owner mints a pairing QR bound to one row; whichever phone
--                  scans it takes that row over (factory reset, replacement).

ALTER TABLE devices
  -- A ROUTING HINT, NOT A CREDENTIAL. sha256(org_id || ':' || h), where h is a
  -- hash the handset derives from ANDROID_ID. ANDROID_ID survives an uninstall
  -- (it is scoped to the signing key, user and device), so this is how a
  -- re-scanned QR finds the row the phone used to be. It never authorises
  -- anything alone - a pairing token always does - and the org prefix keeps the
  -- same phone from correlating across tenants.
  ADD COLUMN IF NOT EXISTS hardware_hash text,
  -- sha256 of the recovery secret the handset holds in Block Store. The raw
  -- value exists only in the response that issued it and on the phone.
  ADD COLUMN IF NOT EXISTS recovery_secret_hash text,
  -- The secret the current one replaced. Accepted ONLY together with the public
  -- key the replacement was issued to: that is a retry of a recovery whose
  -- response was lost in transit, and refusing it would strand the phone.
  ADD COLUMN IF NOT EXISTS recovery_secret_prev_hash text,
  -- Which install of the app currently owns this row. It bumps when a DIFFERENT
  -- Keystore key takes the row over, and namespaces the upload idempotency key
  -- (calls.controller.ts). Without it a reinstalled app, whose local row ids
  -- restart at 1, would send `local-1` again, match the OLD install's call, and
  -- have its new recording silently acknowledged and dropped. 0 = never taken
  -- over, which keeps every existing call's stored key exactly as it is.
  ADD COLUMN IF NOT EXISTS install_epoch integer NOT NULL DEFAULT 0,
  -- When a returning phone last took this row back. Shown in the console.
  ADD COLUMN IF NOT EXISTS relinked_at timestamptz;

COMMENT ON COLUMN devices.hardware_hash IS
  'Routing hint for recovery: sha256(org_id:handset hash of ANDROID_ID). Never a credential.';
COMMENT ON COLUMN devices.install_epoch IS
  'Bumps when a new app install takes this row over; namespaces calls.idempotency_key.';

-- The hardware-match lookup runs inside `register`, scoped to the token's own
-- org and instance. Partial: every row enrolled before this migration is NULL.
CREATE INDEX IF NOT EXISTS devices_hardware_hash
  ON devices (org_id, instance_id, hardware_hash)
  WHERE hardware_hash IS NOT NULL;

-- A pairing token that re-links ONE existing row instead of adding a device.
-- CASCADE because a token that names a row that no longer exists can only fail.
-- No new table, so verify-rls.js is unaffected: both tables already carry
-- org_id under FORCE RLS, and table-level grants cover new columns.
ALTER TABLE enrollment_tokens
  ADD COLUMN IF NOT EXISTS relink_device_id uuid REFERENCES devices(id) ON DELETE CASCADE;
