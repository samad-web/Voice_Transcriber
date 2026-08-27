-- 0066_app_lock_password.sql — per-instance mobile app lock. One password set
-- on the Instance page in the CRM, hashed here, synced to every device
-- enrolled under the org via the existing devices/me/config document so the
-- Android app can verify it offline. NULL = no lock (default, backward
-- compatible with every already-enrolled fleet).

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS app_lock_password_hash text;
