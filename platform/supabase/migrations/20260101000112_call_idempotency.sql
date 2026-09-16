-- Retries actually resuming the same call, instead of orphaning it forever.
--
-- POST /v1/calls has accepted an `idempotencyKey` from every device build since
-- day one, but nothing on the server ever looked at it (checklist §2.2). Every
-- retry - and the client retries automatically, with the SAME key, whenever an
-- upload fails partway through - inserted a brand new `calls` row instead of
-- resuming the old one. The old row stayed in AWAITING_AUDIO forever: there is
-- no sweeper for that state (calls.controller.ts, migration 0019), so it just
-- sat there, invisible, while the retry's new row took another shot at the
-- same recording. Bigger recordings take longer to PUT over a rep's mobile
-- connection, so they are the ones most likely to get interrupted mid-upload -
-- which is why this showed up as "long calls always end up Awaiting audio".
--
-- The fix is in calls.controller.ts: a create() call whose idempotencyKey
-- matches a row this device already has in AWAITING_AUDIO reuses that row's id
-- and S3 key instead of inserting a second one.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Scoped to AWAITING_AUDIO ON PURPOSE, not to the device generally. Once a call
-- leaves that state (uploaded, failed, whatever) its key stops mattering -
-- a later retry with the same key is free to insert a fresh row exactly as it
-- does today. Constraining the lookup this way is what lets two concurrent
-- retries for the same still-in-flight upload race safely (the loser's INSERT
-- is rejected, not silently duplicated) without also having to reconcile keys
-- against every terminal status a call could already be in.
CREATE UNIQUE INDEX IF NOT EXISTS calls_device_idempotency_key_inflight
  ON calls (device_id, idempotency_key)
  WHERE status = 'AWAITING_AUDIO' AND idempotency_key IS NOT NULL;

-- New terminal status: audio that never arrived and never will. Distinct from
-- the existing FAILED_* stages, which all mean "we had the audio and a later
-- stage blew up" - retrying THOSE from UPLOADED makes sense because the audio
-- is sitting in S3 waiting. A call stuck in AWAITING_AUDIO has no audio to
-- resume from, so retrying it the same way would just fail again at transcode
-- with a confusing "no such key" error. FAILED_UPLOAD is written by the
-- worker's stall sweep (retry.ts) once a call has sat in AWAITING_AUDIO far
-- longer than any real upload could take, and is deliberately given no
-- next_attempt_at: nothing server-side can complete it, only the handset
-- re-uploading from scratch (a fresh idempotency key, a fresh row) can.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_status_check CHECK (status IN (
  'AWAITING_AUDIO', 'UPLOADED', 'TRANSCODING', 'TRANSCRIBING',
  'ANALYZING', 'SYNCING', 'COMPLETE', 'TRANSCRIPTION_OFF',
  'FAILED_TRANSCODE', 'FAILED_ASR', 'FAILED_ANALYZE', 'FAILED_CRM',
  'FAILED_UPLOAD'));
