-- Per-instance switch for transcription, without switching off the instance.
--
-- `organizations.status` already has an off switch, but it is the wrong one for
-- this: a suspended org is refused at upload admission, so its handsets stop
-- recording and the calls never arrive at all. What an operator often wants is
-- narrower — keep collecting the customer's call log, just stop spending money
-- on ASR and the LLM for it. Reasons range from the mundane (the customer is
-- mid-trial, or hasn't paid) to the urgent (the ASR provider is down or out of
-- credit and every attempt is failing anyway).
--
-- Defaults to true so every existing tenant is bit-for-bit unaffected.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS transcription_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN organizations.transcription_enabled IS
  'When false, calls are still ingested, stored and listed — the pipeline skips '
  'ASR and analysis and lands them on TRANSCRIPTION_OFF instead. Unrelated to '
  'organizations.status, which refuses the upload outright.';

-- A call that was deliberately not transcribed is not COMPLETE and not FAILED.
--
-- Reusing COMPLETE would make "we chose not to transcribe this" indistinguishable
-- from "we transcribed it and got nothing", which is exactly the kind of quiet
-- ambiguity that sends someone hunting through worker logs. It is a terminal
-- state: nothing retries it, and turning transcription back on plus a reprocess
-- is what moves it forward.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_status_check CHECK (status IN (
  'AWAITING_AUDIO', 'UPLOADED', 'TRANSCODING', 'TRANSCRIBING',
  'ANALYZING', 'SYNCING', 'COMPLETE', 'TRANSCRIPTION_OFF',
  'FAILED_TRANSCODE', 'FAILED_ASR', 'FAILED_ANALYZE', 'FAILED_CRM'));
