-- Per-instance ASR cost controls: how much audio to send, and when not to bother.
--
-- Both are properties of the CUSTOMER's calling pattern rather than of the
-- deployment, which is why they sit here beside asr_language / asr_mode /
-- asr_diarization (0016, 0083) and not in an env var. A brick factory taking
-- forty-minute technical calls and a clinic taking ninety-second appointment
-- calls want opposite settings, and today they share one.
--
-- asr_max_seconds  (B3)
--   Cap on the audio submitted for one call. Audio-hours concentrate in the
--   long tail: a single forty-five minute call costs more to transcribe than
--   fifty ninety-second ones, and lead qualification lives in the opening and
--   the close - the introduction, the name, the requirement, then the callback
--   time or the price agreed. Over the cap, the head and tail are stitched and
--   the middle is dropped (see audio-prep.ts).
--
--   NULL means no cap, and that is the default deliberately. Dropping the
--   middle of a conversation is a real trade against extraction quality, and it
--   should be a decision somebody makes with knowledge of their own calls, not
--   something a migration turns on for everyone.
--
-- min_transcribe_seconds  (B4)
--   Below this a recording is a ring-out, a misdial, a wrong number or an
--   instant hangup. There is no speech in it, but it still costs a full ASR
--   round trip plus both analyze calls to establish exactly that. On a
--   telecalling floor these are a large share of call volume.
--
--   The deployment default is 5 seconds, which only catches an instant hangup.
--   A floor whose "not interested" calls end at fifteen seconds should say so.
--   NULL keeps the deployment default.
--
--   Note this cuts a large share of CALLS but a small share of MINUTES, since
--   the calls it drops are by definition the short ones - the saving is mostly
--   in analyze cost and queue headroom rather than in the ASR bill.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS asr_max_seconds int,
  ADD COLUMN IF NOT EXISTS min_transcribe_seconds int;

-- Both nullable so an unset instance follows the deployment default; the CHECKs
-- only constrain the values that ARE set. The lower bounds are sanity rails: a
-- cap under a minute would submit almost nothing, and a floor over five minutes
-- would silently stop transcribing most of a telecalling floor's real calls.
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_asr_max_seconds_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_asr_max_seconds_check
  CHECK (asr_max_seconds IS NULL OR asr_max_seconds BETWEEN 60 AND 14400);

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_min_transcribe_seconds_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_min_transcribe_seconds_check
  CHECK (min_transcribe_seconds IS NULL OR min_transcribe_seconds BETWEEN 0 AND 300);

COMMENT ON COLUMN organizations.asr_max_seconds IS
  'Cap on audio submitted to ASR for one call. Over it, the head and tail are '
  'stitched and the middle dropped. NULL = no cap.';
COMMENT ON COLUMN organizations.min_transcribe_seconds IS
  'Recordings shorter than this skip ASR and analyze entirely - ring-outs and '
  'misdials. NULL = the deployment default (MIN_TRANSCRIBE_SECONDS).';
