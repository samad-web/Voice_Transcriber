-- 0160_down.sql - reverse sticky lead ownership.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0160_down.sql
--
-- ── READ THIS BEFORE RUNNING IT ─────────────────────────────────────────────
--
-- Narrowing `strategy` back to two values FAILS while any rule is still
-- sticky, and that failure is the useful behaviour: it refuses rather than
-- deciding on its own how a tenant's rules should now distribute. Find them
-- first, and have somebody choose:
--
--   SELECT id, name, sticky_window_days, sticky_fallback
--     FROM lead_routing_rules
--    WHERE strategy = 'sticky' AND deleted_at IS NULL;
--
-- A sticky rule's honest reversal is its own configured fallback, which is the
-- policy the tenant already chose for every lead sticky could not resolve. The
-- statement below applies exactly that, and parks a rule whose fallback was
-- 'unassigned' on `status = 'paused'` instead of silently turning it into a
-- rotation nobody asked for.
--
-- ── WHAT IS DELIBERATELY KEPT ───────────────────────────────────────────────
--
-- Every `lead_routing_assignments` row with `strategy = 'sticky'`. That column
-- is denormalised precisely so a decision survives the rule that made it
-- (0105), and there is no CHECK on it, so nothing here needs to touch it.
-- Deleting the history of who got which lead, to undo a feature, would answer
-- a question nobody asked by destroying the answer to the one they will.
--
-- The two columns ARE dropped, so re-running 0160 afterwards starts clean. Any
-- window and fallback a tenant had typed is lost with them; print the query
-- above first if that configuration matters.

BEGIN;

-- One statement, so the targets that are zeroed are exactly the rules that
-- were converted - no second predicate that could drift from the first.
WITH converted AS (
  UPDATE lead_routing_rules
     SET strategy = CASE sticky_fallback
                      WHEN 'percentage' THEN 'percentage'
                      ELSE 'round_robin'
                    END,
         status   = CASE WHEN sticky_fallback = 'unassigned' THEN 'paused' ELSE status END,
         -- The allocation window restarts for the same reason the API restarts
         -- it on any strategy change: `delivered` counts accumulated under
         -- stickiness mean nothing under a percentage split.
         window_started_at = now(),
         cursor = 0
   WHERE strategy = 'sticky'
  RETURNING id
)
UPDATE lead_routing_targets t SET delivered = 0
  FROM converted c WHERE c.id = t.rule_id;

ALTER TABLE lead_routing_rules DROP CONSTRAINT IF EXISTS lead_routing_rules_sticky_configured;
ALTER TABLE lead_routing_rules DROP CONSTRAINT IF EXISTS lead_routing_rules_sticky_fallback_check;
ALTER TABLE lead_routing_rules DROP CONSTRAINT IF EXISTS lead_routing_rules_sticky_window_days_check;

ALTER TABLE lead_routing_rules DROP COLUMN IF EXISTS sticky_fallback;
ALTER TABLE lead_routing_rules DROP COLUMN IF EXISTS sticky_window_days;

-- Back to 0105's pair. Named now where 0105 declared it inline, which is the
-- same name Postgres generated then, so a re-run of 0160 drops it cleanly.
ALTER TABLE lead_routing_rules DROP CONSTRAINT IF EXISTS lead_routing_rules_strategy_check;
ALTER TABLE lead_routing_rules ADD CONSTRAINT lead_routing_rules_strategy_check
  CHECK (strategy IN ('round_robin', 'percentage'));

DELETE FROM schema_migrations WHERE name = '0160_sticky_lead_routing.sql';

COMMIT;
