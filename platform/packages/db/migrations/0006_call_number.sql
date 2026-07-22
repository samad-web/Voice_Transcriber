-- Human-friendly call label. The device may send the other party's number when
-- it has permission; the server stores only a short leading prefix (first 5
-- digits) for display alongside the existing last-3 + hash. Still privacy-lite:
-- never the full number.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS remote_number_prefix text;
