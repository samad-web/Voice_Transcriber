-- Idempotent retries reusing a call that already has its audio - 0101 only
-- covered a call still mid-upload.
--
-- 0101 fixed the interrupted-upload case: a retry with the same idempotency
-- key resumes the SAME call while it is still AWAITING_AUDIO. It left one gap:
-- a retry that arrives AFTER the audio already finished uploading, because the
-- handset never saw the success response (POST /complete committed, but the
-- connection dropped before its response got back). That retry fell through
-- to the ordinary insert path and created a second, fully duplicate call -
-- a second ASR charge, a second analyze, a second CRM sync, for audio the
-- pipeline had already processed once.
--
-- calls.controller.ts now widens the reuse lookup from "status =
-- AWAITING_AUDIO" to "status <> FAILED_UPLOAD": every other status in the
-- machine - COMPLETE and every pipeline FAILED_* stage included - is only
-- reachable by way of a call that DID receive its audio, so reusing the row
-- (and, in POST /complete, acknowledging it as already done instead of
-- re-running the pipeline) is safe there too. FAILED_UPLOAD stays excluded:
-- it means audio was never received at all, so a retry against it is a
-- genuinely fresh attempt, not a replay of one that already succeeded.
DROP INDEX IF EXISTS calls_device_idempotency_key_inflight;

CREATE UNIQUE INDEX IF NOT EXISTS calls_device_idempotency_key_active
  ON calls (device_id, idempotency_key)
  WHERE status <> 'FAILED_UPLOAD' AND idempotency_key IS NOT NULL;
