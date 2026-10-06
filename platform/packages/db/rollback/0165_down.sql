-- 0165_down.sql - reverse the `resources` primitive.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0165_down.sql
--
-- ── READ THIS FIRST: THIS DESTROYS INVENTORY ────────────────────────────────
--
-- `resources` is the tenant's stock list - their flats, vehicles, chairs,
-- batches and departures - and `resource_custom_field_values` is every typed
-- field somebody filled in on them. Neither is re-derivable from anything else
-- in the schema. Keep them before running this:
--
--   \copy (SELECT * FROM resources) TO 'resources.csv' CSV HEADER
--   \copy (SELECT * FROM resource_custom_field_values) TO 'resource-fields.csv' CSV HEADER
--
-- ── 0166 MUST GO FIRST ──────────────────────────────────────────────────────
--
-- `appointments.resource_id` references this table. Run 0166_down.sql before
-- this file, or the DROP below fails on the dependency. The failure is loud and
-- harmless - nothing is half-dropped - but it is the expected first result of
-- running these in the wrong order.
--
-- ── WHAT IS NOT DROPPED ─────────────────────────────────────────────────────
--
-- `custom_field_definitions` rows with object_type = 'resource' are LEFT IN
-- PLACE and deleted explicitly below instead of being cascaded, because the
-- definitions table is shared with contacts, accounts and deals and dropping it
-- is not on the table. A definition left behind for an object the API no longer
-- knows renders as an empty tab on three screens, so it goes.
--
--   SELECT id, key, label FROM custom_field_definitions WHERE object_type = 'resource';
--
-- The seeded `role_permissions` rows go too. Nothing is lost: nobody held
-- `resource` before 0165, so removing the grants returns the grid to exactly
-- what it was. An owner who hand-edited those cells afterwards loses that edit,
-- which is the one thing worth checking first:
--
--   SELECT r.key, rp.action, rp.scope FROM role_permissions rp
--     JOIN roles r ON r.id = rp.role_id
--    WHERE rp.object_type = 'resource' AND NOT r.is_system;

BEGIN;

-- 1. The value table first and explicitly, rather than relying on the CASCADE,
--    so the statement says what it destroys.
DROP TABLE IF EXISTS resource_custom_field_values;
DROP TABLE IF EXISTS resources;

-- 2. Definitions for an object type that no longer exists. Their values went
--    with the table above.
DELETE FROM custom_field_definitions WHERE object_type = 'resource';

-- 3. The permission grants. Custom roles are included even though 0165 never
--    seeded them: a row for this object type can only have come from 0165 or
--    from somebody editing the grid afterwards, and leaving orphan grants for
--    an object the API no longer knows is worse than losing a hand edit the
--    header told you to check for.
DELETE FROM role_permissions WHERE object_type = 'resource';

DELETE FROM schema_migrations WHERE name = '0165_resources.sql';

COMMIT;
