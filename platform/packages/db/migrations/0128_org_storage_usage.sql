-- How much each tenant is storing (doc 27 §6).
--
-- The only per-org FILES in object storage are handset call recordings, at
-- org/<orgId>/calls/<callId>.m4a, and their size has been on
-- `recordings.bytes` since 0001 (checked against the S3 HEAD when an upload
-- completes). Nothing ever summed it, and nothing anywhere showed bytes per
-- org. This adds the sum - as a SNAPSHOT the worker writes, never a live
-- aggregate on a page load.
--
-- ── WHY A SNAPSHOT ───────────────────────────────────────────────────────────
--
-- The owner console reads storage on every navigation (it rides on
-- /v1/auth/context to reach the account menu). Summing a year of recordings
-- per page, from a Mumbai API against a Seoul database, is the cost
-- setup.controller.ts's header already refuses to pay. The worker's
-- storage-usage sweep upserts one row per org per hour; every read is one row.
--
-- ── WHAT COUNTS ─────────────────────────────────────────────────────────────
--
-- `uploaded_at IS NOT NULL` is mandatory in the sweep: a recordings row is
-- inserted at call-create time, before any audio exists, so AWAITING_AUDIO and
-- FAILED_UPLOAD calls would otherwise count bytes that were never stored. APK
-- releases and database backups are the platform's storage and never appear.
--
-- ── THE QUOTA WARNS; IT NEVER BLOCKS ────────────────────────────────────────
--
-- `organizations.storage_quota_bytes` is operator-set and display-and-warn
-- only (doc 27 Q4). An upload is never refused for being over it: recordings
-- are the product, refusing one loses a customer's call permanently, and the
-- handset would retry forever. What happens at 80 % and 100 % is an in-app
-- notification to the owners (kind 'storage_quota', below) and nothing else.

-- 1 ── the index the sweep's aggregate needs ─────────────────────────────────
--
-- The only index on recordings until now was recordings_call (call_id), 0019.
-- A partial covering index lets the per-org sum run as an index-only scan over
-- uploaded rows. `uploaded_at` is INCLUDEd as well as filtered on (doc 27
-- names `bytes` only) because the sweep also reads min(uploaded_at) for "oldest
-- recording", and without it every row would be a heap fetch after all.
-- Plain CREATE INDEX inside the migration transaction: it takes
-- a SHARE lock on recordings for its duration, which blocks handset upload
-- COMPLETION (not recording) while it builds. Count prod rows read-only
-- before applying; above ~1M rows, build it CONCURRENTLY by hand first
-- (IF NOT EXISTS then makes this a no-op).
CREATE INDEX IF NOT EXISTS recordings_org_uploaded
  ON recordings (org_id) INCLUDE (bytes, uploaded_at) WHERE uploaded_at IS NOT NULL;

-- 2 ── the snapshot ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_storage_usage (
  org_id               uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  recording_bytes      bigint NOT NULL DEFAULT 0 CHECK (recording_bytes >= 0),
  recording_count      integer NOT NULL DEFAULT 0 CHECK (recording_count >= 0),
  oldest_recording_at  timestamptz,
  -- Approximate row bytes of the heaviest tables (doc 27 A4b). A full scan, so
  -- written nightly only; NULL until the first nightly run.
  db_bytes_estimate    bigint CHECK (db_bytes_estimate IS NULL OR db_bytes_estimate >= 0),
  db_estimated_at      timestamptz,
  -- Which quota threshold the owners were last told about (80 or 100), so an
  -- org sitting at 85 % is told once and not every hour. Falls back to NULL
  -- when usage drops under 80 %, so a second climb is told again.
  last_quota_alert_pct smallint CHECK (last_quota_alert_pct IS NULL OR last_quota_alert_pct IN (80, 100)),
  computed_at          timestamptz NOT NULL
);

-- One row per org per day, for the Plan page's 30-day growth line.
CREATE TABLE IF NOT EXISTS org_storage_daily (
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day             date NOT NULL,
  recording_bytes bigint NOT NULL CHECK (recording_bytes >= 0),
  PRIMARY KEY (org_id, day)
);

COMMENT ON TABLE org_storage_usage IS
  'Hourly snapshot of stored recording bytes per org, written by the worker (doc 27 §6.2). Reads are one row.';
COMMENT ON TABLE org_storage_daily IS
  'One recording_bytes reading per org per day, for 30-day growth (doc 27 §6.7).';

-- 3 ── the quota ─────────────────────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS storage_quota_bytes bigint;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_storage_quota_positive;
ALTER TABLE organizations ADD CONSTRAINT organizations_storage_quota_positive
  CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes > 0);
COMMENT ON COLUMN organizations.storage_quota_bytes IS
  'Operator-set storage quota in bytes (1024-based). NULL = none shown. Display and warn only - never blocks an upload.';

-- 4 ── RLS: both tables are tenant data ──────────────────────────────────────
--
-- Written only by the worker on the admin pool (a cross-tenant sweep); read by
-- the console inside withOrg. So `aura_app` gets SELECT and nothing else.
DO $$
DECLARE t text;
DECLARE api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['org_storage_usage', 'org_storage_daily'] LOOP
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
    EXECUTE format('REVOKE ALL ON %I FROM aura_app', t);
    EXECUTE format('GRANT SELECT ON %I TO aura_app', t);
  END LOOP;
END $$;

-- 5 ── the warning's notification kind ───────────────────────────────────────
--
-- Rewritten with the FULL list, per the drift rule (0100's header): the CHECK
-- and `NotificationKind` in packages/shared/src/notifications.ts must name the
-- same kinds, and notification-kinds.test.ts reads the LAST definition here.
DO $$
DECLARE conname text;
BEGIN
  SELECT c.conname INTO conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'notifications' AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%kind%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', conname);
  END IF;
END $$;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'task_due', 'deal_stage_changed', 'deal_idle',
                  'automation', 'report_ready', 'lead_assigned',
                  'opt_out_requested', 'channel_needs_attention',
                  'sla_breach', 'review_pending',
                  'call_access_requested',
                  -- 0128: stored recordings crossed 80 % / 100 % of the quota.
                  'storage_quota'));
