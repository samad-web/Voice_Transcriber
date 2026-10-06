-- 0158_down.sql - reverse call suppression and the DNC lists.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0158_down.sql
--
-- ── READ THIS FIRST: THIS ONE DELETES OPT-OUTS ──────────────────────────────
--
-- Narrowing `messaging_opt_outs.channel` back to three values cannot be done
-- while any `channel = 'call'` row exists - the constraint would simply refuse
-- to go back on - so those rows are DELETED below. Every one of them is somebody
-- who asked not to be rung, and 0111's whole design is that such a request is
-- never deleted.
--
-- Keep them before running this. They are small and they are the only copy:
--
--   \copy (SELECT * FROM messaging_opt_outs WHERE channel = 'call') TO 'call-optouts.csv' CSV HEADER
--
-- Dropping the two DNC tables discards the uploaded lists themselves. Those are
-- usually re-uploadable from the sheet or the registry they came from, which is
-- why they are dropped outright rather than preserved - but a tenant's own
-- `kind = 'internal'` list may not be:
--
--   \copy (SELECT l.name, l.kind, e.number_key FROM dnc_entries e
--            JOIN dnc_lists l ON l.id = e.list_id WHERE l.kind = 'internal')
--     TO 'internal-dnc.csv' CSV HEADER
--
-- The seeded `role_permissions` rows are removed too. Nothing is lost there:
-- nobody held either object type before 0158, so taking the grants away returns
-- the grid to exactly what it was. An owner who hand-edited those cells
-- afterwards loses that edit, which is the one thing worth checking:
--
--   SELECT r.key, rp.object_type, rp.action, rp.scope
--     FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
--    WHERE rp.object_type IN ('dnc', 'contact_number') AND NOT r.is_system;

BEGIN;

-- 1. The bulk lists. `dnc_entries` goes first and explicitly, rather than
--    relying on the CASCADE, so the statement says what it destroys.
DROP TABLE IF EXISTS dnc_entries;
DROP TABLE IF EXISTS dnc_lists;

-- 2. The permission grants. Custom roles are included here even though 0158
--    never seeded them: a row for these object types can only have come from
--    0158 or from somebody editing the grid afterwards, and leaving orphan
--    grants for an object type the API no longer knows is worse than losing a
--    hand edit the header told you to check for.
DELETE FROM role_permissions WHERE object_type IN ('dnc', 'contact_number');

-- 3. The call opt-outs, and then the narrowed CHECK. See the header - this is
--    the destructive half, and the order matters: the rows cannot survive the
--    constraint and the constraint cannot be added before the rows are gone.
DELETE FROM messaging_opt_outs WHERE channel = 'call';

ALTER TABLE messaging_opt_outs DROP CONSTRAINT IF EXISTS messaging_opt_outs_channel_check;
ALTER TABLE messaging_opt_outs ADD CONSTRAINT messaging_opt_outs_channel_check
  CHECK (channel IN ('whatsapp', 'sms', 'email'));

-- 0111 declared the CHECK inline and carried no comment on the column, so the
-- comment 0158 added goes with it.
COMMENT ON COLUMN messaging_opt_outs.channel IS NULL;

DELETE FROM schema_migrations WHERE name = '0158_call_suppression_and_dnc.sql';

COMMIT;
