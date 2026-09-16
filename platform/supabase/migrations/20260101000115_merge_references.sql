-- 0115_merge_references.sql - a merge moves EVERYTHING that points at the
-- merged-away record, and a revert can move it all back (doc 23, D1).
--
-- Until now a merge repointed `deals` only, and `reassigned_deals` was the one
-- thing a revert knew how to undo. The API now repoints every reference listed
-- in apps/api/src/modules/merge/merge-references.ts - the timeline, tasks,
-- threads, quotations, invoices, journeys, tags, custom fields - so the log
-- needs somewhere to remember those moves.
--
-- Additive only. Old merge_log rows get the empty defaults, which is exactly
-- what they are: merges that moved nothing but deals, still revertable through
-- `reassigned_deals` as before.

ALTER TABLE merge_log
  -- {"table.column": [ids or keys moved from victim to survivor]}
  ADD COLUMN IF NOT EXISTS reassigned_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {"table.column": [whole rows a conflict removed or stopped]} - e.g. a tag
  -- both records carried, kept once on the survivor; restored on revert.
  ADD COLUMN IF NOT EXISTS dropped_refs jsonb NOT NULL DEFAULT '{}'::jsonb;
