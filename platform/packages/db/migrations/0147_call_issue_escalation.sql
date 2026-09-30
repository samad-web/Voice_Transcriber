-- 0147_call_issue_escalation.sql - the client reports, the vendor reprocesses.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--
-- Reprocessing a call was a client-facing button (`POST /owner/calls/:id/
-- reprocess`, owner-only). It is wrong in three ways at once:
--
--   * It SPENDS on every press. The recording goes back through Sarvam and the
--     analyzer, both billed, on a transcript already paid for once.
--   * It is the wrong instrument for the problem the client actually has. They
--     do not want the pipeline run again; they want the transcript to be right.
--   * It captures nothing. A client could press it five times and never tell us
--     WHAT was wrong, and a reprocess that changed nothing was indistinguishable
--     from one that fixed it.
--
-- So the button goes and this replaces it: the client states the problem, we
-- triage it on a cross-tenant queue, and pressing Reprocess becomes ours.
--
-- ── WHAT THIS MUST NEVER BECOME ─────────────────────────────────────────────
--
-- A side channel around 0122. That migration means a platform operator needs a
-- live, bounded grant from the tenant's own administrator to read any call
-- content. A ticket carrying the transcript, a segment of it, the AI summary or
-- a presigned recording URL would hand us exactly that - through a route with no
-- gate on it, filed by a MANAGER, who under 0122 has no standing to approve
-- access at all (every decision route there is @RequireOwnerRole("owner")).
--
-- Hence the snapshot below is metadata and DIGESTS. No column here holds call
-- content. `call-issue-content.spec.ts` is what keeps that true in a year, and
-- the operator's route to the audio stays the eight gated routes it already was.
--
-- ── WHY THE SNAPSHOT IS NOT OPTIONAL ────────────────────────────────────────
--
-- A reprocess destroys the evidence the ticket is about. It rewinds the call to
-- UPLOADED, resets pipeline_attempts, and the pipeline then overwrites the
-- transcript and the analysis - `call-insights.query.ts` states the convention
-- outright: "one row per call by convention (reprocess deletes before
-- inserting)".
--
-- A ticket holding only call_id therefore becomes unfalsifiable the moment we
-- act on it: nobody can say what the transcript said when the customer
-- complained, whether the engine changed, or whether the second run differed at
-- all. With snap_transcript_md5 and snap_asr_engine the queue can state a
-- fact instead - "transcript unchanged, engine unchanged: reprocessing will not
-- fix this" - which is what stops us paying for a third run on a guess.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
--
-- Filing a report does not reprocess anything, and does not grant anybody
-- access to the recording. Both are decisions a person makes afterwards, out
-- loud: the first because it spends, the second because 0122's whole design is
-- that a grant names the operator who asked - and at filing time there is no
-- operator yet, so a row created here would be a grant nobody can account for.

-- 1 ── THE REPORT ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS call_issue_reports (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- ON DELETE CASCADE, and that is a privacy choice rather than convenience: a
  -- GDPR erasure or the retention sweeper takes the call, and a ticket left
  -- behind would describe a recording the customer had us delete. The cost is
  -- our own triage history, which is the right thing to lose.
  call_id  uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,

  -- The number both sides quote on the phone, rendered 'AUR-000123' by
  -- callIssueRef(). Platform-wide rather than per-org: per-org numbering needs a
  -- counter row and a lock, and the only thing global numbering leaks is our
  -- total ticket volume to a customer who studies the gaps in their own refs.
  ref      bigint GENERATED ALWAYS AS IDENTITY UNIQUE,

  -- ── WHAT IS WRONG (vocabulary: packages/shared/src/call-issues.ts) ───────
  category text NOT NULL CHECK (category IN (
    'audio_unplayable', 'audio_truncated',
    'wrong_transcript', 'wrong_language', 'wrong_speaker_split',
    'wrong_summary', 'wrong_sentiment', 'wrong_facts',
    'wrong_disposition', 'missing_call', 'other')),

  severity text NOT NULL DEFAULT 'wrong'
    CHECK (severity IN ('blocking', 'wrong', 'minor')),

  -- Shown to the operator verbatim, for the same reason 0122 shows the
  -- operator's reason to the administrator verbatim: a complaint paraphrased by
  -- a machine is a complaint nobody can answer.
  description text NOT NULL
    CHECK (char_length(btrim(description)) BETWEEN 1 AND 2000),

  -- Where in the recording, in seconds from the start - prefilled from the
  -- player's own position, so a client complaining about four minutes into a
  -- forty-minute call does not make an engineer hunt for it. Capped at 24h,
  -- which is a typo guard and not a policy.
  at_seconds integer CHECK (at_seconds IS NULL OR (at_seconds >= 0 AND at_seconds <= 86400)),

  -- ── WHO SAID SO ─────────────────────────────────────────────────────────
  --
  -- The FK for joins, PLUS a snapshot of the name and persona. A report must
  -- still name its author after that person leaves the business (which is why
  -- the FK is SET NULL and the text is NOT NULL), and "a manager said this"
  -- changes how it is triaged.
  reported_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reported_by_name    text NOT NULL CHECK (char_length(btrim(reported_by_name)) BETWEEN 1 AND 200),
  reported_by_role    text NOT NULL
    CHECK (reported_by_role IN ('owner', 'manager', 'telecaller', 'sales', 'marketing')),
  reported_at timestamptz NOT NULL DEFAULT now(),

  -- ── THE FROZEN SNAPSHOT ─────────────────────────────────────────────────
  --
  -- Captured in the SAME statement that inserts the row. A snapshot taken by a
  -- second query afterwards can disagree with the row it claims to describe.
  --
  -- `snap_` on every column so a reader of the operator console's SQL can never
  -- mistake one for the call's CURRENT state - after a reprocess they are the
  -- past, and a reader who thinks otherwise chases a bug that no longer exists.
  snap_call_status           text NOT NULL,
  snap_pipeline_attempts     integer NOT NULL,
  snap_call_started_at       timestamptz NOT NULL,
  snap_duration_s            integer NOT NULL,
  snap_direction             text NOT NULL,
  snap_device_id             uuid,
  snap_audio_source_used     text,
  snap_agent_id              uuid,
  snap_agent_version         integer,
  -- The recording, from `recordings`. The s3 key is a POINTER, not access:
  -- reaching the object still needs the presign route, which is gated.
  snap_recording_s3_key      text,
  snap_recording_bytes       bigint,
  snap_recording_sha256      text,
  snap_recording_codec       text,
  snap_recording_sample_rate integer,
  -- The transcription, from `transcripts`. `engine` is the model that produced
  -- it, so "we changed nothing between the two runs" is checkable.
  snap_asr_engine            text,
  snap_asr_language          text,
  snap_asr_diarized          boolean,
  snap_asr_confidence        real,
  -- The transcript itself is NOT here. Its length and digest answer "did the
  -- reprocess change anything" without copying the customer's conversation.
  --
  -- md5 and not sha256, for one practical reason and one better one: no
  -- migration in this repo installs pgcrypto, so `digest()` is unavailable on a
  -- plain postgres:16 (only `gen_random_uuid()` is built in) - and md5 IS, which
  -- means the digest can be taken inside the database by the same statement that
  -- inserts the row. The alternative was hashing in the API, which would pull the
  -- verbatim transcript into the application process and its stack traces to
  -- produce a value whose only job is inequality. Collision resistance is not
  -- what this column is for.
  snap_transcript_chars      integer,
  snap_transcript_md5        text,

  -- ── WHAT BECAME OF IT ───────────────────────────────────────────────────
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'acknowledged', 'in_progress', 'awaiting_client',
    'resolved', 'rejected', 'duplicate', 'withdrawn')),

  -- TEXT and not a users FK, the same decision 0122 made for
  -- requested_by_email and 0145 for invited_by: a platform operator is an auth
  -- user with no membership and therefore no `users` row at all, so the email is
  -- the only durable identifier they have.
  assigned_to_email     text CHECK (assigned_to_email IS NULL
                          OR char_length(btrim(assigned_to_email)) BETWEEN 3 AND 320),
  acknowledged_at       timestamptz,
  acknowledged_by_email text,

  resolution text CHECK (resolution IN (
    'reprocessed', 'fixed_upstream', 'working_as_intended',
    'not_reproducible', 'client_error', 'duplicate', 'withdrawn')),
  resolution_note   text CHECK (resolution_note IS NULL
                      OR char_length(btrim(resolution_note)) BETWEEN 1 AND 2000),
  resolved_at       timestamptz,
  resolved_by_email text,
  duplicate_of      uuid REFERENCES call_issue_reports(id) ON DELETE SET NULL,

  -- The CLIENT accepting the answer, which is not the same thing as our having
  -- given one. A resolution nobody confirmed is a resolution we declared, and
  -- the queue should be able to tell the two apart.
  client_confirmed_at timestamptz,

  -- ── THE LOOP BACK TO THE FIX ────────────────────────────────────────────
  reprocess_count   integer NOT NULL DEFAULT 0 CHECK (reprocess_count >= 0),
  last_reprocess_at timestamptz,

  -- The 0122 request raised for THIS ticket, if we needed to hear the call.
  -- Usually null: most categories are answerable from the snapshot. SET NULL
  -- and never CASCADE - losing the grant record must not delete the complaint.
  access_request_id uuid REFERENCES call_access_requests(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE call_issue_reports IS
  'A client-reported problem with a processed call (doc 36). Metadata and digests only - '
  'never call content, which stays behind the 0122 gate.';
COMMENT ON COLUMN call_issue_reports.snap_transcript_md5 IS
  'Digest of the transcript AS REPORTED, so a later reprocess can be shown to have changed it '
  'or not. Deliberately not the text, and deliberately taken in-database (see the column).';

-- ── THE INVARIANTS, IN THE DATABASE ─────────────────────────────────────────
--
-- Every one of these could live in the API instead. They do not, for the reason
-- 0122's header gives: the API is several controllers plus a worker plus
-- whatever gets written next year, and "a resolved ticket names who resolved it"
-- is the property the whole queue rests on.

-- A terminal ticket is attributable. 'withdrawn' is the exception and names
-- nobody on our side - the client closed it - so resolved_by_email must be NULL
-- exactly then. Asserted as a pairing rather than left to convention, the same
-- trick 0122 uses for its otp branch.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_terminal_is_attributable;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_terminal_is_attributable CHECK (
  status NOT IN ('resolved', 'rejected', 'duplicate', 'withdrawn')
  OR (resolved_at IS NOT NULL
      AND resolution IS NOT NULL
      AND (status = 'withdrawn') = (resolved_by_email IS NULL))
);

-- A live ticket holds no resolution. Without this, a bug that set resolved_at
-- while leaving the status alone would be invisible until the day somebody
-- changed how the queue reads it.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_live_holds_no_verdict;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_live_holds_no_verdict CHECK (
  status IN ('resolved', 'rejected', 'duplicate', 'withdrawn')
  OR (resolved_at IS NULL AND resolution IS NULL AND resolved_by_email IS NULL)
);

-- 'open' means untouched. Anything assigned or acknowledged has moved on, and a
-- row claiming both is a half-written update.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_open_is_untouched;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_open_is_untouched CHECK (
  status <> 'open'
  OR (acknowledged_at IS NULL AND assigned_to_email IS NULL)
);

ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_ack_names_somebody;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_ack_names_somebody CHECK (
  (acknowledged_at IS NULL) = (acknowledged_by_email IS NULL)
);

-- 'duplicate' points somewhere, and not at itself.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_duplicate_points_somewhere;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_duplicate_points_somewhere CHECK (
  (status = 'duplicate') = (duplicate_of IS NOT NULL)
  AND (duplicate_of IS NULL OR duplicate_of <> id)
);

-- A client cannot confirm a resolution that does not exist.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_confirm_needs_resolution;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_confirm_needs_resolution CHECK (
  client_confirmed_at IS NULL OR resolved_at IS NOT NULL
);

-- The counter and its timestamp agree, so "reprocessed twice" and "never
-- reprocessed" cannot both be true of one row.
ALTER TABLE call_issue_reports DROP CONSTRAINT IF EXISTS call_issue_reprocess_agrees;
ALTER TABLE call_issue_reports ADD CONSTRAINT call_issue_reprocess_agrees CHECK (
  (reprocess_count = 0) = (last_reprocess_at IS NULL)
);

-- ── INDEXES ─────────────────────────────────────────────────────────────────

-- The operator queue: cross-tenant, live tickets only, worst and oldest first.
-- Partial, because a closed ticket is never in the work list - so the index
-- stays small however long the table grows.
CREATE INDEX IF NOT EXISTS call_issue_reports_queue
  ON call_issue_reports (severity, reported_at)
  WHERE status IN ('open', 'acknowledged', 'in_progress', 'awaiting_client');

-- The client's own list, and the call drawer's "reports on this call".
CREATE INDEX IF NOT EXISTS call_issue_reports_org
  ON call_issue_reports (org_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS call_issue_reports_call
  ON call_issue_reports (call_id, reported_at DESC);

-- One LIVE report per call per category, so a double-press is a 409 and not two
-- tickets. Partial on purpose: the same complaint may be filed again next year
-- after this one is closed, and two DIFFERENT problems with one call are still
-- two tickets - which is the shape triage needs.
--
-- NOTE FOR THE API: this table now has two unique indexes (`ref` and this one)
-- and both raise SQLSTATE 23505. Branch on `err.constraint`, never on the code -
-- 0145 cost real debugging time to exactly that mistake.
CREATE UNIQUE INDEX IF NOT EXISTS call_issue_reports_live
  ON call_issue_reports (call_id, category)
  WHERE status IN ('open', 'acknowledged', 'in_progress', 'awaiting_client');

-- 2 ── THE TIMELINE ─────────────────────────────────────────────────────────
--
-- Why a timeline and not only a status column: triage asks "what has already
-- been tried", and a status answers only "where it ended up".
--
-- And why not `audit_log`: that is the TENANT's compliance record, one row per
-- action with no thread. Putting our internal triage notes in it would make a
-- customer's own audit trail partly unreadable to them. The client-visible
-- state changes are written to both.

CREATE TABLE IF NOT EXISTS call_issue_events (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Redundant against report_id, and required twice over: verify-rls's closure
  -- check wants every public table org-scoped, and the client's own reads run
  -- inside withOrg() where RLS needs a column on THIS table to filter on.
  -- `recordings` carries both org_id and call_id for the same two reasons.
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES call_issue_reports(id) ON DELETE CASCADE,

  kind text NOT NULL CHECK (kind IN (
    'filed', 'acknowledged', 'assigned', 'status_changed', 'severity_changed',
    'note', 'reprocess_queued', 'reprocess_finished', 'access_requested',
    'resolved', 'rejected', 'reopened', 'withdrawn',
    'client_reply', 'client_confirmed')),

  -- THE LOAD-BEARING COLUMN. 'internal' is never selected by any /owner/* route.
  visibility text NOT NULL CHECK (visibility IN ('internal', 'client')),

  -- auditActor()'s vocabulary, so a reader of this timeline and a reader of
  -- audit_log learn who acted in the same words. See common/audit-actor.ts.
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'operator', 'system')),
  actor_id   text NOT NULL,
  actor_name text,

  body text CHECK (body IS NULL OR char_length(btrim(body)) BETWEEN 1 AND 4000),
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE call_issue_events IS
  'Append-only timeline for a call issue report. `visibility` decides whether the client sees a row; '
  'internal notes are ours. Never holds call content.';

CREATE INDEX IF NOT EXISTS call_issue_events_report
  ON call_issue_events (report_id, created_at);

-- A row the CLIENT wrote can never be internal. They already know what they
-- said, and hiding it would make their own timeline lie to them.
ALTER TABLE call_issue_events DROP CONSTRAINT IF EXISTS call_issue_events_client_rows_visible;
ALTER TABLE call_issue_events ADD CONSTRAINT call_issue_events_client_rows_visible CHECK (
  actor_type <> 'user' OR visibility = 'client'
);

-- A client reply is by definition something the client can see.
ALTER TABLE call_issue_events DROP CONSTRAINT IF EXISTS call_issue_events_replies_visible;
ALTER TABLE call_issue_events ADD CONSTRAINT call_issue_events_replies_visible CHECK (
  kind NOT IN ('client_reply', 'client_confirmed') OR visibility = 'client'
);

-- Only these kinds carry prose; the rest describe themselves and a body on one
-- of them is a note filed as the wrong kind.
ALTER TABLE call_issue_events DROP CONSTRAINT IF EXISTS call_issue_events_body_where_expected;
ALTER TABLE call_issue_events ADD CONSTRAINT call_issue_events_body_where_expected CHECK (
  kind IN ('note', 'client_reply', 'resolved', 'rejected', 'withdrawn', 'filed')
  OR body IS NULL
);

-- 3 ── RLS AND GRANTS ───────────────────────────────────────────────────────
--
-- Both tables are org-scoped, so the standard tenant policy applies and
-- verify-rls's closure check passes WITHOUT an allowlist entry. That is the
-- difference from 0145, whose non-tenant table failed that check and would have
-- killed the prod migrate job after applying four migrations.
--
-- REVOKE before GRANT. A GRANT-only migration in a database the Supabase API
-- roles can already reach narrows nothing - see 0075, 0081, 0089 and 0145 on the
-- same trap.

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['call_issue_reports', 'call_issue_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    END IF;
  END LOOP;
END $$;

-- The `ref` identity sequence.
--
-- Deliberately NOT granted to `aura_app`. An identity column's sequence is
-- internally dependent on its table, so INSERT on the table carries it - unlike
-- a `serial`, whose sequence is a separate object needing its own privilege,
-- which is why 0127 had to name `auth_events_id_seq`. A
-- `GRANT ... ON ALL SEQUENCES IN SCHEMA public` would have worked here and is
-- the wrong instrument: it reaches every sequence in the database to solve a
-- problem this table does not have.
--
-- It IS revoked from the Supabase API roles, because 0007 hardened every
-- sequence in this schema and a new one must not arrive wider than its
-- neighbours - a readable sequence leaks how many complaints the platform holds.
DO $$
DECLARE api_role text; seq text;
BEGIN
  seq := pg_get_serial_sequence('call_issue_reports', 'ref');
  IF seq IS NOT NULL THEN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I', seq, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', seq);
  END IF;
END $$;

-- 4 ── THE NOTIFICATION KIND ────────────────────────────────────────────────
--
-- One kind: "the vendor has said something about a problem you reported".
-- Deliberately not two (an update and a resolution) - the bell's job is to get
-- somebody to open the ticket, and a second kind for the same thread is the
-- noise that teaches people to ignore it.
--
-- The CHECK is rewritten WHOLESALE, as every migration that adds a kind does.
-- The zod enum in packages/shared/src/notifications.ts and the console's
-- NOTIFICATION_KINDS record must move in the same commit: notification-kinds
-- drift surfaces as a 23514 at runtime, on the notify path, in production.

DO $do$
DECLARE con text;
BEGIN
  SELECT c.conname INTO con
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
   WHERE t.relname = 'notifications' AND c.contype = 'c' AND a.attname = 'kind'
     AND c.conkey = ARRAY[a.attnum];
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', con);
  END IF;
END $do$;

ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'task_due', 'deal_stage_changed', 'deal_idle',
                  'automation', 'report_ready', 'lead_assigned',
                  'opt_out_requested', 'channel_needs_attention',
                  'sla_breach', 'review_pending',
                  'call_access_requested',
                  'storage_quota',
                  'missed_call',
                  'task_response',
                  -- 0140: attendance (doc 33).
                  'attendance_request',
                  'attendance_break_overrun',
                  'attendance_away',
                  'attendance_review',
                  -- 0143: never started the shift.
                  'attendance_absent',
                  -- 0147: we answered a problem you reported (doc 36).
                  'call_issue_update'));
