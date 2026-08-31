-- 0073_crm_projects.sql — the thing a call is ABOUT.
--
-- A telecalling floor that sells one product does not need this. Sirah
-- Digital's does not sell one product: a single call moves between the 3D
-- website, Aura, LexDraft and the analytics agent, and the owner's first
-- question about any lead is "which of ours is this for?". Today that answer
-- exists only inside the transcript.
--
-- ── WHY NOT A TAG, A CUSTOM FIELD, OR A MARKETING SOURCE ────────────────
--
-- All three already exist and all three are the wrong shape:
--   * a TAG (0057) is an open-ended editorial label a human sticks on a
--     handful of records — no catalogue, no stable key, nothing an extractor
--     can be pointed at;
--   * a CUSTOM FIELD (0037) is a typed slot on EVERY record of an object, and
--     a picklist custom field would put the project list inside a field
--     definition where nothing else can join to it;
--   * a MARKETING SOURCE (0057) answers "which campaign brought them in",
--     which is upstream of and independent from "what are they buying".
--     A lead from the Instagram ad can be about LexDraft.
--
-- A project is a first-class thing the tenant owns, with its own name, its own
-- lifetime, and — critically — its own list of spoken ALIASES, because the
-- catalogue is what the extractor matches a transcript against. That makes it
-- a table.
--
-- ── FLEXIBLE BY CONSTRUCTION ───────────────────────────────────────────
--
-- No seeded rows, no CHECK constraint listing product names, no enum. Every
-- project is created by the tenant at runtime through the console, exactly
-- like a tag or a campaign. "3D website" is not privileged over whatever they
-- add next quarter — same precedent as marketing_sources.channel (0057) and
-- role_permissions.object_type (0039).

CREATE TABLE IF NOT EXISTS crm_projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name        text NOT NULL CHECK (length(btrim(name)) > 0),

  -- A stable machine identifier, separate from the display name. The name is
  -- the tenant's to rename ("3D Website" -> "Immersive Web") without breaking
  -- a saved board filter, an automation rule, or a URL. Same reasoning as
  -- lead stage keys.
  key         text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]*$'),

  description text,

  -- A design-token key, not a hex value — the console renders from the theme
  -- so a project chip stays legible in both light and dark. Matches tags.color
  -- (0057) exactly; NULL falls back to a hashed default.
  color       text,

  -- What this project SOUNDS like on a call. The detector matches the name
  -- plus every alias, so a tenant can teach it "three-d site", "3d web",
  -- "the website project" without renaming the project itself.
  --
  -- text[] rather than a child table: aliases are a short, unordered,
  -- always-read-together list with no attributes of their own and nothing
  -- foreign-keys to them. A join table here would buy nothing and cost a
  -- query. Precedent: organizations.enabled_modules (0072).
  aliases     text[] NOT NULL DEFAULT '{}',

  -- Retiring a project must not orphan the leads it produced, so this is a
  -- flag rather than a DELETE — same call marketing_sources.active makes.
  -- An inactive project stops being offered for new detection and stays
  -- readable on every record that already carries it.
  active      boolean NOT NULL DEFAULT true,

  -- The tenant's own ordering for board columns and filter lists. Ties break
  -- on name so the order is total and stable rather than arbitrary.
  sort_order  integer NOT NULL DEFAULT 0,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive on the name for the reason tags_org_name_unique gives:
-- "Aura" and "aura" as two projects is how a catalogue turns to noise.
CREATE UNIQUE INDEX IF NOT EXISTS crm_projects_org_name_unique
  ON crm_projects (org_id, lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS crm_projects_org_key_unique
  ON crm_projects (org_id, key);

ALTER TABLE crm_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_projects FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON crm_projects
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON crm_projects TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON crm_projects FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON crm_projects FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER crm_projects_set_updated_at BEFORE UPDATE ON crm_projects
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── call_projects: what THIS call was about ────────────────────────────
--
-- Many-to-many on purpose. The whole premise of the feature is that one call
-- covers several projects ("we'll do the 3D site first, then look at
-- LexDraft"), so a single project_id on `calls` would have to pick a winner
-- and silently discard the rest. This table keeps every hit; the lead's
-- denormalised project_id below is the derived summary, not the record.
CREATE TABLE IF NOT EXISTS call_projects (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id    uuid NOT NULL REFERENCES calls(id)         ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES crm_projects(id)  ON DELETE CASCADE,

  -- 0..1. How strongly the transcript pointed here, used to rank the hits and
  -- to pick the lead's primary project. numeric, not float — a score that has
  -- been through a float sorts differently on two machines.
  confidence numeric(4, 3) NOT NULL DEFAULT 0
    CHECK (confidence >= 0 AND confidence <= 1),

  -- Provenance, same vocabulary as custom_field_values.source (0045). A human
  -- correcting the detector on one call must be distinguishable from the
  -- detector's own guess, because re-running the pipeline is allowed to
  -- overwrite the guess and never the correction.
  source     text NOT NULL DEFAULT 'extraction'
    CHECK (source IN ('extraction', 'human', 'automation', 'import')),

  -- The alias/name that actually matched, kept so the console can explain
  -- "detected because the call said 'three-d site'" instead of asking the
  -- owner to trust an unexplained label.
  matched_on text,

  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, project_id)
);

-- "Every call about this project" — the query the project detail view is.
CREATE INDEX IF NOT EXISTS call_projects_project
  ON call_projects (org_id, project_id);

ALTER TABLE call_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_projects FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON call_projects
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON call_projects TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON call_projects FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON call_projects FROM PUBLIC;

-- ── the project on the record ──────────────────────────────────────────
--
-- SET NULL on delete, matching contacts.marketing_source_id: removing a
-- project from the catalogue must never delete the leads it was attached to.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS project_id uuid
    REFERENCES crm_projects(id) ON DELETE SET NULL;

-- HUMAN-OWNS-IT, the same rule that keeps upsertLead off stage/status and
-- extraction off a custom field whose source is 'human'. The detector may
-- overwrite its own earlier guess on a later call; once this reads 'human'
-- it is the owner's column and the pipeline stops writing it.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS project_source text
    CHECK (project_source IN ('extraction', 'human', 'automation', 'import'));

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS project_id uuid
    REFERENCES crm_projects(id) ON DELETE SET NULL;
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS project_source text
    CHECK (project_source IN ('extraction', 'human', 'automation', 'import'));

-- Partial, mirroring contacts_marketing_source: the overwhelming majority of
-- rows have no project yet, and indexing those NULLs helps nothing. Carries
-- last_activity_at so "this project's pipeline, newest first" — the list view
-- filtered by project — is served by the index rather than a sort.
CREATE INDEX IF NOT EXISTS leads_org_project
  ON leads (org_id, project_id, last_activity_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_org_project
  ON deals (org_id, project_id, last_activity_at DESC) WHERE project_id IS NOT NULL;
