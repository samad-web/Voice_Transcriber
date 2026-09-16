-- 0116_pipeline_stale_threshold.sql - how many days without activity before an
-- open deal on this pipeline is flagged stale on the Deals board and table.
--
-- ── WHY PER PIPELINE ────────────────────────────────────────────────────────
--
-- Not per user: a team reading the same board must see the same flags, or
-- "stale" means a different thing on every screen. Not per org: a tenant with
-- a same-week retail pipeline and a quarter-long B2B one needs a different
-- number for each, and a pipeline is already where "how deals move here" lives.
--
-- ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
--
-- Nothing automated reads it. It changes what the console SHOWS - a flag on the
-- card and a count in the column header - and never moves, notifies or messages
-- anyone. The `deal.idle` automation keeps its own per-rule `idleDays`
-- (packages/shared/src/automation.ts); the two answer different questions
-- ("what should this board highlight" vs "what should happen"), and coupling
-- them would let someone tidying a board silently re-time a rule.
--
-- Additive, with a default, so every existing pipeline reads 7 - the value the
-- console used before this column existed - and no row needs backfilling.
-- The 1..365 bounds are mirrored in apps/web/lib/deal-staleness.ts and in the
-- pipelines PATCH schema; change all three together.

ALTER TABLE deal_pipelines
  ADD COLUMN IF NOT EXISTS stale_after_days integer NOT NULL DEFAULT 7;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'deal_pipelines_stale_after_days_check'
       AND conrelid = 'deal_pipelines'::regclass
  ) THEN
    ALTER TABLE deal_pipelines
      ADD CONSTRAINT deal_pipelines_stale_after_days_check
      CHECK (stale_after_days BETWEEN 1 AND 365);
  END IF;
END $$;
