-- 0075_down.sql — the documented, tested reversal of 0075_boards.sql.
--
-- Deliberately NOT in the runner's path: this is a hand-run script, kept beside
-- the migration so the rollback is a reviewed artefact rather than something
-- improvised at 2am against production.
--
-- ── WHAT COMES BACK, AND WHY IT IS SAFE ───────────────────────────────────
--
-- The board layer stores no stage (see 0075's header). Dropping these four
-- tables therefore loses no lifecycle data: every board falls back to rendering
-- one column per stage in last_activity_at order, which is exactly what
-- /owner/board and /owner/deals do today. The only thing genuinely lost is card
-- ORDERING within a column — an ordering hint a human dragged, not a fact about
-- the business.
--
-- ── WHAT IS DELIBERATELY LEFT STANDING ────────────────────────────────────
--
--   lead_stage_transitions, crm_bridge_failures — audit history with no other
--     home. A rollback of a feature must not erase the record of what that
--     feature observed while it was on.
--   lead_projects — the recovered second/third project on a lead. It was
--     reconstructed from call_projects, but a human may since have corrected a
--     row to source='human', and that correction exists nowhere else.
--   deals/leads.assigned_telecaller_id, devices.crm_board_enabled — unread and
--     harmless once the code is rolled back, and dropping them throws away a
--     tenant's assignment work, which is real human effort.
--
-- All four are cheap to keep and expensive to recreate. Drop them by hand only
-- if the feature is being abandoned permanently.
--
-- 0076 attaches stage_write_guard to leads/deals. If 0076 has been applied,
-- run its own down (two DROP TRIGGERs) FIRST — otherwise every stage write in
-- the rolled-back code raises, because applyColumnMove is gone and nothing
-- remains to set app.stage_writer.

DROP TABLE IF EXISTS board_cards          CASCADE;
DROP TABLE IF EXISTS board_column_stages  CASCADE;
DROP TABLE IF EXISTS board_columns        CASCADE;
DROP TABLE IF EXISTS boards               CASCADE;

DROP FUNCTION IF EXISTS board_columns_guard();

-- Left in place on purpose: stage_write_guard() is referenced by 0076's
-- triggers. Dropping the function here would break a partial rollback that
-- stops at 0076. It is inert while unattached.
