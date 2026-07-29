-- Automatic retry for a failed pipeline run.
--
-- A failure was terminal: the call landed on FAILED_ASR (or FAILED_TRANSCODE /
-- FAILED_ANALYZE) and stayed there until a human noticed and pressed Reprocess.
-- Most of what actually fails is transient — the ASR provider rate-limits us,
-- a request times out, S3 blips, the worker is restarted mid-call — and every
-- one of those recovers on its own within moments. Making a person the retry
-- mechanism for a self-healing fault is the wrong division of labour, and it
-- loses real calls when nobody is watching the console at 2am.
--
-- The bookkeeping mirrors crm_sync_log, which already solved this shape for CRM
-- delivery: an attempt counter plus the time the next attempt becomes due. The
-- table IS the queue, so a worker restart or a broker purge loses nothing — the
-- next sweep picks up whatever is due. Deliberately NOT a RabbitMQ delayed
-- queue, for the same reason the CRM outbox isn't one.
--
-- The status stays FAILED_* between attempts rather than moving to a "retrying"
-- state: the call genuinely is failed right now, the console should say so, and
-- next_attempt_at carries the "but we will try again" part. A call that
-- exhausts its attempts simply stops having a next_attempt_at, which is what
-- makes "gave up" distinguishable from "waiting".

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS pipeline_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

COMMENT ON COLUMN calls.pipeline_attempts IS
  'Failed pipeline runs for this call. Reset to 0 on success and on a manual '
  'reprocess, so an operator-triggered retry always gets a full budget again.';

COMMENT ON COLUMN calls.next_attempt_at IS
  'When the automatic retry becomes due. NULL means no retry is pending — '
  'either the call is not failed, or it exhausted its attempts and needs a '
  'human. Set alongside a FAILED_* status by the worker.';

-- The sweeper asks exactly one question — "what is due now?" — across every
-- tenant, so it wants a small index rather than a scan of all calls. Partial on
-- next_attempt_at because only failed-and-pending rows ever carry one, which
-- keeps this a few pages even when the calls table is large.
CREATE INDEX IF NOT EXISTS calls_retry_due
  ON calls (next_attempt_at)
  WHERE next_attempt_at IS NOT NULL;
