-- Per-instance transcription settings: language, output mode, vocabulary.
--
-- Three things a global env var cannot express, because they are properties of
-- the CUSTOMER, not of the deployment. One instance is a Tamil brick factory,
-- the next is a Kannada clinic, and each has its own proper nouns.
--
-- language_code
--   Left to auto-detect, the recogniser occasionally picks the wrong language
--   outright - one 3-second Tamil call in this very database was transcribed as
--   Spanish. A telecalling floor almost always knows what its agents speak, so
--   naming it removes a whole class of silent, total transcription failure.
--   NULL keeps auto-detect for instances that genuinely are mixed.
--
-- mode
--   Saaras v3's output format, and the fix for brand names. In the default
--   `transcribe` mode an English name spoken inside Tamil speech comes back
--   transliterated - "RD Interlock" becomes "ஆர்டி இன்டர்லாக்", which is
--   unusable as a CRM value. `codemix` keeps English words in English and Indic
--   words in native script; `translate` renders the whole call in English.
--   Measured on a real call, both preserve "RD Interlock" verbatim.
--
-- vocabulary
--   The batch ASR API takes no hotword or custom-vocabulary parameter, so this
--   cannot bias transcription itself. It is handed to the ANALYSE stages
--   instead, which is where the value that reaches the CRM is actually decided:
--   the summary, the intents and the extracted fields all get told the
--   canonical spelling, so a mangled transcript still produces a clean record.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS asr_language text,
  ADD COLUMN IF NOT EXISTS asr_mode text,
  ADD COLUMN IF NOT EXISTS vocabulary text[] NOT NULL DEFAULT '{}';

-- Both nullable so an unset instance keeps following the deployment default;
-- the CHECKs only constrain the values that ARE set.
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_asr_mode_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_asr_mode_check
  CHECK (asr_mode IS NULL OR asr_mode IN
    ('transcribe', 'translate', 'verbatim', 'translit', 'codemix'));

-- BCP-47 as Sarvam spells it, plus 'unknown' to force auto-detect for an
-- instance even when the deployment pins a language.
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_asr_language_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_asr_language_check
  CHECK (asr_language IS NULL OR asr_language IN (
    'unknown', 'en-IN', 'hi-IN', 'bn-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN',
    'pa-IN', 'ta-IN', 'te-IN', 'gu-IN', 'as-IN', 'ur-IN', 'ne-IN', 'kok-IN',
    'ks-IN', 'sd-IN', 'sa-IN', 'sat-IN', 'mni-IN', 'brx-IN', 'mai-IN', 'doi-IN'));

COMMENT ON COLUMN organizations.asr_language IS
  'BCP-47 language this instance''s calls are spoken in. NULL = follow the '
  'deployment default (usually auto-detect).';
COMMENT ON COLUMN organizations.asr_mode IS
  'Saaras v3 output mode. codemix keeps English brand names in Latin script; '
  'translate renders the call in English. NULL = deployment default.';
COMMENT ON COLUMN organizations.vocabulary IS
  'Proper nouns and domain terms for this instance, in their canonical '
  'spelling. Fed to the analyse stages so summaries and extracted fields use '
  'the right form even when ASR mishears it.';
