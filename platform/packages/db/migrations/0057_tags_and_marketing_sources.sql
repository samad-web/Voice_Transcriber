-- 0057_tags_and_marketing_sources.sql - segmentation and attribution.
--
-- ── TAGS ────────────────────────────────────────────────────────────────
--
-- Aura had none. Not a thin version - none: no column, no table, no way for a
-- person to mark "spoke at the expo", "price-sensitive", "call after 6pm".
-- Custom fields exist and are the wrong tool for this: a custom field is a
-- named slot with a declared type that every record has, and a tag is an
-- open-ended label that a handful of records carry. Modelling tags as a
-- boolean custom field per label gives you a definitions table that grows
-- forever and a UI nobody can scan.
--
-- ── WHY A JOIN TABLE PER OBJECT, NOT ONE POLYMORPHIC TABLE ──────────────
--
-- (object_type, record_id) would be one table instead of two, and would also
-- throw away referential integrity: nothing would stop a row pointing at a
-- deleted contact, and no FK could cascade. 0037 made the same call for
-- custom-field values and 0041 for tasks, and this follows it - real FKs,
-- real CASCADE, one small table per object that can carry tags.
--
-- Accounts are deliberately absent for now. Tagging a company is a coherent
-- idea, but nobody has asked for it, and an unused table is a migration to
-- write later rather than dead weight to carry now.
--
-- ── MARKETING SOURCES ───────────────────────────────────────────────────
--
-- `marketing.funnel_submissions` already captures UTM on the platform's own
-- funnel. What is missing is the CAMPAIGN as a first-class thing a tenant
-- owns: `lead_source` answers "which channel", and every question worth
-- asking afterwards ("which of the four ads", "what did the expo cost per
-- deal") is a level beneath it. B2 Consultants' schema draws exactly this
-- distinction - a coarse channel on the lead, a MarketingSource beneath it -
-- and it is the half Aura does not have.

CREATE TABLE IF NOT EXISTS tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  -- A design-token key, not a hex value: the console renders from the theme so
  -- a tag stays legible in both light and dark. NULL falls back to a hashed
  -- default, so a tag is usable the moment it is named.
  color      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness. "VIP" and "vip" as two different tags is the
-- single most common way a tag list turns to noise, and it happens within a
-- week of shipping without this.
CREATE UNIQUE INDEX IF NOT EXISTS tags_org_name_unique
  ON tags (org_id, lower(btrim(name)));

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON tags
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON tags TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON tags FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON tags FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER tags_set_updated_at BEFORE UPDATE ON tags
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── contact_tags ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_tags (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
  -- Who attached it. A tag is an editorial judgement, and "who decided this
  -- person is price-sensitive" is a fair question to be able to answer.
  tagged_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);

-- "Every contact carrying this tag" - the query a segment is built from.
CREATE INDEX IF NOT EXISTS contact_tags_tag ON contact_tags (org_id, tag_id);

ALTER TABLE contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_tags FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON contact_tags
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_tags TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON contact_tags FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON contact_tags FROM PUBLIC;

-- ── deal_tags ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deal_tags (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id    uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  tagged_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, tag_id)
);

CREATE INDEX IF NOT EXISTS deal_tags_tag ON deal_tags (org_id, tag_id);

ALTER TABLE deal_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_tags FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON deal_tags
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON deal_tags TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON deal_tags FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON deal_tags FROM PUBLIC;

-- ── marketing_sources ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketing_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  -- The coarse channel this campaign belongs to. Free text rather than a
  -- CHECK: a tenant's channels are theirs ("expo", "referral", "hoarding"),
  -- and a closed set here would be a migration every time somebody tries
  -- something new.
  channel      text,

  -- The UTM triple, so a campaign can be recognised from a landing-page hit.
  -- All nullable: an expo stand has no utm_source and is still a campaign.
  utm_source   text,
  utm_medium   text,
  utm_campaign text,

  -- What it cost, for the only question anybody actually asks of attribution.
  -- numeric, never float: money that has been through a float is money that
  -- no longer reconciles.
  spend_amount numeric(14, 2),
  spend_currency text,

  -- Retiring a campaign must not orphan the contacts it produced, so this is
  -- a flag rather than a DELETE.
  active       boolean NOT NULL DEFAULT true,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS marketing_sources_org_name_unique
  ON marketing_sources (org_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS marketing_sources_utm
  ON marketing_sources (org_id, utm_campaign) WHERE utm_campaign IS NOT NULL;

ALTER TABLE marketing_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_sources FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON marketing_sources
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_sources TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON marketing_sources FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON marketing_sources FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER marketing_sources_set_updated_at BEFORE UPDATE ON marketing_sources
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── attribution on the record ───────────────────────────────────────────
-- SET NULL, matching the reasoning above: retiring or deleting a campaign
-- must never delete or orphan the people it brought in.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS marketing_source_id uuid
    REFERENCES marketing_sources(id) ON DELETE SET NULL;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS marketing_source_id uuid
    REFERENCES marketing_sources(id) ON DELETE SET NULL;

-- "Everything this campaign produced", which is the whole point of the table.
CREATE INDEX IF NOT EXISTS contacts_marketing_source
  ON contacts (org_id, marketing_source_id) WHERE marketing_source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deals_marketing_source
  ON deals (org_id, marketing_source_id) WHERE marketing_source_id IS NOT NULL;
