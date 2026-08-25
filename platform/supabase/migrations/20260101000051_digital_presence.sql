------------------------------------------------------------------------------
-- 0051 — where to find this business online
--
-- The funnel asks six multiple-choice questions and collects a name, a number
-- and an email. All of it is self-reported, and none of it answers the question
-- somebody actually asks before a sales call: who ARE these people. A website,
-- an Instagram handle or a Google Business listing answers it in ten seconds.
--
-- ── WHY 0051 AND NOT 0034 ──────────────────────────────────────────────────
--
-- The number is a gap on purpose. The branch this ships from carries the CRM
-- Phase 1 work at 0034-0050, none of which is in production yet, while the
-- deployed branch stops at 0033. Taking 0034 here would collide with a
-- DIFFERENT 0034 the moment the two branches meet — and `schema_migrations`
-- keys on the filename, so the loser would be recorded as applied without ever
-- having run. A number free on both branches costs nothing: the runner applies
-- whatever it has not seen, in name order, and this touches only the marketing
-- schema so it has no ordering relationship with the CRM tables at all.
------------------------------------------------------------------------------

-- FREE TEXT, not a url column.
--
-- "Website, social media or any digital presence" is answered with
-- "instagram.com/ourshop", "@ourshop", "we only have a Facebook page", or three
-- links at once. A `text` column takes all of those. A url type, or a CHECK
-- that insisted on a scheme, would reject the honest answers and teach people
-- to type something fake to get past it — which is worse than a blank, because
-- a blank is at least true.
--
-- Nullable, and it stays nullable: this is optional on the form. A required
-- field on a lead form is paid for in leads, and plenty of real businesses in
-- this market have no web presence at all — which is itself worth knowing, and
-- is exactly what NULL records.
ALTER TABLE marketing.funnel_submissions
  ADD COLUMN IF NOT EXISTS digital_presence text;

-- The same answer on the fill that produced it.
--
-- `funnel_contact_history` is one row per FILL, while the submission is one row
-- per person — a returning enquirer overwrites their submission but adds a
-- history row. Without this column, somebody who fills the form twice loses the
-- first answer entirely, and the history stops being a faithful record of what
-- was said each time.
ALTER TABLE marketing.funnel_contact_history
  ADD COLUMN IF NOT EXISTS digital_presence text;

------------------------------------------------------------------------------
-- Grants
--
-- NONE NEEDED, and that is worth stating rather than leaving as an absence.
--
-- 0020 granted `SELECT, INSERT, UPDATE` on these tables TABLE-WIDE, not
-- column-by-column, and a table-scoped grant automatically covers columns added
-- later. The column-scoped kind does not, which is what 0022, 0027, 0028 and
-- 0029 each had to correct after the website failed at runtime with
-- "permission denied for column".
--
-- Checked before writing this file rather than assumed, because the failure
-- mode is a public form that accepts an enquiry and then 500s on submit.
------------------------------------------------------------------------------
