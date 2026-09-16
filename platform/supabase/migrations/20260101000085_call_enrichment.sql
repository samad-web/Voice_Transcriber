-- Split the call pipeline into a lead lane and an enrichment lane (A4).
--
-- WHAT WAS WRONG. A call reached SYNCING - and therefore produced a lead - only
-- after BOTH halves of analyze had finished. But the lead needs only one of
-- them: `analyzeTranscript` reads the flat transcript and returns the tenant's
-- fields. Conversation intelligence - roles, per-turn intents, the summary, the
-- quality score - is read by people afterwards and by nothing on the path to a
-- lead. The two run concurrently, so waiting for both cost the difference
-- between them: roughly a further ninety seconds on every call, before anybody
-- could see the lead it had produced.
--
-- WHAT THIS ADDS. Enrichment becomes its own stage with its own queue, its own
-- retry budget and its own terminal states, tracked HERE rather than in
-- `calls.status`. That is deliberate: `calls.status` describes the lead-critical
-- path, and it is what the console's stage panel, `failStalledCalls` and the
-- `calls_status_check` constraint all read. Adding an enrichment state to it
-- would put a stage nobody is waiting on into the machine everybody is.
--
-- THE STATES
--   pending   nothing has run yet; the sweeper or the queue will pick it up
--   running   a consumer holds it (the claim is `pending -> running`)
--   done      intelligence written
--   failed    out of attempts; a person can still see the call and its lead
--   skipped   nothing to enrich - no transcript, or transcription switched off
--
-- CRM dispatch waits for any of done / failed / skipped, never for `done`
-- alone. The dispatch payload carries the intelligence, so sending before
-- enrichment finishes would push empty summaries into a customer's real CRM -
-- but a tenant whose enrichment permanently fails must still receive their
-- leads, so a terminal failure releases the send exactly as success does.

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS enrichment_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS enrichment_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_enrichment_at timestamptz;

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_enrichment_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_enrichment_status_check
  CHECK (enrichment_status IN ('pending', 'running', 'done', 'failed', 'skipped'));

-- Every call that already exists has been through the old single-lane pipeline,
-- so its intelligence is already written and it must not be enriched again -
-- that would pay for a second conversation read on the entire history. Anything
-- with a transcript is 'done'; anything without had nothing to enrich.
UPDATE calls c
   SET enrichment_status = CASE
         WHEN EXISTS (SELECT 1 FROM transcripts t WHERE t.call_id = c.id) THEN 'done'
         ELSE 'skipped'
       END
 WHERE c.enrichment_status = 'pending'
   AND c.status IN ('COMPLETE', 'TRANSCRIPTION_OFF');

-- The sweeper's index: work that is due, and nothing else. Partial so it stays
-- small - the overwhelming majority of rows are 'done' and are never scanned.
CREATE INDEX IF NOT EXISTS calls_enrichment_due
  ON calls (next_enrichment_at)
  WHERE enrichment_status IN ('pending', 'running', 'failed');

COMMENT ON COLUMN calls.enrichment_status IS
  'Conversation intelligence lane (A4), tracked separately from calls.status so '
  'the lead-critical path is not blocked by it. CRM dispatch waits for any '
  'terminal value - done, failed or skipped.';
