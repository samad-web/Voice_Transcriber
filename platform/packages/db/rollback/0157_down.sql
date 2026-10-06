-- 0157_down.sql - reverse the dialable-number vault.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0157_down.sql
--
-- ── WHAT THIS DESTROYS ──────────────────────────────────────────────────────
--
-- Dropping `contact_numbers` discards every callable number the platform holds,
-- along with the consent basis and the frozen evidence for it. There is nowhere
-- else any of that lives:
--
--   * numbers seeded from inbound calls are recoverable - `calls
--     .remote_number_full` is untouched by 0157 and the backfill can be re-run;
--   * numbers that arrived by web form, import, partner or card scan are NOT.
--     Nothing else in the schema stores them, and `lead_intake_events.payload`
--     (0078) is an audit ledger, not a field store you can rebuild a vault from.
--
-- So before running this, keep what cannot be rebuilt:
--
--   \copy (SELECT * FROM contact_numbers WHERE source <> 'call') TO 'vault.csv' CSV HEADER
--
-- The `auth_events` disclosure rows (0127) written every time somebody revealed
-- a number are deliberately KEPT. They record that a human saw a number, which
-- stays true after the number is gone, and deleting them would make the audit
-- trail quieter than the facts.
--
-- ── AND WHAT IT LOSES SILENTLY ──────────────────────────────────────────────
--
-- Dropping `dialer_allows_unknown_consent` erases which owners had explicitly
-- accepted the risk of dialling `unknown`-basis numbers. That is a decision a
-- person made out loud and it is not re-derivable, so note them first if the
-- intent matters:
--
--   SELECT id, name FROM organizations WHERE dialer_allows_unknown_consent;

BEGIN;

DROP TABLE IF EXISTS contact_numbers;

-- The trigger went with the table. `set_updated_at()` is shared by most of the
-- schema and is deliberately left standing.

ALTER TABLE organizations DROP COLUMN IF EXISTS dialer_allows_unknown_consent;

-- The calling window goes too. Same caveat as above and worth more: a tenant who
-- narrowed their window to 10:00-18:00 has made a deliberate choice about when
-- their customers may be rung, and re-applying 0157 hands them the 09:00-21:00
-- default back. Capture it before rolling back if these have been in use:
--
--   SELECT id, name, calling_window_start_hour, calling_window_end_hour
--     FROM organizations
--    WHERE (calling_window_start_hour, calling_window_end_hour) <> (9, 21);
ALTER TABLE organizations DROP COLUMN IF EXISTS calling_window_start_hour;
ALTER TABLE organizations DROP COLUMN IF EXISTS calling_window_end_hour;

DELETE FROM schema_migrations WHERE name = '0157_dialable_numbers_vault.sql';

COMMIT;
