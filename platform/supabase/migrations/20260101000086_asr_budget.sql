-- A monthly ASR ceiling per instance (B5).
--
-- ASR is charged per audio-hour and is ~82% of what a call costs to process, so
-- until now a single instance having an unusually busy month - or a handset
-- stuck in a loop, or a misconfigured floor uploading the same recordings twice
-- - was an unbounded bill that nobody found out about until it arrived. Every
-- other cost control added alongside this (0083 diarization, 0084 trim and cap)
-- reduces the RATE. This is the only one that bounds the TOTAL.
--
-- Metered against `usage_events` rows of kind asr_minutes / asr_minutes_diarized
-- for the current calendar month, which is what B0 started recording.
--
-- WHAT HAPPENS AT THE CEILING. The call is admitted, stored and listed exactly
-- as it is today - the customer's call log stays complete - and only the paid
-- stages are skipped. That is precisely what `TRANSCRIPTION_OFF` already means,
-- so it is reused rather than a new status added: it is terminal, it is not a
-- failure, and it is already reprocessable, which is the behaviour wanted here.
-- A call stopped by the budget can simply be reprocessed once the month rolls
-- over or the ceiling is raised. The REASON is written to error_message so an
-- operator can tell a budget stop from an instance with transcription switched
-- off deliberately.
--
-- NULL means no ceiling, which is the default and the behaviour every existing
-- instance keeps.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS asr_monthly_minutes_budget int;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_asr_budget_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_asr_budget_check
  CHECK (asr_monthly_minutes_budget IS NULL OR asr_monthly_minutes_budget >= 0);

COMMENT ON COLUMN organizations.asr_monthly_minutes_budget IS
  'Ceiling on ASR minutes per calendar month. At the ceiling, calls are still '
  'stored and listed but skip transcription and analysis (TRANSCRIPTION_OFF, '
  'with the reason in error_message). NULL = no ceiling.';

-- The budget read is one aggregate per call on instances that set one, over
-- rows that only ever grow. Indexed on the columns it actually filters.
CREATE INDEX IF NOT EXISTS usage_events_org_kind_time
  ON usage_events (org_id, kind, occurred_at DESC);
