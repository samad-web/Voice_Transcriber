-- 0062_import_jobs.sql — Kailash gap Milestone 2: bulk CSV import for
-- contacts/accounts/deals. The CSV itself is parsed in the browser (Papa
-- Parse, matching the Kailash reference build's own architecture) and posted
-- here as plain JSON rows — no multer/file-upload plumbing needed.

CREATE TABLE IF NOT EXISTS import_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity            text NOT NULL CHECK (entity IN ('contact', 'account', 'deal')),
  status            text NOT NULL DEFAULT 'done' CHECK (status IN ('running', 'done', 'failed')),
  mapping           jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_strategy   text NOT NULL DEFAULT 'skip' CHECK (dedupe_strategy IN ('skip', 'update', 'create')),
  total_rows        int NOT NULL DEFAULT 0,
  inserted_count    int NOT NULL DEFAULT 0,
  updated_count     int NOT NULL DEFAULT 0,
  skipped_count     int NOT NULL DEFAULT 0,
  failed_count      int NOT NULL DEFAULT 0,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_jobs_org ON import_jobs (org_id, created_at DESC);

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON import_jobs
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE ON import_jobs TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON import_jobs FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON import_jobs FROM PUBLIC;

CREATE TABLE IF NOT EXISTS import_job_errors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id      uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number  int NOT NULL,
  raw         jsonb NOT NULL,
  error       text NOT NULL
);

CREATE INDEX IF NOT EXISTS import_job_errors_job ON import_job_errors (job_id, row_number);

ALTER TABLE import_job_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_job_errors FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON import_job_errors
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT ON import_job_errors TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON import_job_errors FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON import_job_errors FROM PUBLIC;
