-- Refresh-token hash for enrolled devices (design doc §3.2: long-lived refresh
-- token bound to the device's hardware key; only the hash is stored).
ALTER TABLE devices ADD COLUMN refresh_token_hash text;
