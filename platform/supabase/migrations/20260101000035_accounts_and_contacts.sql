-- 0035_accounts_and_contacts.sql — CRM Phase 1 foundation, part 2: Account
-- and Contact, the identity objects that inherit leads' "who called" role.
--
-- See 0034's header for the strangler-fig framing. Nothing here reads from or
-- writes to `leads` at migration time — population happens via the worker
-- dual-write (a later, separate change) and the one-time backfill script
-- (scripts/backfill-crm-objects.js), neither of which is part of this
-- schema-only migration.

CREATE TABLE IF NOT EXISTS accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Attribution only — which desk first created this account — NOT an
  -- isolation boundary the way workspace_id is on leads/calls. An account is
  -- a company, and a company is shared across a tenant's desks.
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  name          text NOT NULL,
  domain        text,
  -- Same hash-plus-privacy-lite-prefix scheme as leads/calls (0006): the full
  -- number is never stored here either, the hash is the dedup key.
  phone_hash    text,
  phone_prefix  text,
  phone_last3   text,
  -- {system: external_id}, e.g. {"hubspot": "1234"} — dedup input for
  -- merge/dedupe (0038) and the future bi-directional-sync epic.
  external_ids  jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  facts         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'merged')),
  -- Tombstone pointer (0038): set when this row lost a merge. Victims are
  -- never hard-deleted.
  merged_into_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_domain
  ON accounts (org_id, lower(domain)) WHERE domain IS NOT NULL AND status <> 'merged';
CREATE INDEX IF NOT EXISTS accounts_org_name     ON accounts (org_id, name);
CREATE INDEX IF NOT EXISTS accounts_org_activity ON accounts (org_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS accounts_merged_into  ON accounts (merged_into_id) WHERE merged_into_id IS NOT NULL;

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON accounts
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON accounts TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON accounts FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON accounts FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Contact ─────────────────────────────────────────────────────────────
-- The person-level identity that inherits leads' dedup role — but ORG-WIDE
-- (org_id, phone_hash), not workspace-scoped like leads is today. A person is
-- the same person regardless of which desk called them; that is correct CRM
-- behaviour and what "replacing leads' role" implies. Nothing reads from
-- `contacts` until a later milestone, so this is safe to land now — but
-- confirm before that milestone that neither live tenant actually relies on
-- per-workspace contact silos (see the Phase 1 plan).
CREATE TABLE IF NOT EXISTS contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  account_id    uuid REFERENCES accounts(id) ON DELETE SET NULL,
  first_name    text,
  last_name     text,
  -- Denormalised heading, same fallback ladder as leadTitle() (leads.ts):
  -- name -> number prefix -> "Unknown caller". Kept so list/board rendering
  -- never needs a second lookup.
  display_name  text NOT NULL,
  email         text,
  phone_hash    text,
  phone_prefix  text,
  phone_last3   text,
  title         text,
  external_ids  jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Provenance only — which lead this contact was first backfilled/derived
  -- from. Deliberately NOT unique: many leads (e.g. two workspaces that used
  -- to silo the same number) can collapse into one org-wide contact.
  source_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  -- Same additive-merge contract as leads.facts — a follow-up call must never
  -- blank a fact an earlier one established.
  facts         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'merged')),
  merged_into_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  first_call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  last_call_id  uuid REFERENCES calls(id) ON DELETE SET NULL,
  call_count    int NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_phone
  ON contacts (org_id, phone_hash) WHERE phone_hash IS NOT NULL AND status <> 'merged';
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_email
  ON contacts (org_id, lower(email)) WHERE email IS NOT NULL AND status <> 'merged';
CREATE INDEX IF NOT EXISTS contacts_org_activity ON contacts (org_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS contacts_account      ON contacts (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_source_lead   ON contacts (source_lead_id) WHERE source_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_merged_into   ON contacts (merged_into_id) WHERE merged_into_id IS NOT NULL;

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON contacts
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON contacts FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON contacts FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
