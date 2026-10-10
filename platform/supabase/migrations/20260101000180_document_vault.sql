-- 0180_document_vault.sql
-- Build docs/indian-business-finance-documents-cycles-import §1: the documents
-- a business keeps, with an expiry, an owner and a reminder.
--
-- ── WHAT THIS CREATES, AND WHAT IT DELIBERATELY REUSES ──────────────────────
--
-- It creates:
--   org_compliance_profile  the legal form and the registrations a business
--                           holds, which decide what applies to it
--   document_categories     §1's groups, seeded and then tenant-owned
--   business_documents      the documents themselves, versioned
--
-- It reuses `document_access_log` from 0178 unchanged. That table was built
-- for the org chart's contract documents, with `document_id text` and a
-- nullable `contract_id` - and the header there says why the id is text and
-- not an FK: "the log must survive the document it records being deleted."
-- Both of those choices make it fit this vault exactly, and reusing it means
-- "who read which document" stays ONE query across both stores rather than a
-- UNION somebody has to remember to write. A business document's rows simply
-- leave `contract_id` NULL.
--
-- ── WHY THERE ARE TWO DOCUMENT STORES AT ALL ────────────────────────────────
--
-- `contract_documents` (0178) is PER-PERSON: offer letters, signed contracts,
-- NDAs, amendments. `business_documents` here is WHOLE-BUSINESS: the GST
-- certificate, the rent agreement, the insurance policy, the salary register.
--
-- The boundary is not tidiness, it is access. An employee's signed contract is
-- readable by whoever holds the org chart's permission; the GST certificate is
-- readable by whoever holds `finance:view`. Putting somebody's offer letter in
-- this table would widen who can read it, and `packages/shared/src/documents.ts`
-- has a test that keeps the catalogue honest about it.
--
-- ── EXPIRY IS STORED, EXPIRED IS NOT ───────────────────────────────────────
--
-- `expires_on` is a column; there is no `status`. §1 wants an expiry and a
-- reminder, and `documentExpiryStatus` derives expired / expiring / valid at
-- read time. The precedent is `scheduleItemStatus` in the finance module and
-- the scar behind it is `invoices.status`, which has allowed `'overdue'` since
-- migration 0060 with nothing ever setting it: a stored status needs a sweep,
-- and a sweep that stops running makes every expiry on this screen decorative.

------------------------------------------------------------------------------
-- What shape of business is this?
--
-- §5's second open question - "Is the target customer a small proprietor or a
-- registered company? This changes which compliance items matter" - is
-- answered by ASKING, once, and storing it here. The alternative is guessing
-- from whether a GSTIN is filled in, which gets a one-person business the
-- company's ROC filings and then gets the whole calendar ignored.
--
-- `registrations` is a text[] rather than seven booleans: the set grows (FSSAI,
-- IEC, a state-specific licence) and `ComplianceTag` in shared is the list the
-- console offers. No CHECK on its contents, for 0165's reason about
-- `resource_type` - a CHECK here would need a migration the day a tenant has a
-- registration the list had not imagined.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_compliance_profile (
  org_id          uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type     text CHECK (entity_type IS NULL OR entity_type IN
                    ('proprietorship', 'partnership', 'llp', 'private_limited',
                     'public_limited', 'trust')),
  registrations   text[] NOT NULL DEFAULT '{}',
  -- §2: "Make the year start and the view calendar configurable."
  --
  -- NOT stored here. `org_business_profile.fy_start_month` (migration 0126)
  -- already holds it, defaulting to 4, and a second copy would be the one that
  -- disagreed. Every function in `fiscal.ts` takes it as an argument and the
  -- API reads it from 0126's table.
  --
  -- What IS here is how far ahead the calendar looks when it generates filings.
  generate_months_ahead int NOT NULL DEFAULT 12
                    CHECK (generate_months_ahead BETWEEN 1 AND 36),
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE org_compliance_profile IS
  'The legal form and registrations that decide which compliance items and '
  'document categories apply (§1, §5). The financial year start lives on '
  'org_business_profile, not here.';

ALTER TABLE org_compliance_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_compliance_profile FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON org_compliance_profile
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE ON org_compliance_profile TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON org_compliance_profile FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON org_compliance_profile FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER org_compliance_profile_set_updated_at
    BEFORE UPDATE ON org_compliance_profile
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- The categories
--
-- Seeded from `DOCUMENT_CATALOGUE` and then OWNED by the tenant. The same
-- split as `advisor_rules` and for the same reason: a catalogue in code can be
-- improved in a deploy, and a tenant's edit has to survive that deploy. Unlike
-- `advisor_rules`, though, these rows are the whole record rather than an
-- override - a tenant adding "FSSAI licence" has no catalogue entry to
-- override, and §1's list is explicitly not exhaustive.
--
-- `code` is unique per org and stable. The seeded codes match the shared
-- catalogue's, so a later deploy that adds a category can insert it without
-- touching the ones a tenant has renamed.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code          text NOT NULL,
  label         text NOT NULL,
  doc_group     text NOT NULL CHECK (doc_group IN
                  ('registration', 'sales', 'purchase', 'banking', 'payroll',
                   'tax', 'books', 'roc', 'other')),
  expires       boolean NOT NULL DEFAULT false,
  -- Days before expiry to remind. Empty is legal and means "never remind",
  -- which is what `expires = false` implies anyway.
  reminder_offsets int[] NOT NULL DEFAULT '{}',
  -- One current copy expected (a PAN) vs accumulates (vendor bills). Drives
  -- the "missing documents" list, which only names singletons - see
  -- `vaultGaps`.
  singleton     boolean NOT NULL DEFAULT false,
  -- Who gets chased. NULL falls back to the owners, the way every other
  -- `finance_handler` route in this module resolves.
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  notes         text,
  -- A tenant switching a category off keeps its documents readable. Deleting
  -- the row would cascade them away, which is the one thing a vault may never
  -- do to a signed deed.
  archived_at   timestamptz,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS document_categories_code
  ON document_categories (org_id, code);
CREATE INDEX IF NOT EXISTS document_categories_group
  ON document_categories (org_id, doc_group, sort_order);

ALTER TABLE document_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_categories FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON document_categories
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_categories TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON document_categories FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON document_categories FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER document_categories_set_updated_at
    BEFORE UPDATE ON document_categories
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- The documents
--
-- ── NO URL IS STORED, FOR 0178'S REASON ────────────────────────────────────
--
-- `s3_key`, not `file_url`. 0178's header puts it best: "A URL that is safe to
-- store is a URL that does not expire, which is a public link to somebody's
-- signed contract." The row holds the object key and
-- `GET /finance/documents/:id/url` mints a 300-second signed URL per request
-- and logs that it did.
--
-- ── VERSIONS ARE ROWS ──────────────────────────────────────────────────────
--
-- A renewed trade licence is a new row with `version + 1`, not an UPDATE. The
-- old object stays in storage and stays downloadable, because the question
-- "what was our cover on the day of the claim" is asked precisely when the
-- current policy is a different document. `superseded_at` is set on the old
-- row by the API when the new one lands, so the expiry sweep can tell a lapsed
-- licence from a renewed one without a correlated subquery per document.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS business_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES document_categories(id) ON DELETE RESTRICT,
  title         text NOT NULL,
  -- The document's own identifying number, where it has one: a GSTIN, a policy
  -- number, a challan number. Text and unvalidated - the format differs per
  -- category and a CHECK here would be a format war with every tenant.
  doc_number    text,
  s3_key        text NOT NULL,
  file_name     text NOT NULL,
  content_type  text NOT NULL,
  bytes         bigint NOT NULL CHECK (bytes > 0),
  version       int NOT NULL DEFAULT 1 CHECK (version >= 1),
  issued_on     date,
  expires_on    date,
  -- Set when a newer version of the same document lands. Not derived from
  -- `version` alone: version 2 of a category with three unrelated documents in
  -- it says nothing about which of them it replaces.
  superseded_at timestamptz,
  superseded_by uuid REFERENCES business_documents(id) ON DELETE SET NULL,
  -- Per-document override of the category's offsets. Empty means "use the
  -- category's", NOT "never remind" - the API coalesces, and the distinction
  -- is why this is nullable rather than defaulting to '{}'.
  reminder_offsets int[],
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  notes         text,
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Soft delete. A vault that can hard-delete is a vault an auditor cannot
  -- trust, and `document_access_log` keeps the read history either way.
  deleted_at    timestamptz,
  deleted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- An expiry before the issue date is a typo, and one that makes a document
  -- permanently "expired" on every screen with no way to see why.
  CONSTRAINT business_documents_dates
    CHECK (issued_on IS NULL OR expires_on IS NULL OR expires_on >= issued_on)
);

CREATE INDEX IF NOT EXISTS business_documents_category
  ON business_documents (org_id, category_id, version DESC)
  WHERE deleted_at IS NULL;
-- The expiry sweep's index: only live, current, dated documents can expire,
-- so the partial index is the whole working set rather than the whole table.
CREATE INDEX IF NOT EXISTS business_documents_expiring
  ON business_documents (org_id, expires_on)
  WHERE deleted_at IS NULL AND superseded_at IS NULL AND expires_on IS NOT NULL;
CREATE INDEX IF NOT EXISTS business_documents_owner
  ON business_documents (org_id, owner_user_id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE business_documents IS
  'Whole-business documents with an expiry, an owner and a reminder (§1). '
  'Per-employee documents live in contract_documents (0178). Reads of both are '
  'logged to document_access_log.';

ALTER TABLE business_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_documents FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON business_documents
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE ON business_documents TO aura_app;
-- DELETE is revoked, not merely un-granted. 0001's
-- `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE` hands
-- every new public table all four verbs, so the GRANT above narrows nothing on
-- its own - the lesson 0176 records at length. The vault soft-deletes; a bug
-- that could hard-delete a signed deed is not a bug anybody recovers from.
REVOKE DELETE ON business_documents FROM aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON business_documents FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON business_documents FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER business_documents_set_updated_at
    BEFORE UPDATE ON business_documents
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- The partner wall
--
-- Three new tables carrying `org_id`, so three new holes in the channel-partner
-- boundary until this runs. 0176's header has the full argument; the short
-- version is that `org_isolation` keys on `app.org_id` alone, a partner
-- principal sets it to read their own three tables, and a RESTRICTIVE
-- `partner_wall` is what keeps them out of everything else. `verify-rls.js`
-- fails the build without it.
------------------------------------------------------------------------------

DO $do$
DECLARE
  t text;
  vault_tables text[] := ARRAY[
    'org_compliance_profile', 'document_categories', 'business_documents'
  ];
BEGIN
  FOREACH t IN ARRAY vault_tables LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;

  -- Non-vacuity. A renamed table would make the loop wall nothing and succeed
  -- silently, leaving the portal reading the vault.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname = 'partner_wall'
         AND tablename = ANY(vault_tables)) <> array_length(vault_tables, 1) THEN
    RAISE EXCEPTION '0180: only % of % vault tables are walled - refusing to leave the portal open',
      (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'partner_wall'
          AND tablename = ANY(vault_tables)),
      array_length(vault_tables, 1);
  END IF;
END $do$;

------------------------------------------------------------------------------
-- Prove the soft-delete is real
--
-- Asserted from `information_schema`, which is the only place that knows what
-- the role can actually do. An EXCEPTION rather than a NOTICE: if `aura_app`
-- can DELETE from the vault then the soft-delete is a convention, and a
-- convention is not what anybody wants between a bug and their lease deed.
------------------------------------------------------------------------------

DO $do$
DECLARE can_delete boolean;
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
    SELECT EXISTS (
      SELECT 1 FROM information_schema.table_privileges
       WHERE grantee = 'aura_app'
         AND table_schema = 'public'
         AND table_name = 'business_documents'
         AND privilege_type = 'DELETE'
    ) INTO can_delete;
    IF can_delete THEN
      RAISE EXCEPTION '0180: aura_app can DELETE from business_documents - the soft delete is not enforced';
    END IF;
  END IF;
END $do$;
