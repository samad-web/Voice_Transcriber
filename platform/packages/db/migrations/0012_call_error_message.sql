-- Why a call failed, not just that it did.
--
-- The pipeline records failure as a terminal status (FAILED_ASR, FAILED_CRM, …)
-- and console-logs the underlying error on the worker. That is enough to know a
-- call broke and nothing at all about why: an operator looking at the Call
-- Explorer sees a red chip and has to go read worker logs — which on a single
-- VPS means SSH — to distinguish "the audio was silent" from "the ASR provider
-- rejected our key". Both look identical in the UI, and only one is actionable
-- by the operator.
--
-- Storing the reason next to the call makes the triage self-service and makes
-- "reprocess" an informed decision rather than a guess. It is deliberately a
-- plain text column and not structured: the value is whatever the failing stage
-- threw, and over-modelling it would just lose detail.
--
-- Cleared on every attempt so a successful reprocess does not leave a stale
-- reason attached to a call that is now COMPLETE.

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS error_message text;

COMMENT ON COLUMN calls.error_message IS
  'Human-readable reason the last pipeline attempt failed, set alongside a '
  'FAILED_* status and cleared when the call is retried or completes. NULL for '
  'any call that has not failed.';
