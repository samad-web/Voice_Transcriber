-- 0201_platform_failure_escalation.sql
--
-- A failure that is OURS stops being described to the client as a defect in
-- their recording, and starts raising a ticket on the operator's queue by
-- itself.
--
-- ── WHAT WENT WRONG, MEASURED ───────────────────────────────────────────────
--
-- On 2026-10-14 production had transcribed 17 of the previous week's 403
-- audio-bearing calls. Over 30 days, 2,792 of 2,809 FAILED_ASR rows carried the
-- same `error_message`: HTTP 402, `insufficient_quota_error`, "No credits
-- available." The ASR vendor's account had been empty since 2026-08-13.
--
-- Two separate failures made that last 62 days.
--
-- 1. NOBODY WAS TOLD. The raw vendor text never reached a client - the owner
--    call row excludes `error_message` on purpose, and that was right. But it
--    never reached US either. There is no alerting (doc 49 P2), so the only
--    record was 2,792 rows nobody aggregated.
--
-- 2. THE CLIENT WAS TOLD SOMETHING FALSE. Every one of those calls rendered,
--    from `pipelineStage`:
--
--       "Transcription failed - Speech recognition could not read this
--        recording. The call and its audio are still here; the transcript
--        is not."
--
--    Speech recognition never ran. The recording was fine. "is not" says
--    terminal, when the call needed nothing but a funded account. A client
--    reading that concludes their handsets record badly - so the copy did not
--    merely fail to help, it actively moved suspicion onto the one party with
--    nothing to fix.
--
-- ── WHY A COLUMN AND NOT BETTER COPY ────────────────────────────────────────
--
-- `FAILED_ASR` carries two unrelated events: "the vendor refused us" and "this
-- audio is forty minutes of hold music". One is ours and recoverable, the other
-- is the recording's and terminal. One status cannot be honest about both, so
-- rewriting the sentence could not fix it - the status has to be paired with a
-- class. Hence `calls.failure_class`.
--
-- Adding a new call STATUS was the other option and was rejected: `CallStatus`
-- is referenced by the KPI spine, the insights facts tables, the retry sweep,
-- every report and ten status maps, and a new member of that enum is a
-- fourteen-file change with a migration for each CHECK. A nullable column
-- beside the status is additive, and every existing reader keeps working.
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
--
-- It does not fail over to the second provider. Both SARVAM_API_KEY and
-- GEMINI_API_KEY are set in production and have been throughout; the pipeline
-- picks Sarvam on KEY PRESENCE (`pipeline.ts`, `sarvamAsrConfigured()`) and so
-- never reached the funded provider sitting beside it. Routing on provider
-- HEALTH rather than on configuration is doc 49 P1-A and needs a table this
-- migration deliberately does not add - a platform-scoped table trips
-- `verify-rls.js`, which is correct of it, and that allowlist edit belongs in
-- the commit that adds the table rather than in this one.
--
-- So: this migration makes the failure visible and honest. It does not make it
-- stop. P1-A makes it stop.

BEGIN;

-- 1 ── HOW A CALL FAILED, AS OPPOSED TO AT WHICH STAGE ──────────────────────

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS failure_class text,
  ADD COLUMN IF NOT EXISTS failure_reason_code text;

-- Separate statements so a re-run after a partial apply does not fail on the
-- constraint already existing.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_failure_class_check;
ALTER TABLE calls ADD CONSTRAINT calls_failure_class_check
  CHECK (failure_class IS NULL OR failure_class IN ('platform', 'content', 'config'));

COMMENT ON COLUMN calls.failure_class IS
  'Whose fault the current failure is. platform = ours or a vendor''s, and never '
  'phrased to a client as a defect in their data; content = the audio or '
  'transcript genuinely cannot carry the stage, terminal and honest to say so; '
  'config = a setting in this tenant''s own workspace, actionable by them. NULL '
  'on any call that has not failed. Written by classifyFailure() in '
  '@aura/shared/provider-failures - do not set it by hand, because the whole '
  'point is that one function decides it for every stage.';

-- The operator-facing reason code, from `PlatformFailureReason`. NOT a free
-- text field: the escalation queue groups on this, and "the same incident 2,792
-- times" is only one row if the code is stable. NULL whenever failure_class is
-- not 'platform' - a content failure has no vendor to name.
--
-- Intentionally NOT constrained to an enum CHECK. `notification-kinds.test.ts`
-- exists because a DB CHECK and a zod enum drift silently and then throw 23514
-- at runtime (it has happened twice), and that drift is only worth the CHECK
-- where a bad value corrupts a decision. This value decides a queue heading.
-- A code the enum has outgrown should land on the board looking odd, not abort
-- the transaction that was trying to tell us something is broken.
COMMENT ON COLUMN calls.failure_reason_code IS
  'PlatformFailureReason from @aura/shared/provider-failures, e.g. '
  'provider_out_of_credit. Set only when failure_class = ''platform''. '
  'Operator-facing: it names a vendor problem and must not be rendered in any '
  'client surface.';

-- Partial, because the question this index answers is always about failures:
-- "what is broken right now, and is it one incident or many". 9,305 rows today
-- of which ~4,600 have failed, so the partial index is roughly half the size of
-- the full one and every query that uses it filters this way anyway.
CREATE INDEX IF NOT EXISTS calls_failure_class_idx
  ON calls (failure_class, failure_reason_code, started_at DESC)
  WHERE failure_class IS NOT NULL;

-- 2 ── A REPORT THE SYSTEM CAN FILE ─────────────────────────────────────────
--
-- 0147 built this queue for a CLIENT reporting a bad transcript: a person
-- states the problem, we triage it at /support, and Reprocess becomes ours.
-- Everything that design needs for an automatic report is already here - the
-- frozen snapshot, the ref number, the append-only event timeline, and
-- crucially `call_issue_events.visibility ('internal','client')`, whose
-- existing constraint already permits a non-user actor to write an internal
-- row. So the vendor's own words have a place to live that a client cannot see,
-- and no new table is needed.
--
-- What was missing is only the ability to say "nobody reported this; we
-- noticed".

ALTER TABLE call_issue_reports
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS platform_reason text;

ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_reports_source_check;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_reports_source_check
  CHECK (source IN ('client', 'system'));

COMMENT ON COLUMN call_issue_reports.source IS
  'client = a person filed it (0147''s original and only path). system = the '
  'pipeline filed it after classifying a failure as ours. The default is '
  '''client'' so every row written before this migration keeps its meaning '
  'without a backfill.';

COMMENT ON COLUMN call_issue_reports.platform_reason IS
  'For source=''system'': the PlatformFailureReason that triggered it, so the '
  'board can group one vendor incident instead of listing a thousand calls. '
  'NULL for a client report - a person reports a symptom, not a cause.';

-- `processing_failed` joins the category vocabulary. It is the one category a
-- client never picks: the others describe a transcript that came out wrong,
-- this one describes a transcript that never came out at all.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_reports_category_check;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_reports_category_check
  CHECK (category IN (
    'audio_unplayable', 'audio_truncated',
    'wrong_transcript', 'wrong_language', 'wrong_speaker_split',
    'wrong_summary', 'wrong_sentiment', 'wrong_facts',
    'wrong_disposition', 'missing_call',
    'processing_failed',
    'other'));

-- `reported_by_role` is NOT NULL with a snapshot of the reporter's name, because
-- 0147 wanted a report to still name its author after that person leaves. A
-- system report has no author, and the honest way to model that is a role of
-- 'system' with a name that says so - not a NULL that every join has to
-- special-case, and emphatically not borrowing some owner's name for a ticket
-- they did not file.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_reports_reported_by_role_check;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_reports_reported_by_role_check
  CHECK (reported_by_role IN ('owner', 'manager', 'telecaller', 'sales', 'marketing', 'system'));

-- A system report must carry its reason; a client report must not invent one.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_reports_system_reason_check;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_reports_system_reason_check
  CHECK (
    (source = 'system' AND platform_reason IS NOT NULL AND reported_by_role = 'system')
    OR
    (source = 'client' AND platform_reason IS NULL AND reported_by_role <> 'system')
  );

-- 3 ── ONE INCIDENT, ONE TICKET ─────────────────────────────────────────────
--
-- THE WHOLE POINT OF THIS INDEX. Without it, the first run of the escalation
-- path against the existing backlog files 2,792 tickets for one empty wallet,
-- and the queue that was supposed to surface the problem buries it instead -
-- which is the same failure as before, wearing a different hat.
--
-- So: at most one LIVE system ticket per (org, reason). The 2,793rd failing
-- call appends an event to the open ticket rather than creating another, and
-- `occurrence_count` is what tells the operator this is an outage and not a
-- one-off.
--
-- Per (org, reason) and not platform-wide, because one tenant's call volume
-- recovering tells us nothing about another's, and because `call_issue_reports`
-- is org-scoped and RLS-forced - a cross-tenant unique index on it would be a
-- row one tenant cannot see blocking an insert for another, which is a support
-- call nobody can diagnose.
ALTER TABLE call_issue_reports
  ADD COLUMN IF NOT EXISTS occurrence_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_occurred_at timestamptz;

ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_reports_occurrence_count_check;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_reports_occurrence_count_check
  CHECK (occurrence_count >= 1);

COMMENT ON COLUMN call_issue_reports.occurrence_count IS
  'How many calls this one system ticket stands for. 1 for a client report, '
  'always. For a system report this is the number that distinguishes "a vendor '
  'hiccup" from "nothing has worked since August".';

CREATE UNIQUE INDEX IF NOT EXISTS call_issue_reports_one_live_system_ticket
  ON call_issue_reports (org_id, platform_reason)
  WHERE source = 'system'
    AND status IN ('open', 'acknowledged', 'in_progress', 'awaiting_client');

-- ── AND 0147'S OWN UNIQUENESS HAS TO MAKE ROOM FOR IT ───────────────────────
--
-- FOUND BY THE FIRST REAL EXECUTION OF THIS MIGRATION (2026-10-14), which is
-- the whole argument for running one before deploying it.
--
-- 0147 created `call_issue_reports_live`, UNIQUE on (call_id, category) over
-- the live statuses, to stop a client filing the same complaint about the same
-- call twice. That is right for a client report and wrong for a system one, and
-- the two had not been reconciled:
--
--   * a system ticket's `category` is ALWAYS 'processing_failed';
--   * its `call_id` is whichever call first exhibited the incident - and the
--     retry sweep re-runs the same calls, so the same call id reappears;
--   * so a SECOND live system ticket, for a DIFFERENT reason (credit exhausted,
--     then credentials rejected), collided on (call_id, category) even though
--     0201's own index was perfectly happy to allow it.
--
-- The failure mode was the quiet one. `fail()` swallows an escalation error on
-- purpose - telemetry about a failure must not turn a handled failure into an
-- unhandled throw - so the second incident would simply never have been
-- escalated, and the board would have shown one ticket while two things were
-- broken. That is this document's own bug, recreated inside its fix.
--
-- So the client index becomes explicitly a CLIENT index. System rows are
-- governed by the (org, reason) index above, which is the uniqueness they
-- actually want.
DROP INDEX IF EXISTS call_issue_reports_live;
CREATE UNIQUE INDEX call_issue_reports_live
  ON call_issue_reports (call_id, category)
  WHERE source = 'client'
    AND status IN ('open', 'acknowledged', 'in_progress', 'awaiting_client');

-- Operator board: the live system tickets across every tenant, worst first.
CREATE INDEX IF NOT EXISTS call_issue_reports_system_live_idx
  ON call_issue_reports (platform_reason, severity, last_occurred_at DESC)
  WHERE source = 'system'
    AND status IN ('open', 'acknowledged', 'in_progress', 'awaiting_client');

-- 4 ── THE EVENT KIND THAT RECORDS A RECURRENCE ─────────────────────────────
--
-- `call_issue_events` already constrains its `kind`. A recurrence is not a
-- `client_reply` and not an `operator_note`; it is the system saying "this
-- happened again, on another call". It is always `internal`: a client does not
-- need a timeline entry per failed call, and the existing constraint
-- (`actor_type <> 'user' OR visibility = 'client'`) already allows a non-user
-- actor to write one.
-- SPELLED OUT IN FULL, and not derived from the existing constraint.
--
-- The first draft of this did the clever thing: read `pg_get_constraintdef`,
-- `replace()` the closing paren, and re-add it - which widens the CHECK without
-- restating fifteen values nobody wants to re-type.
--
-- It was wrong, and `call-issues.test.ts` said so immediately. That test reads
-- the vocabulary OUT OF THE MIGRATION SQL and compares it against the zod enum,
-- because a value the enum knows and the CHECK does not is a 23514 on the write
-- path in production (it has happened twice in this schema - see 0100's header
-- on `notifications.kind`). A constraint assembled at runtime by string
-- surgery is invisible to that test: the list exists only inside a live
-- database, so the guard silently stops guarding and keeps passing.
--
-- So: a literal list. The cost is re-typing fifteen values once. The benefit is
-- that the drift guard can still read them, which is the only reason the list
-- is trustworthy at all.
ALTER TABLE call_issue_events DROP CONSTRAINT IF EXISTS call_issue_events_kind_check;
ALTER TABLE call_issue_events ADD CONSTRAINT call_issue_events_kind_check
  CHECK (kind IN (
    'filed', 'acknowledged', 'assigned', 'status_changed', 'severity_changed',
    'note', 'reprocess_queued', 'reprocess_finished', 'access_requested',
    'resolved', 'rejected', 'reopened', 'withdrawn',
    'client_reply', 'client_confirmed',
    'system_opened', 'system_recurrence'));

-- ── AND THE TWO NEW KINDS MUST BE ALLOWED TO CARRY PROSE ────────────────────
--
-- ALSO FOUND BY THE FIRST REAL EXECUTION (2026-10-14). `kind` was widened
-- above and `body` was not, and 0147 has a second CHECK that only lets certain
-- kinds carry a body at all:
--
--   call_issue_events_body_where_expected
--     CHECK (kind IN ('note','client_reply','resolved','rejected','withdrawn','filed')
--            OR body IS NULL)
--
-- Every escalation event this design writes carries prose - the vendor's own
-- words on the internal row, and "we spotted it, nothing is needed from you" on
-- the client row. So every one of them would have been refused with a 23514, on
-- the exact path that exists to report an outage, and `fail()` swallows an
-- escalation error on purpose. The result would have been an escalation
-- mechanism that wrote a ticket with an empty timeline and reported nothing -
-- or worse, since the insert runs inside the transaction recording the call's
-- failure, an aborted transaction that lost the failure record too.
--
-- That CHECK's intent is sound and stays: a `status_changed` event must not
-- carry prose nobody renders. These two kinds are the opposite case - the prose
-- IS the event. Restated in full for the same reason the kind list above is:
-- a constraint assembled by string surgery is invisible to the drift guard
-- that reads this file.
ALTER TABLE call_issue_events DROP CONSTRAINT IF EXISTS call_issue_events_body_where_expected;
ALTER TABLE call_issue_events ADD CONSTRAINT call_issue_events_body_where_expected
  CHECK (
    kind IN ('note', 'client_reply', 'resolved', 'rejected', 'withdrawn', 'filed',
             'system_opened', 'system_recurrence')
    OR body IS NULL
  );

COMMIT;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--
--   -- the new columns, with the right CHECKs
--   \d+ calls
--   \d+ call_issue_reports
--
--   -- a client report still inserts unchanged (regression: the new composite
--   -- CHECK must not have made `source` mandatory at the call site)
--   -- and a system report without a reason must be refused:
--   INSERT INTO call_issue_reports (org_id, call_id, category, description,
--     reported_by_name, reported_by_role, source, snap_call_status,
--     snap_pipeline_attempts, snap_call_started_at, snap_duration_s, snap_direction)
--   VALUES (…, 'processing_failed', 'x', 'System', 'system', 'system', 'FAILED_ASR', 5, now(), 0, 'incoming');
--   -- → ERROR: violates call_issue_reports_system_reason_check   (platform_reason IS NULL)
--
--   -- and the de-dupe holds:
--   -- two system tickets, same org, same reason, both open → unique violation.
