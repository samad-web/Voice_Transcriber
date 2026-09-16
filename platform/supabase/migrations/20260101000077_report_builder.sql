-- 0077_report_builder.sql - a REPORT as a thing the tenant assembles, versions,
-- shares and re-runs.
--
-- `/owner/reports` (Layer 3) is four fixed reports with fixed columns. It
-- answers the four questions we decided everyone has. This migration is the
-- other half: the questions we did not think of, asked by the person who has
-- them, without a deploy.
--
-- ── WHAT IS STORED, AND WHAT IS DELIBERATELY NOT ────────────────────────
--
-- A report document holds LAYOUT + WIDGET CONFIG + DATA BINDINGS. It never
-- holds a row of data. That single rule is what makes a report safe to
-- duplicate, template, share by link, version and schedule: every one of those
-- operations copies a description of a question, never an answer, so a stale
-- copy is impossible and a shared link cannot leak a snapshot of records the
-- viewer is no longer allowed to see. The answers are recomputed on every
-- read, through the same RLS and the same record scope as the console.
--
-- The one exception is `report_runs.snapshot`, and it is an exception on
-- purpose - see that table's header.
--
-- ── WHY A DATASET IS A ROW AND NOT A FILE ───────────────────────────────
--
-- The obvious build for "upload a CSV" is S3, which this platform already has
-- (recordings live there). It is the wrong tool here for three reasons:
--
--   * an object key is a capability. `report_dataset_rows` is behind RLS, so
--     "tenant A cannot read tenant B's uploaded data" is enforced by Postgres
--     rather than by every code path remembering to check a prefix. The
--     prompt's requirement 3.4 asks for exactly this - "not globally
--     addressable URLs";
--   * the transformation layer has to GROUP and AGGREGATE. Postgres does that;
--     an object store does not, so an S3 dataset would have to be pulled into
--     memory somewhere to be charted, which is the unbounded-row-count failure
--     the design doc's D2 exists to prevent;
--   * one engine, not two. A CRM source compiles to SQL over `deals`; an
--     uploaded source compiles to the SAME SQL shape over this table. Two
--     engines would eventually disagree about what `avg` of an empty group is,
--     and the disagreement would surface as a wrong number on a client report.
--
-- 50,000 rows is the ceiling (`MAX_UPLOAD_ROWS` in packages/shared). Above it
-- the upload is refused with the count in the message, never truncated.

-- ── report_datasets: where a widget's numbers come from ─────────────────
CREATE TABLE IF NOT EXISTS report_datasets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name        text NOT NULL CHECK (length(btrim(name)) > 0),

  -- 'crm'    - a curated, read-only view over the tenant's own tables. No rows
  --            are stored; `source_key` names one of the whitelisted sources
  --            in apps/api/src/modules/report-builder/crm-sources.ts.
  -- 'upload' - a CSV/JSON the tenant uploaded. Rows live in
  --            report_dataset_rows below.
  --
  -- A CHECK rather than an enum type, matching every other kind/status column
  -- in this schema (call_projects.source, invoices.status): a new kind is then
  -- a one-line migration rather than an ALTER TYPE that cannot run in a
  -- transaction with anything else.
  kind        text NOT NULL CHECK (kind IN ('crm', 'upload')),
  source_key  text,

  -- The inferred schema: [{ name, label, type, cardinality, nullRate, sample }].
  -- Written by the API on upload (or read from the source catalogue for
  -- kind='crm'), and the ONLY thing the suggestion engine and the drift
  -- checker read. Keeping it here rather than re-inferring per request is what
  -- lets a widget be validated against its source without touching 50,000 rows.
  columns     jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Sorted column names, hashed. Two uploads with the same shape have the same
  -- fingerprint, so "did the schema drift?" is one string comparison instead of
  -- a structural diff - and a re-upload that only changed VALUES does not flag
  -- a single widget. NULL for kind='crm', whose shape is code, not data.
  schema_fingerprint text,

  row_count   integer NOT NULL DEFAULT 0,

  -- Set every time rows are replaced, so the console can say "as of" rather
  -- than leaving a reader to assume a stale upload is live.
  refreshed_at timestamptz,

  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- A CRM dataset is a pointer to a source, so it MUST name one; an upload
  -- carries its own rows and must not pretend to. Expressed as a constraint
  -- rather than left to the controller, because a kind='crm' row with a null
  -- source_key is a dataset that can never be queried and would surface as an
  -- empty chart with no error.
  CONSTRAINT report_datasets_source_key_matches_kind
    CHECK ((kind = 'crm' AND source_key IS NOT NULL)
        OR (kind = 'upload' AND source_key IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS report_datasets_org_name_unique
  ON report_datasets (org_id, lower(btrim(name)));
-- "the tenant's data sources, newest first" - the picker in the widget editor.
CREATE INDEX IF NOT EXISTS report_datasets_org_created
  ON report_datasets (org_id, created_at DESC);

ALTER TABLE report_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_datasets FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON report_datasets
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON report_datasets TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON report_datasets FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON report_datasets FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER report_datasets_set_updated_at BEFORE UPDATE ON report_datasets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── report_dataset_rows: the uploaded rows themselves ───────────────────
--
-- One jsonb object per CSV row, values already coerced to the column's
-- inferred type by the API (so `->>'amount'` is always castable to numeric and
-- the query compiler never has to guess).
--
-- `row_index` preserves upload order, which is the only ordering an uploaded
-- dataset has - a table widget with no explicit sort shows the file's own
-- order, which is what someone who just uploaded a file expects to see.
CREATE TABLE IF NOT EXISTS report_dataset_rows (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dataset_id uuid NOT NULL REFERENCES report_datasets(id) ON DELETE CASCADE,
  row_index  integer NOT NULL,
  data       jsonb NOT NULL,
  PRIMARY KEY (dataset_id, row_index)
);

-- Every query this table ever serves is "all rows of one dataset", so the PK
-- above is already the access path. This index exists only so the RLS
-- predicate can be satisfied from an index on a cross-dataset scan (the
-- cascade-delete path) rather than a seq scan of every tenant's rows.
CREATE INDEX IF NOT EXISTS report_dataset_rows_org ON report_dataset_rows (org_id);

ALTER TABLE report_dataset_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_dataset_rows FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON report_dataset_rows
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON report_dataset_rows TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON report_dataset_rows FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON report_dataset_rows FROM PUBLIC;

-- ── reports: the document ───────────────────────────────────────────────
--
-- TWO documents, not one. `draft_doc` is what the editor writes on every
-- autosave; `published_doc` is what a shared link and a schedule read. Without
-- the split, dragging a widget at 4pm silently rearranges the report a client
-- has open in another tab - the classic "I was just trying things out" data
-- incident. Publishing is the only thing that copies one to the other, and it
-- is explicit.
CREATE TABLE IF NOT EXISTS reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  description   text,

  -- 'draft'     - never published; only people on report_shares can see it.
  -- 'published' - published_doc is populated and the share link (if enabled)
  --               resolves.
  -- 'archived'  - hidden from the list, link dead, nothing deleted.
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'published', 'archived')),

  draft_doc     jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_doc jsonb,
  published_version integer NOT NULL DEFAULT 0,
  published_at  timestamptz,
  published_by  uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Optimistic locking for the autosave. Every PATCH sends the revision it
  -- read; a mismatch is a 409 the editor surfaces as "this report changed in
  -- another tab" rather than a silent last-write-wins that eats somebody's
  -- afternoon. Out of scope for v1 (per the prompt's section 7) is real
  -- collaborative editing - this is the cheap half that stops the worst case.
  revision      integer NOT NULL DEFAULT 0,

  -- Read-only share link. NULL means no link has ever been minted; minting is
  -- a deliberate act by an Owner, and revoking sets it back to NULL so an old
  -- URL 404s forever rather than being reusable.
  --
  -- UNIQUE across the whole platform, like messaging_channels.webhook_token:
  -- the token IS the credential on that path, so it is resolved on the admin
  -- pool to find the org before any tenant context exists.
  public_token  text UNIQUE,

  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Provenance: which template this was started from, kept so the template
  -- library can show "12 reports built from this" and so a template edit has a
  -- knowable blast radius. SET NULL - deleting a template must never delete
  -- the reports people built with it.
  source_template_id uuid,

  -- A published report must actually have something published. Catches the
  -- one ordering bug this table can have (status flipped before the doc was
  -- copied), which would otherwise render an empty page behind a live link.
  CONSTRAINT reports_published_has_doc
    CHECK (status <> 'published' OR published_doc IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS reports_org_updated
  ON reports (org_id, updated_at DESC) WHERE status <> 'archived';

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON reports
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON reports TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON reports FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON reports FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER reports_set_updated_at BEFORE UPDATE ON reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── report_shares: who may do what to ONE report ────────────────────────
--
-- This is a SECOND permission layer, on top of - never instead of -
-- CrmPermissionsGuard's `deal:view`/`deal:export` grants. The two answer
-- different questions: the role grid answers "may this person see deal data at
-- all", and this table answers "is this particular report theirs to edit".
-- Passing the first and failing the second is an ordinary, expected outcome.
--
-- Roles, narrowest first:
--   viewer - read the PUBLISHED doc. No draft, no export of underlying data.
--   editor - read/write the draft, publish, export. Cannot change who has access.
--   owner  - all of the above, plus shares, schedules, the public link, delete.
CREATE TABLE IF NOT EXISTS report_shares (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_id  uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id)
);

-- "every report this person can reach" - the list page's own query.
CREATE INDEX IF NOT EXISTS report_shares_user ON report_shares (org_id, user_id);

ALTER TABLE report_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_shares FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON report_shares
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON report_shares TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON report_shares FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON report_shares FROM PUBLIC;

-- ── report_templates: the starter library, and the tenant's own ─────────
--
-- ONE table for both, distinguished by `org_id IS NULL` = platform-provided.
-- The prompt (3.5.1) asks for starter templates that are "reviewable/editable
-- by platform admins (not hardcoded, so the set can grow without a code
-- change) - store them the same way as tenant templates, just with a
-- global/platform-owned tenant flag". This is that.
--
-- ── THE RLS ASYMMETRY IS THE WHOLE POINT ────────────────────────────────
--
-- USING allows `org_id IS NULL`, so every tenant READS the global library.
-- WITH CHECK does NOT, so no tenant can WRITE one - a tenant that tried to
-- save a template with a null org would have the row rejected by Postgres,
-- not by a controller check that a future refactor could drop. Global rows are
-- seeded by migration and edited by the operator console on the admin pool.
CREATE TABLE IF NOT EXISTS report_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,

  -- Stable machine name. Unique per owner (global, or one org) so a tenant may
  -- have their own "lead_funnel" without colliding with ours.
  key          text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]*$'),
  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  description  text,
  -- Grouping for the picker: 'pipeline' | 'marketing' | 'operations' | 'blank'.
  -- Free text, like marketing_sources.channel - a category list nobody can
  -- extend without a migration is a category list that goes stale.
  category     text,

  -- The unbound document: same shape as reports.draft_doc, but every widget
  -- carries `datasetRole` instead of `datasetId`. See design doc D4.
  doc          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- [{ role, label, hint, suggestedSourceKey }] - the roles the instantiate
  -- step asks the user to fill. `suggestedSourceKey` is why a starter template
  -- can bind itself: "lead_funnel wants a dataset in role `leads`, and the CRM
  -- source `leads` is right there", so a first-time user gets a populated
  -- report without uploading anything (acceptance criterion 18).
  dataset_roles jsonb NOT NULL DEFAULT '[]'::jsonb,

  active       boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,

  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Two partial uniques rather than one on (org_id, key): NULL is not equal to
-- itself in a unique index, so a plain composite would happily allow two
-- global templates both keyed 'lead_funnel'.
CREATE UNIQUE INDEX IF NOT EXISTS report_templates_global_key_unique
  ON report_templates (key) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS report_templates_org_key_unique
  ON report_templates (org_id, key) WHERE org_id IS NOT NULL;

ALTER TABLE report_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_templates FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON report_templates
    USING (org_id IS NULL OR org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON report_templates TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON report_templates FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON report_templates FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER report_templates_set_updated_at BEFORE UPDATE ON report_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Deferred FK: reports is created above templates, so this could not be an
-- inline REFERENCES. SET NULL, not CASCADE - see the column's own comment.
DO $$ BEGIN
  ALTER TABLE reports
    ADD CONSTRAINT reports_source_template_fk
    FOREIGN KEY (source_template_id) REFERENCES report_templates(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── report_palettes: the tenant's own colours ───────────────────────────
--
-- The four built-in palettes are code (packages/shared), not rows: they are
-- part of the design system and a tenant editing "Corporate Navy" out from
-- under a report that references it by id is a broken report. A tenant's
-- custom palette is a row here and belongs to them entirely.
CREATE TABLE IF NOT EXISTS report_palettes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) > 0),

  -- Ordered series colours, `#rrggbb`. Validated in the API against the same
  -- regex the console's picker enforces; a CHECK on a jsonb array of strings
  -- would need a subquery, which CHECK cannot have.
  colors     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Optional page background/surface override. NULL = inherit the preset.
  background text,

  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS report_palettes_org_name_unique
  ON report_palettes (org_id, lower(btrim(name)));

ALTER TABLE report_palettes ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_palettes FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON report_palettes
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON report_palettes TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON report_palettes FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON report_palettes FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER report_palettes_set_updated_at BEFORE UPDATE ON report_palettes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── report_schedules: recurring delivery, INSIDE the console ────────────
--
-- ── SAFETY RULE 3 ───────────────────────────────────────────────────────
--
-- "Nothing automated can send." The Layer 2 action union has no send_email
-- member and a test asserts it; the outreach sweep moves a step to 'due' and
-- leaves the sending to a person. A cron that emails a PDF every Monday is an
-- automated sender and would break that rule.
--
-- So `recipients` is `uuid[]` of USER IDS, not text[] of addresses. There is
-- nowhere in this schema to put an email address, which makes the rule a
-- property of the data model rather than a habit of the code. Delivery is a
-- row in `notifications` (0048), which that module's own header describes as
-- something that "cannot reach a person who is not signed in to the console".
--
-- Wiring an external channel later means adding a column here, which is
-- exactly the review this shape is meant to force.
CREATE TABLE IF NOT EXISTS report_schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_id   uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,

  cadence     text NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  -- 0=Sunday..6=Saturday, weekly only. 1..28 for monthly - 28, not 31, so
  -- "the 30th" cannot silently skip February.
  day_of_week  smallint CHECK (day_of_week BETWEEN 0 AND 6),
  day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 28),
  -- UTC, because the worker's clock is UTC and a schedule that drifts with a
  -- server's local DST is a support ticket nobody can reproduce. The console
  -- renders it in the tenant's own zone.
  hour_utc    smallint NOT NULL DEFAULT 6 CHECK (hour_utc BETWEEN 0 AND 23),

  recipients  uuid[] NOT NULL DEFAULT '{}',

  active      boolean NOT NULL DEFAULT true,

  -- The claim token. The sweep does a conditional UPDATE on this before it
  -- does any work, so two workers racing the same due schedule produce one
  -- run, not two - the same optimistic-claim shape the outbox drains use.
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,

  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- A weekly schedule needs its day and a monthly one needs its date;
  -- otherwise "weekly" has no meaning and the next-run arithmetic has to
  -- invent one.
  CONSTRAINT report_schedules_cadence_has_its_field
    CHECK ((cadence = 'daily'   AND day_of_week IS NULL AND day_of_month IS NULL)
        OR (cadence = 'weekly'  AND day_of_week IS NOT NULL)
        OR (cadence = 'monthly' AND day_of_month IS NOT NULL))
);

-- The sweep's own query: due, active, across every tenant. Partial on `active`
-- because a paused schedule is never work.
CREATE INDEX IF NOT EXISTS report_schedules_due
  ON report_schedules (next_run_at) WHERE active;
CREATE INDEX IF NOT EXISTS report_schedules_report
  ON report_schedules (org_id, report_id);

ALTER TABLE report_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_schedules FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON report_schedules
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON report_schedules TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON report_schedules FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON report_schedules FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER report_schedules_set_updated_at BEFORE UPDATE ON report_schedules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── report_runs: a frozen answer ────────────────────────────────────────
--
-- THE ONE PLACE DATA IS STORED IN THIS FEATURE, and it earns the exception:
-- "the weekly numbers, as they stood on Monday" is the entire point of a
-- scheduled report. Recomputing on open would mean Thursday's reader and
-- Monday's notification disagree about the same report, which is worse than
-- stale - it is unreproducible.
--
-- Consequences accepted, and mitigated:
--   * a snapshot outlives a permission change, so a run is only ever readable
--     by the recipients recorded ON IT, re-checked against live membership at
--     read time - a person removed from the org cannot open an old run;
--   * a snapshot outlives an erasure request. `report_runs` is org-cascaded,
--     and the tenancy erasure tool must clear it. Aggregates, not records:
--     the query compiler caps a run at MAX_RESULT_ROWS grouped rows, and a
--     table widget's raw rows are the only case that stores anything
--     row-shaped.
CREATE TABLE IF NOT EXISTS report_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  report_id   uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  -- NULL for a run someone triggered by hand from the console.
  schedule_id uuid REFERENCES report_schedules(id) ON DELETE SET NULL,

  status      text NOT NULL DEFAULT 'running'
                CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),

  -- { doc, widgets: { <widgetId>: { rows, columns, error? } }, generatedAt }
  -- `doc` is copied in too, so a run renders correctly even after the report
  -- itself is re-laid-out or deleted.
  snapshot    jsonb,

  -- 'partial' means some widgets rendered and some did not; this holds the
  -- reason for the ones that did not, so the console never shows a blank tile
  -- with no explanation (requirement 3.7, "no silent failures").
  error       text,

  -- Who this run was for. Copied from the schedule at run time rather than
  -- joined, because the schedule's recipient list can change afterwards and a
  -- run's audience is a historical fact.
  recipients  uuid[] NOT NULL DEFAULT '{}',

  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS report_runs_report
  ON report_runs (org_id, report_id, started_at DESC);

ALTER TABLE report_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_runs FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON report_runs
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON report_runs TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON report_runs FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON report_runs FROM PUBLIC;

-- ── the notification kind a scheduled run produces ──────────────────────
--
-- notifications.kind is a CHECK, not an enum, and 0048 listed five values.
-- A sixth is needed or every scheduled run's notify() would fail the
-- constraint and the whole delivery would be silently lost.
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
                  'automation', 'report_ready'));

-- ── the starter library (prompt 3.5.1) ──────────────────────────────────
--
-- Global rows, org_id NULL. Seeded rather than hardcoded so a platform admin
-- can edit the set, and so adding a fifth starter is an INSERT rather than a
-- deploy - which is what the prompt asks for in as many words.
--
-- Every placeholder widget names the COLUMN TYPE it wants ("Map a date column
-- here...") rather than sitting blank, because the prompt is explicit that a
-- blank canvas is not a workable starting point for a first-time user.
--
-- `suggestedSourceKey` on each dataset role is what makes acceptance criterion
-- 18 reachable with zero uploads: the CRM sources are already there, so
-- picking "Lead Funnel" and clicking through binds `leads` and renders real
-- numbers immediately.

INSERT INTO report_templates (org_id, key, name, description, category, sort_order, doc, dataset_roles)
VALUES
(NULL, 'blank', 'Blank canvas',
 'An empty page. For when you know exactly what you want to build.',
 'blank', 0,
 '{"version":1,"theme":{"preset":"minimal","paletteId":"corporate-navy"},"pages":[{"id":"p1","name":"Page 1","widgets":[]}]}'::jsonb,
 '[]'::jsonb),

(NULL, 'lead-funnel', 'Lead funnel',
 'Where leads are stacking up, how many convert, and which sources they came from.',
 'pipeline', 1,
 '{"version":1,"theme":{"preset":"minimal","paletteId":"corporate-navy"},
   "pages":[{"id":"p1","name":"Funnel","widgets":[
     {"id":"w1","type":"kpi","title":"Open leads","layout":{"x":0,"y":0,"w":3,"h":3},
      "datasetRole":"leads","respondsToPageFilters":true,
      "query":{"dimensions":[],"measures":[{"agg":"count","alias":"value"}],
               "filters":[{"column":"status","op":"eq","value":"open"}]},
      "options":{"format":"number"}},
     {"id":"w2","type":"kpi","title":"Won","layout":{"x":3,"y":0,"w":3,"h":3},
      "datasetRole":"leads","respondsToPageFilters":true,
      "query":{"dimensions":[],"measures":[{"agg":"count","alias":"value"}],
               "filters":[{"column":"status","op":"eq","value":"won"}]},
      "options":{"format":"number"}},
     {"id":"w3","type":"kpi","title":"Won value","layout":{"x":6,"y":0,"w":3,"h":3},
      "datasetRole":"leads","respondsToPageFilters":true,
      "query":{"dimensions":[],"measures":[{"column":"value_num","agg":"sum","alias":"value"}],
               "filters":[{"column":"status","op":"eq","value":"won"}]},
      "options":{"format":"currency"}},
     {"id":"w4","type":"kpi","title":"Win rate","layout":{"x":9,"y":0,"w":3,"h":3},
      "datasetRole":"leads","respondsToPageFilters":true,
      "query":{"dimensions":[],
               "measures":[{"agg":"count","alias":"total"},
                           {"agg":"count","alias":"won",
                            "where":{"column":"status","op":"eq","value":"won"}}],
               "derived":[{"alias":"value","op":"div","left":"won","right":"total"}]},
      "options":{"format":"percent"}},
     {"id":"w5","type":"chart","chart":"bar","title":"Leads by stage",
      "subtitle":"Where the pipeline is stacking up right now",
      "layout":{"x":0,"y":3,"w":7,"h":8},
      "datasetRole":"leads","respondsToPageFilters":true,
      "placeholder":"Map a category column here for the funnel bars",
      "query":{"dimensions":[{"column":"stage"}],
               "measures":[{"agg":"count","alias":"Leads"}],
               "sort":{"key":"Leads","direction":"desc"}},
      "options":{"showLegend":false,"showGrid":true,"filterKey":"stage"}},
     {"id":"w6","type":"chart","chart":"donut","title":"What they are about",
      "subtitle":"Leads by project - which of your offerings is pulling",
      "layout":{"x":7,"y":3,"w":5,"h":8},
      "datasetRole":"leads","respondsToPageFilters":true,
      "placeholder":"Map a category column here to split the ring",
      "query":{"dimensions":[{"column":"project_name"}],
               "measures":[{"agg":"count","alias":"Leads"}],
               "topN":{"enabled":true,"n":8}},
      "options":{"showLegend":true,"filterKey":"project_name"}},
     {"id":"w7","type":"chart","chart":"line","title":"New leads over time",
      "subtitle":"Weekly intake",
      "layout":{"x":0,"y":11,"w":12,"h":7},
      "datasetRole":"leads","respondsToPageFilters":true,
      "placeholder":"Map a date column here for your trend line",
      "query":{"dimensions":[{"column":"created_at","bucket":"week"}],
               "measures":[{"agg":"count","alias":"Leads"}],
               "sort":{"key":"created_at","direction":"asc"}},
      "options":{"showGrid":true,"showLegend":false}}]}]}'::jsonb,
 '[{"role":"leads","label":"Leads","hint":"A list of leads or enquiries, one row each","suggestedSourceKey":"leads"}]'::jsonb),

(NULL, 'sales-summary', 'Sales summary',
 'Revenue trend, the deals that moved, and how each rep is doing. Built for a Monday review.',
 'pipeline', 2,
 '{"version":1,"theme":{"preset":"executive","paletteId":"minimal-mono"},
   "pages":[{"id":"p1","name":"Summary","widgets":[
     {"id":"w1","type":"kpi","title":"Won value","layout":{"x":0,"y":0,"w":4,"h":3},
      "datasetRole":"deals","respondsToPageFilters":true,
      "query":{"dimensions":[],"measures":[{"column":"amount","agg":"sum","alias":"value"}],
               "filters":[{"column":"status","op":"eq","value":"won"}]},
      "options":{"format":"currency"}},
     {"id":"w2","type":"kpi","title":"Open pipeline","layout":{"x":4,"y":0,"w":4,"h":3},
      "datasetRole":"deals","respondsToPageFilters":true,
      "query":{"dimensions":[],"measures":[{"column":"amount","agg":"sum","alias":"value"}],
               "filters":[{"column":"status","op":"eq","value":"open"}]},
      "options":{"format":"currency"}},
     {"id":"w3","type":"kpi","title":"Average deal size","layout":{"x":8,"y":0,"w":4,"h":3},
      "datasetRole":"deals","respondsToPageFilters":true,
      "query":{"dimensions":[],"measures":[{"column":"amount","agg":"avg","alias":"value"}],
               "filters":[{"column":"status","op":"eq","value":"won"}]},
      "options":{"format":"currency"}},
     {"id":"w4","type":"chart","chart":"area","title":"Revenue trend",
      "subtitle":"Won value by month",
      "layout":{"x":0,"y":3,"w":12,"h":8},
      "datasetRole":"deals","respondsToPageFilters":true,
      "placeholder":"Map a date column here for your trend line",
      "query":{"dimensions":[{"column":"created_at","bucket":"month"}],
               "measures":[{"column":"amount","agg":"sum","alias":"Won value"}],
               "filters":[{"column":"status","op":"eq","value":"won"}],
               "sort":{"key":"created_at","direction":"asc"}},
      "options":{"showGrid":true,"showLegend":false}},
     {"id":"w5","type":"chart","chart":"bar","title":"By rep",
      "subtitle":"Won value per owner",
      "layout":{"x":0,"y":11,"w":6,"h":8},
      "datasetRole":"deals","respondsToPageFilters":true,
      "placeholder":"Map a category column here for the bars",
      "query":{"dimensions":[{"column":"owner_name"}],
               "measures":[{"column":"amount","agg":"sum","alias":"Won value"}],
               "filters":[{"column":"status","op":"eq","value":"won"}],
               "sort":{"key":"Won value","direction":"desc"},
               "topN":{"enabled":true,"n":10}},
      "options":{"showLegend":false,"filterKey":"owner_name"}},
     {"id":"w6","type":"table","title":"Top deals",
      "subtitle":"Largest open deals, by value",
      "layout":{"x":6,"y":11,"w":6,"h":8},
      "datasetRole":"deals","respondsToPageFilters":true,
      "query":{"dimensions":[{"column":"name"},{"column":"stage"},{"column":"owner_name"}],
               "measures":[{"column":"amount","agg":"sum","alias":"Value"}],
               "filters":[{"column":"status","op":"eq","value":"open"}],
               "sort":{"key":"Value","direction":"desc"},"limit":10},
      "options":{}}]}]}'::jsonb,
 '[{"role":"deals","label":"Deals","hint":"One row per deal or opportunity","suggestedSourceKey":"deals"}]'::jsonb),

(NULL, 'campaign-performance', 'Campaign performance',
 'Channel comparison, engagement over time, and what a lead is costing you.',
 'marketing', 3,
 '{"version":1,"theme":{"preset":"modern","paletteId":"vibrant-sunset"},
   "pages":[{"id":"p1","name":"Channels","widgets":[
     {"id":"w1","type":"kpi","title":"Leads captured","layout":{"x":0,"y":0,"w":4,"h":3},
      "datasetRole":"campaigns","respondsToPageFilters":true,
      "query":{"dimensions":[],"measures":[{"column":"lead_count","agg":"sum","alias":"value"}]},
      "options":{"format":"number"}},
     {"id":"w2","type":"kpi","title":"Campaign spend","layout":{"x":4,"y":0,"w":4,"h":3},
      "datasetRole":"campaigns","respondsToPageFilters":true,
      "query":{"dimensions":[],"measures":[{"column":"spend","agg":"sum","alias":"value"}]},
      "options":{"format":"currency"}},
     {"id":"w3","type":"kpi","title":"Cost per lead","layout":{"x":8,"y":0,"w":4,"h":3},
      "datasetRole":"campaigns","respondsToPageFilters":true,
      "query":{"dimensions":[],
               "measures":[{"column":"spend","agg":"sum","alias":"spend"},
                           {"column":"lead_count","agg":"sum","alias":"leads"}],
               "derived":[{"alias":"value","op":"div","left":"spend","right":"leads"}]},
      "options":{"format":"currency"}},
     {"id":"w4","type":"chart","chart":"bar","title":"Leads by channel",
      "subtitle":"Which channels are producing",
      "layout":{"x":0,"y":3,"w":6,"h":8},
      "datasetRole":"campaigns","respondsToPageFilters":true,
      "placeholder":"Map a category column here for the channel bars",
      "query":{"dimensions":[{"column":"channel"}],
               "measures":[{"column":"lead_count","agg":"sum","alias":"Leads"}],
               "sort":{"key":"Leads","direction":"desc"}},
      "options":{"showLegend":false,"filterKey":"channel"}},
     {"id":"w5","type":"chart","chart":"line","title":"Engagement trend",
      "subtitle":"New contacts per week",
      "layout":{"x":6,"y":3,"w":6,"h":8},
      "datasetRole":"contacts","respondsToPageFilters":true,
      "placeholder":"Map a date column here for your trend line",
      "query":{"dimensions":[{"column":"created_at","bucket":"week"}],
               "measures":[{"agg":"count","alias":"Contacts"}],
               "sort":{"key":"created_at","direction":"asc"}},
      "options":{"showGrid":true,"showLegend":false}},
     {"id":"w6","type":"table","title":"Campaign detail",
      "subtitle":"Spend against what it produced, per campaign",
      "layout":{"x":0,"y":11,"w":12,"h":7},
      "datasetRole":"campaigns","respondsToPageFilters":true,
      "query":{"dimensions":[{"column":"name"},{"column":"channel"}],
               "measures":[{"column":"spend","agg":"sum","alias":"Spend"},
                           {"column":"lead_count","agg":"sum","alias":"Leads"},
                           {"column":"won_value","agg":"sum","alias":"Won value"}],
               "derived":[{"alias":"Cost per lead","op":"div","left":"Spend","right":"Leads"}],
               "sort":{"key":"Leads","direction":"desc"},"limit":25},
      "options":{}}]}]}'::jsonb,
 '[{"role":"campaigns","label":"Campaigns","hint":"One row per marketing source, with its spend","suggestedSourceKey":"campaigns"},
   {"role":"contacts","label":"Contacts","hint":"One row per contact, for the intake trend","suggestedSourceKey":"contacts"}]'::jsonb)
ON CONFLICT DO NOTHING;
