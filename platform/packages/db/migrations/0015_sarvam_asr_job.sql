-- Async ASR: remember the provider-side job while it runs.
--
-- Gemini transcribes in the same request that submits the audio, so the whole
-- ASR stage fit inside one pipeline run. Sarvam's Saaras v3 does not: speaker
-- diarization and audio longer than 30s are only available on its batch API,
-- which is submit → poll → download and can take minutes on a long call.
--
-- Blocking the worker on that poll is not an option - processCall runs inside
-- withOrgContext, so it would hold a Postgres transaction and a pooled
-- connection open for the duration, for every call in flight at once.
--
-- Instead the run that submits the job stops at TRANSCRIBING and records the
-- job id here; the ASR poller finds it later and drives the rest of the
-- pipeline. The job id lives in Postgres for the same reason the retry deadline
-- does: a worker restart, a redeploy or a purged broker must not strand a call
-- whose audio the provider has already accepted and is being billed for.

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS asr_job_id text,
  ADD COLUMN IF NOT EXISTS asr_job_started_at timestamptz;

COMMENT ON COLUMN calls.asr_job_id IS
  'Provider-side batch ASR job id while the call sits in TRANSCRIBING. Cleared '
  'once the transcript lands (or the job fails). NULL for providers that '
  'transcribe inline.';
COMMENT ON COLUMN calls.asr_job_started_at IS
  'When the batch job was submitted - drives the stall sweep, so a job the '
  'provider never finishes fails loudly instead of pinning the call forever.';

-- The poller's working set: calls with a job outstanding, oldest first. Partial,
-- because outstanding jobs are a vanishing fraction of the table.
CREATE INDEX IF NOT EXISTS calls_asr_job_pending
  ON calls (asr_job_started_at)
  WHERE asr_job_id IS NOT NULL;
