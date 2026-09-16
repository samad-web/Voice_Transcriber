-- Per-instance ASR diarization, because it is the largest line on the invoice.
--
-- Sarvam prices speech-to-text at ₹30/audio-hour for batch and ₹45/audio-hour
-- for batch WITH diarization. The worker hard-coded `withDiarization: true`, so
-- every call on every instance has been paying the ₹45 rate since the batch API
-- was adopted - a 50% premium on ~82% of the per-call bill.
--
-- WHAT ACTUALLY NEEDS IT
--   Not the lead. `analyzeTranscript` - the tenant extraction that produces the
--   lead, the facts and the CRM payload - reads the FLAT transcript text and
--   never looks at a segment. Diarized segments feed only the enrichment half:
--   the Agent/Customer role pass, per-turn intents, talk-ratio coaching metrics
--   and the `diarized` flag in the CRM payload. An instance that does not look
--   at those is paying the premium for nothing.
--
-- WHY IT IS A POLICY AND NOT A FALLBACK
--   Diarization cannot be added to a call after the fact. The provider
--   transcribed the audio once and billed for it; asking again is a second full
--   charge. So this is decided per instance BEFORE submission, and there is no
--   runtime path that "upgrades" a call later.
--
-- THE DEFAULT IS SPLIT, DELIBERATELY
--   Added with DEFAULT true so every instance that already exists keeps the
--   exact behaviour it has today - nobody's talk-ratio dashboard changes because
--   a migration ran. The default is then flipped to false, so instances created
--   from here on start on the cheaper tier and turn it on only if they use the
--   coaching features. Flipping an existing instance is an operator decision,
--   one UPDATE per instance, made with knowledge of who actually reads those
--   metrics.
--
--   Written as two statements rather than one so re-running this migration is
--   inert: ADD COLUMN IF NOT EXISTS skips, SET DEFAULT is idempotent, and no
--   instance an operator has already switched off gets silently switched back on
--   by a backfill UPDATE.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS asr_diarization boolean NOT NULL DEFAULT true;

ALTER TABLE organizations
  ALTER COLUMN asr_diarization SET DEFAULT false;

COMMENT ON COLUMN organizations.asr_diarization IS
  'Ask the ASR provider for acoustic speaker separation (₹45/audio-hour) '
  'instead of a plain transcript (₹30). Only the enrichment half uses it - '
  'role labelling, per-turn intents and talk metrics; lead extraction reads '
  'the flat text. Cannot be applied retroactively without paying to '
  'transcribe the call a second time.';
