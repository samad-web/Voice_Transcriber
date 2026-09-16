-- FCM push token (checklist §3.4, hardening plan §3.4).
--
-- Nullable: devices running an older app version will not have registered a
-- token yet, and the server falls back to the existing ~1h config poll.
-- No index: lookups are always by device id (the primary key), not by token.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fcm_token text;
