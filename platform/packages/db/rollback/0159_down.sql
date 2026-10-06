-- 0159_down.sql - reverse the dialer's schema.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0159_down.sql
--
-- ── WHAT THIS DESTROYS ──────────────────────────────────────────────────────
--
-- Every campaign, every queue item and every attempt. Two of those are
-- rebuildable and one is not:
--
--   dial_campaigns    a supervisor's settings. Small, and re-enterable.
--   dial_queue_items  materialised from a source by `POST .../build`. Entirely
--                     derivable again - that is why the source is stored as a
--                     reference and never frozen as an id list.
--   dial_attempts     THE ONLY RECORD THAT A NUMBER WAS DIALLED. A dial that
--                     never connected produced no `calls` row (that is the
--                     whole reason this table exists, §7), so dropping it
--                     erases those events from the system completely. "How
--                     many numbers did we try" becomes unanswerable for every
--                     campaign that ever ran.
--
-- Keep them first. They are small and they are the only copy:
--
--   \copy (SELECT a.*, q.number_key, c.name AS campaign
--            FROM dial_attempts a
--            JOIN dial_queue_items q ON q.id = a.queue_item_id
--            JOIN dial_campaigns   c ON c.id = a.campaign_id)
--     TO 'dial-attempts.csv' CSV HEADER
--
-- Nothing in `calls` is touched. A dialled call is an ordinary SIM call and
-- the pipeline never knew a queue chose the number (§12); the only trace is
-- `dial_attempts.call_id`, which lives in the table being dropped.
--
-- The seeded `role_permissions` rows go too. Nothing is lost: nobody held
-- `dial_campaign` before 0159, so removing the grants returns the grid to
-- exactly what it was. The one thing worth checking first is a hand edit an
-- owner made afterwards:
--
--   SELECT r.key, rp.action, rp.scope
--     FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
--    WHERE rp.object_type = 'dial_campaign' AND NOT r.is_system;

BEGIN;

-- 1. The three tables, child-first and explicitly, rather than relying on the
--    CASCADE - so the statement says what it destroys.
DROP TABLE IF EXISTS dial_attempts;
DROP TABLE IF EXISTS dial_queue_items;
DROP TABLE IF EXISTS dial_campaigns;

-- 2. The permission grants. Custom roles are included even though 0159 never
--    seeded them: a row for this object type can only have come from 0159, from
--    `seedCrmDefaults` provisioning a new org, or from somebody editing the
--    grid - and leaving orphan grants for an object the API no longer knows is
--    worse than losing the hand edit the header told you to check for.
DELETE FROM role_permissions WHERE object_type = 'dial_campaign';

-- Note what is deliberately NOT reversed: `PermissionObjectType` in
-- @aura/shared still lists `dial_campaign`, so `seedCrmDefaults` will seed it
-- again for the next org provisioned. That is harmless (a grant on an object
-- with no routes enforces nothing, which is what ENFORCED_PERMISSIONS exists
-- to say) and removing it belongs with the code, not with this file.

DELETE FROM schema_migrations WHERE name = '0159_dial_campaigns.sql';

COMMIT;
