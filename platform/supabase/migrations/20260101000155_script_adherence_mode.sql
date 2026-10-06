-- 0155_script_adherence_mode.sql - which measure of "did the rep follow the
-- script" this workspace actually uses.
--
-- ── THE PROBLEM: TWO SCORES, NO CHOICE ──────────────────────────────────────
--
-- Since 0069 every enriched call carries `call_analytics.quality_criteria ->
-- scriptAdherence`, a 0-10 the model produces from its own notion of a good
-- call. Since 0091 a tenant can also write their own checklist (`call_sops`)
-- and every call is scored step by step against it, with a quote per step.
--
-- Both have run at once, and nothing anywhere said which one counts. The
-- console shows the AI number on the call page and in the insights PDF, the
-- SOP percentage on the scorecards, and the two disagree routinely - they are
-- measuring different things. A manager looking at a rep had two numbers and no
-- rule for which to believe, which in practice means believing neither.
--
-- ── WHAT THIS ADDS: ONE SWITCH, IN THE OWNER'S WORDS ────────────────────────
--
-- `script_adherence_mode` is the answer to "scored against whose idea of a good
-- call": the model's, or ours.
--
--   'ai'  - the model's general read. No checklist is loaded into the prompt
--           and no `call_sop_results` row is written, so there is exactly one
--           adherence number on the call and it is the AI one. This is the
--           mode for a tenant who has not written a script, which is most of
--           them on day one.
--
--   'sop' - the steps the owner or manager wrote. The active SOP goes into the
--           prompt and the per-step verdicts are stored as before.
--
-- Deliberately ONE column rather than two booleans. Two switches would let a
-- tenant turn both on and be back where they started - two numbers, no rule -
-- or both off, which is a quality page that silently measures nothing.
--
-- ── WHAT THIS DOES NOT SWITCH OFF ───────────────────────────────────────────
--
-- The rest of `quality_criteria` (professionalism, conversionSignal, consent
-- disclosure) is untouched in both modes, and so is the conversation read that
-- produces the summary, the intent and the lead. This governs the ADHERENCE
-- measure alone: it is not a switch for "AI on the calls", which is the
-- `call_intel` module's job (0072) and sits a long way above this.
--
-- Past scores are untouched either way. `call_sop_results` rows already
-- written stay exactly where they are, for the reason 0091 gives - they are the
-- record of what was judged, not a live view - so flipping to 'ai' hides the
-- panel on new calls without rewriting the history of old ones.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS script_adherence_mode text NOT NULL DEFAULT 'ai';

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_script_adherence_mode_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_script_adherence_mode_check
  CHECK (script_adherence_mode IN ('ai', 'sop'));

COMMENT ON COLUMN organizations.script_adherence_mode IS
  'Which adherence measure this workspace uses: ''ai'' (quality_criteria -> '
  'scriptAdherence) or ''sop'' (call_sop_results, migration 0091). The worker '
  'reads it to decide whether to load the active SOP into the prompt.';

-- ── Backfill: whatever each tenant is doing TODAY ──────────────────────────
--
-- The default is 'ai' because that is the behaviour of a tenant with no
-- checklist, but an org that has already activated one is being scored against
-- it right now. Leaving them on the default would silently switch their
-- checklist off on deploy - the one thing a migration that adds a switch must
-- not do.
UPDATE organizations o
   SET script_adherence_mode = 'sop'
 WHERE EXISTS (SELECT 1 FROM call_sops s WHERE s.org_id = o.id AND s.is_active);
