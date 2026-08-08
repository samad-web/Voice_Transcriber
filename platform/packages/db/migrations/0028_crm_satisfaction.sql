------------------------------------------------------------------------------
-- 0028 — "are you happy with your CRM?"
--
-- Asked only when has_crm = 'yes'. Owner's request, 2026-08-09.
--
-- WHY IT IS WORTH A COLUMN
--
-- "Do you use a CRM?" tells a salesperson whether to pitch a connector. It does
-- not tell them whether the customer WANTS one. Someone happy with LeadSquared
-- wants Aura to feed it; someone unhappy is a candidate for the custom build,
-- which is the larger transaction. The funnel had no way to tell those two
-- apart before the call.
--
-- Nullable, and it must stay nullable: the question is conditional, so NULL is
-- the correct and common answer for everyone who does not have a CRM. A default
-- would fabricate an opinion nobody expressed.
------------------------------------------------------------------------------

ALTER TABLE marketing.funnel_submissions
  ADD COLUMN IF NOT EXISTS crm_satisfied text;

ALTER TABLE marketing.funnel_submissions
  DROP CONSTRAINT IF EXISTS funnel_submissions_crm_satisfied_check;

ALTER TABLE marketing.funnel_submissions
  ADD CONSTRAINT funnel_submissions_crm_satisfied_check
  CHECK (crm_satisfied IS NULL OR crm_satisfied IN ('happy', 'mixed', 'unhappy'));

------------------------------------------------------------------------------
-- The same column on the history table.
--
-- 0020 records every submission's ANSWERS as a history row, so a repeat
-- enquirer's changing answers are visible rather than overwritten. A new answer
-- that lands only on the submission would be invisible the moment someone fills
-- the form twice — and "we were unhappy with our CRM in March and fine with it
-- in August" is exactly the kind of change this table exists to capture.
------------------------------------------------------------------------------

ALTER TABLE marketing.funnel_contact_history
  ADD COLUMN IF NOT EXISTS crm_satisfied text;

ALTER TABLE marketing.funnel_contact_history
  DROP CONSTRAINT IF EXISTS funnel_contact_history_crm_satisfied_check;

ALTER TABLE marketing.funnel_contact_history
  ADD CONSTRAINT funnel_contact_history_crm_satisfied_check
  CHECK (crm_satisfied IS NULL OR crm_satisfied IN ('happy', 'mixed', 'unhappy'));

------------------------------------------------------------------------------
-- Grants
--
-- The two tables are NOT granted the same way, and only one of them needs
-- anything here. Checked against the migrations rather than assumed:
--
--   funnel_submissions      0020:221 grants SELECT, INSERT, UPDATE **table-wide**.
--                           A table-wide UPDATE covers columns added later, so
--                           crm_satisfied is already writable. Nothing needed.
--
--   funnel_contact_history  0020:222 grants only SELECT, INSERT. 0022 then added
--                           UPDATE on a NAMED COLUMN LIST, so that the audit
--                           columns stay write-once. A column-scoped grant does
--                           NOT extend to new columns.
--
-- So the statement below is load-bearing exactly once. Without it the public
-- site would capture this answer and fail with "permission denied for column
-- crm_satisfied" the first time a repeat visitor ticked it — at step 2, which
-- is the step 0022 already had to repair for precisely this reason.
------------------------------------------------------------------------------

GRANT UPDATE (crm_satisfied) ON marketing.funnel_contact_history TO aura_marketing;
