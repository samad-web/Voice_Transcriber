-- 0148_export_jobs.sql - the data export engine (doc 35), E0.
--
-- ── WHAT THIS IS ────────────────────────────────────────────────────────────
--
-- One asynchronous job table behind all three export scopes:
--
--   'view'    - one dataset, the filters the caller had on screen
--   'section' - every dataset a console rail section owns, unfiltered
--   'bulk'    - every dataset the caller is entitled to, unfiltered
--
-- They differ in how many datasets the row names and whether filters apply.
-- They do NOT differ in authority: the same five gates (doc 35 SS4.1) run per
-- dataset whichever scope asked, so there is no "admin export" that can read a
-- row a filtered extract would have refused. Breadth varies; permission never
-- does.
--
-- ── WHY A TABLE AND NOT A RESPONSE ──────────────────────────────────────────
--
-- The two export routes that exist today (reports.controller.ts:207,
-- report-builder.controller.ts:795) build the whole result set in memory and
-- send it inside the request. That is fine for a widget and cannot survive a
-- tenant with a million leads: no resumption, no progress, and a browser that
-- walks away gets nothing.
--
-- So Postgres is the record and RabbitMQ is only a wake-up, exactly as
-- packages/queue/src/index.ts:6-12 describes for the call pipeline. A dropped
-- message costs latency until the sweep notices; it never costs a job.
--
-- ── THE ONE MISTAKE THIS MUST NOT REPEAT ────────────────────────────────────
--
-- 0062's import_jobs defaults status to 'done' because the import runs inline in
-- the API and nothing ever consumes it. This table's default is 'queued' and
-- there is a worker lane behind it. If a later reader finds rows sitting in
-- 'queued' forever, the consumer is not running - that is the bug, not the
-- default.

-- 1 ── THE JOB ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS export_jobs (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  scope    text NOT NULL CHECK (scope IN ('view', 'section', 'bulk')),

  -- Which rail section, when scope='section'. Stored so the exports centre and
  -- the owner alert can say "Sales" rather than list four dataset keys. The
  -- vocabulary is OWNER_NAV_SECTIONS (apps/web/lib/nav.ts) via the shared
  -- registry; deliberately not a CHECK list, because that list lives in
  -- TypeScript and a copy here would be the third place to forget.
  section  text CHECK (section IS NULL OR char_length(btrim(section)) BETWEEN 1 AND 40),

  format   text NOT NULL CHECK (format IN ('csv', 'xlsx', 'json', 'ndjson')),

  -- The datasets this job ACTUALLY covers - the requested list after the
  -- per-dataset gates removed what the requester may not have. So the row
  -- records what was exported rather than what was asked for, and an auditor
  -- reading it a year later is not reconstructing the grid from memory.
  datasets text[] NOT NULL CHECK (cardinality(datasets) > 0),

  -- The filters as the API VALIDATED them, replayed by the worker. Never the
  -- raw body: a filter the API rejected must not reach the query builder
  -- because it survived in a jsonb column.
  filters  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Requested columns per dataset, already intersected with what the requester
  -- may see. Empty object means "every column the registry allows them".
  columns  jsonb NOT NULL DEFAULT '{}'::jsonb,

  status   text NOT NULL DEFAULT 'queued'
             CHECK (status IN ('queued', 'running', 'packaging', 'ready',
                               'failed', 'expired', 'cancelled')),

  -- NULL until counted, and NULL is a legitimate resting state: above a
  -- threshold the worker skips the count rather than pay for a full scan twice,
  -- and the console renders an indeterminate bar. A 0 here would be a lie.
  rows_total     bigint CHECK (rows_total IS NULL OR rows_total >= 0),
  rows_written   bigint NOT NULL DEFAULT 0 CHECK (rows_written >= 0),
  bytes_written  bigint NOT NULL DEFAULT 0 CHECK (bytes_written >= 0),
  current_dataset text,

  -- ── WHOSE EXPORT THIS IS ────────────────────────────────────────────────
  --
  -- Not a display field. The worker re-resolves this person's grants before it
  -- reads a row (doc 35 SS4.2) and intersects them with scope_snapshot below.
  --
  -- ON DELETE CASCADE rather than SET NULL, unlike import_jobs.created_by:
  -- an export belongs to the person who asked for it, and a job whose owner is
  -- gone is a file nobody may download. Losing the history is the cheaper half.
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The Supabase subject behind the request, for audit parity with doc 27 SS5.2 -
  -- the one identity that covers an operator and a tenant user alike.
  requested_by_auth_id text,

  -- The grants the requester held AT ENQUEUE, frozen.
  --
  -- WHY BOTH THIS AND THE RE-RESOLUTION. The snapshot alone lets a job queued
  -- before a demotion run with the old, wider grant - access revoked at 10:00
  -- and a 10:05 file still carries everything. Re-resolution alone lets a job
  -- WIDEN after a promotion, producing a file the person could not have asked
  -- for when they asked. The intersection is the only direction that is never
  -- surprising, and it is the same "narrow, never widen" rule the persona
  -- intersection already follows (common/auth-principal.ts:74-86).
  scope_snapshot jsonb NOT NULL,

  -- ── THE ARTIFACT ────────────────────────────────────────────────────────
  --
  -- The S3 KEY, never a URL. A stored presigned URL is a bearer token in a
  -- database column: anyone who can read the row - a support screen, a log
  -- line, a CSV of this table - can download the file, it cannot be revoked by
  -- deleting the row, and it expires on the creation clock rather than the
  -- download's. The download route signs a fresh 5-minute GET each time.
  storage_key  text,
  content_type text,
  file_name    text,
  expires_at   timestamptz,
  downloaded_count   int NOT NULL DEFAULT 0 CHECK (downloaded_count >= 0),
  last_downloaded_at timestamptz,

  -- ── THE OWNER ALERT (doc 35 SS4.5) ──────────────────────────────────────
  --
  -- Stamped in the SAME transaction as the INSERT that creates this row, which
  -- is what makes "every export alerts the owners" true rather than nearly
  -- true - a notification written after the commit is one that a crash between
  -- the two skips while the export still runs.
  --
  -- A timestamp and not a boolean: "did the alert go out, and when" is the
  -- question an owner asks afterwards, and a boolean cannot answer the second
  -- half. It is also what stops a sweep-driven retry alerting twice.
  owners_notified_at timestamptz,

  error       text,
  retry_count int NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE export_jobs IS
  'An asynchronous data export (doc 35). Postgres is the record; the aura.export queue is only a '
  'wake-up. storage_key is an S3 key and never a URL.';
COMMENT ON COLUMN export_jobs.scope_snapshot IS
  'The requester grants at enqueue. The worker INTERSECTS this with a fresh resolution - never '
  'trusts either alone. See doc 35 SS4.2.';

-- ── THE INVARIANTS ──────────────────────────────────────────────────────────
--
-- In the database rather than the API, for the reason 0122 and 0147 both give:
-- the API is several controllers plus a worker plus whatever is written next
-- year, and these are the properties the whole feature rests on.

-- A section job names its section; nothing else does. Asserted as a pairing so
-- neither half can drift: a 'section' row with no section is unreadable in the
-- console, and a 'bulk' row carrying one would make the alert say "Everything
-- in Sales" about a whole-tenant export.
ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_section_scope;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_section_scope CHECK (
  (scope = 'section') = (section IS NOT NULL)
);

-- A 'view' job is exactly one dataset. That is what the scope MEANS, and
-- without this a bug that widened the list would produce a multi-dataset job
-- wearing a single-dataset scope - which the drawer would then render as one
-- file and the worker would zip.
ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_view_is_one_dataset;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_view_is_one_dataset CHECK (
  scope <> 'view' OR cardinality(datasets) = 1
);

-- Only a 'view' job carries filters. A section or bulk export is unfiltered by
-- definition; filters on one would be a caller's request silently half-applied.
ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_filters_are_view_only;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_filters_are_view_only CHECK (
  scope = 'view' OR filters = '{}'::jsonb
);

-- A downloadable job has something to download. The four columns are written in
-- one UPDATE at the 'ready' transition, and a row in 'ready' missing any of
-- them is a half-written finish that the console would render as a live link to
-- nothing.
ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_ready_has_artifact;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_ready_has_artifact CHECK (
  status <> 'ready'
  OR (storage_key IS NOT NULL AND file_name IS NOT NULL
      AND content_type IS NOT NULL AND expires_at IS NOT NULL)
);

-- An expired job has had its object deleted. The purge sweep deletes from S3
-- BEFORE clearing the key (the other order leaks an orphan on every crash in
-- between, and an orphan in object storage is invisible - nothing ever lists it
-- again), so a key surviving on an 'expired' row means the delete did not run.
ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_expired_has_no_artifact;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_expired_has_no_artifact CHECK (
  status <> 'expired' OR storage_key IS NULL
);

-- A failure says why. An empty `error` on a failed job is the state that turns
-- a support question into an archaeology exercise.
ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_failed_says_why;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_failed_says_why CHECK (
  status <> 'failed' OR error IS NOT NULL
);

-- Nothing has been written before the job started. Catches a worker that
-- updates progress without claiming first, which would make two workers on one
-- job invisible rather than merely wrong.
ALTER TABLE export_jobs DROP CONSTRAINT IF EXISTS export_jobs_progress_needs_a_start;
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_progress_needs_a_start CHECK (
  started_at IS NOT NULL OR (rows_written = 0 AND bytes_written = 0)
);

-- ── INDEXES ─────────────────────────────────────────────────────────────────

-- The exports centre, owner view: this org's jobs, newest first.
CREATE INDEX IF NOT EXISTS export_jobs_org
  ON export_jobs (org_id, created_at DESC);
-- The exports centre, everybody else: their own.
CREATE INDEX IF NOT EXISTS export_jobs_user
  ON export_jobs (org_id, requested_by_user_id, created_at DESC);

-- The sweep's two queries. Both partial, so they stay small however long the
-- table grows - a finished job is never in either work list.
CREATE INDEX IF NOT EXISTS export_jobs_inflight
  ON export_jobs (status, started_at)
  WHERE status IN ('queued', 'running', 'packaging');
CREATE INDEX IF NOT EXISTS export_jobs_expiring
  ON export_jobs (expires_at)
  WHERE status = 'ready';

-- The per-org concurrency cap the claim checks before it runs a third job
-- (doc 35 SS6.7). Without this the check is a seq scan on every claim.
CREATE INDEX IF NOT EXISTS export_jobs_org_active
  ON export_jobs (org_id)
  WHERE status IN ('running', 'packaging');

-- 2 ── THE MEMBER FILES ──────────────────────────────────────────────────────
--
-- A section or bulk export is many files in one ZIP. One row per member file,
-- so the manifest and the console are both built from the database rather than
-- by opening the archive - and so `redacted_columns` can say out loud what the
-- sensitivity gate removed, instead of leaving a person to notice an empty
-- column and guess why.

CREATE TABLE IF NOT EXISTS export_job_files (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id    uuid NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
  dataset   text NOT NULL,
  file_name text NOT NULL,
  row_count bigint NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  bytes     bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  -- Columns the dataset's own gate removed for THIS requester - the transcript
  -- and recording columns without recordings:export, say. Per file rather than
  -- per job: one export can drop columns from `calls` and none from `leads`.
  redacted_columns text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE export_job_files IS
  'One row per member file of an export. redacted_columns records what the sensitivity gate removed, '
  'so the manifest can state it rather than leave an empty column unexplained.';

CREATE INDEX IF NOT EXISTS export_job_files_job
  ON export_job_files (job_id, dataset);

-- One row per dataset per job. A retry that re-packages must overwrite rather
-- than accumulate, or the manifest double-counts every row it reports.
CREATE UNIQUE INDEX IF NOT EXISTS export_job_files_unique
  ON export_job_files (job_id, dataset);

-- 3 ── RLS AND GRANTS ───────────────────────────────────────────────────────
--
-- Both tables are org-scoped, so the standard tenant policy applies and
-- verify-rls's closure check passes WITHOUT an allowlist entry. Do not add one:
-- these are tenant tables, and an allowlist entry here would be a standing
-- exemption for the table that holds every tenant's extracted data.
--
-- REVOKE before GRANT. A GRANT-only migration in a database the Supabase API
-- roles can already reach narrows nothing - see 0075, 0081, 0089, 0145 and 0147
-- on the same trap.

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['export_jobs', 'export_job_files'] LOOP
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
      -- DELETE included: cancelling a ready job deletes its artifact and its
      -- file rows, and the purge sweep deletes expired jobs outright.
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    END IF;
  END LOOP;
END $$;

-- 4 ── THE NOTIFICATION KINDS ───────────────────────────────────────────────
--
-- Three, and deliberately three rather than one, because the bell routes on
-- kind and a person's delivery preference is set PER KIND (0109's digest):
--
--   export_ready   -> the requester, when their file is available
--   export_failed  -> the requester, when it finally failed
--   export_created -> the ORG'S OWNERS, when anybody starts an export
--
-- export_created is the governance alert (doc 35 SS4.5). It is separate from
-- export_ready precisely so an owner can digest "somebody exported something"
-- without also silencing the notification about their own file being ready.
--
-- It fires at CREATION, not completion: the act worth recording is the request,
-- and a job that then fails, is cancelled or expires unread is still a person
-- who asked for the data.
--
-- Not reusing `report_ready`. That means a scheduled report snapshot, the bell
-- routes on it, and overloading it would send every export to the reports page.
--
-- The CHECK is rewritten WHOLESALE, as every migration that adds a kind does.
-- The zod enum in packages/shared/src/notifications.ts and the console's
-- NOTIFICATION_KINDS record move in the SAME commit as this - notification-kind
-- drift surfaces as a 23514 at runtime, on the notify path, in production,
-- where nobody sees it. packages/shared/src/notification-kinds.test.ts reads
-- the LAST check in apply order and is what keeps this honest.

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
                  'call_issue_update',
                  -- 0148: the data export engine (doc 35).
                  'export_ready',
                  'export_failed',
                  'export_created'));
