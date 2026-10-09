------------------------------------------------------------------------------
-- 0178_org_chart_contracts.sql - employment contracts, their documents, and
-- the log of every time one was read (Build docs/org-chart-build-plan.md §4.2,
-- §6.3, §7, M7).
--
-- ── WHY THIS IS A SECOND MIGRATION AND A SECOND PERMISSION OBJECT ───────────
--
-- Everything in 0177 is floor information: §7 gives a telecaller the chart,
-- the titles, the departments, the responsibilities and the authority table,
-- because the module's reason to exist is a new joiner finding out who to ask.
--
-- Nothing in THIS file is. A contract is somebody's pay, their notice period
-- and their signed paperwork, and §7 is explicit that staff "cannot see
-- contracts, compensation, documents". M7's acceptance criterion is a negative
-- test: "a telecaller cannot retrieve any contract data (verified by API
-- tests)."
--
-- One `position` object covering both would make that criterion impossible to
-- satisfy without a second axis anyway, because a telecaller must KEEP
-- `position:view`. So the restricted half gets its own object, its own grants
-- (seeded to the three admin roles and nobody else), and its own file - so the
-- part of this module that needed a security review is reviewable on its own.
--
-- ── THE ONE THING THAT IS DIFFERENT FROM EVERY OTHER OBJECT HERE ────────────
--
-- `employment_contract` is NOT in `ALL_SCOPE_ONLY_OBJECTS`, and its
-- `OWNER_COLUMN` is `user_id`. Every other configuration-shaped object in this
-- platform is all-scope-only, so the difference is deliberate: "my own
-- contract" is the most meaningful `owned` scope in the schema. Somebody
-- reading their own notice period is reasonable, and an org that wants to
-- allow it can grant `employment_contract:view` at `owned` scope and get
-- exactly that - enforced by a WHERE clause, not by a UI.
--
-- It is NOT seeded that way. §7's default is that staff see nothing here, so
-- the migration grants nothing to `workspace_member` or `viewer`. The owner
-- column exists so that the choice, if an org makes it, is a row filter rather
-- than a checkbox that silently matches everything.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employment_contracts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Whose contract. ON DELETE CASCADE, because a data-erasure request means
  -- the contract goes with the person; the SEAT survives it (0177's note on
  -- `position_assignments.user_id` makes the same call for the same reason).
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The seat it was signed FOR. Nullable and ON DELETE SET NULL: a contract
  -- outlives a reorganization, and somebody whose position was abolished still
  -- has a contract. Losing the contract because the seat was renamed would be
  -- the wrong half to drop.
  position_id        uuid REFERENCES positions(id) ON DELETE SET NULL,
  employment_type    text NOT NULL CHECK (employment_type IN
                       ('full_time', 'part_time', 'contract', 'probation', 'intern')),
  start_date         date NOT NULL,
  end_date           date,
  renewal_date       date,
  probation_end_date date,
  notice_period_days int CHECK (notice_period_days IS NULL
                                OR (notice_period_days >= 0 AND notice_period_days <= 365)),
  comp_structure     text CHECK (comp_structure IS NULL OR comp_structure IN
                       ('fixed', 'fixed_plus_incentive', 'commission')),
  -- ── THE FIGURE, AND WHY IT IS A SEPARATE COLUMN FROM THE SHAPE ───────────
  --
  -- §6.3: "Compensation structure type (fixed, fixed plus incentive,
  -- commission); amounts only for authorized roles." Two different audiences:
  -- a manager planning a handover legitimately needs to know whether pay
  -- includes an incentive, and has no business knowing the number.
  --
  -- Two columns is what makes `redactContract`'s `terms` level possible at
  -- all - it DELETES `comp_fixed_num` and keeps `comp_structure`. One combined
  -- jsonb would have forced an all-or-nothing read.
  --
  -- `numeric`, not BIGINT paise: every money column in this schema is numeric.
  -- See 0177's header, point 2.
  comp_fixed_num     numeric CHECK (comp_fixed_num IS NULL OR comp_fixed_num >= 0),
  comp_currency      char(3),
  -- ── `expiring` IS ABSENT FROM THIS CHECK ON PURPOSE ──────────────────────
  --
  -- §4.2 lists four statuses. Three are facts somebody asserts; `expiring`
  -- is a date comparison, and a stored `expiring` is wrong the day after it is
  -- written with nothing listening for the moment it should change.
  -- `deriveContractStatus` computes it on read from `end_date` and §14's first
  -- offset, so the badge appears on exactly the day the first notification
  -- goes out. The API refuses a writer who tries to assert it
  -- (`StoredContractStatus`), and this CHECK is the backstop.
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'active', 'ended')),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employment_contracts_dates_ordered
    CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT employment_contracts_amount_has_currency
    CHECK (comp_fixed_num IS NULL OR comp_currency IS NOT NULL)
);

-- §4.2's minimum index list: the expiry sweep's own query.
CREATE INDEX IF NOT EXISTS employment_contracts_org_status_end
  ON employment_contracts (org_id, status, end_date);
CREATE INDEX IF NOT EXISTS employment_contracts_org_user
  ON employment_contracts (org_id, user_id);
CREATE INDEX IF NOT EXISTS employment_contracts_org_position
  ON employment_contracts (org_id, position_id);
-- The probation sweep. Partial, because the overwhelming majority of rows have
-- no probation date and scanning them every night is work for nothing.
CREATE INDEX IF NOT EXISTS employment_contracts_org_probation
  ON employment_contracts (org_id, probation_end_date)
  WHERE probation_end_date IS NOT NULL;

-- At most one ACTIVE contract per person. A second one is two answers to
-- "what is Priya's notice period", and the amendment model for a change is a
-- new `contract_documents` version plus a PATCH - not a second row. A draft
-- alongside it is legitimate (next year's terms, being prepared), and an
-- ended one obviously is.
CREATE UNIQUE INDEX IF NOT EXISTS employment_contracts_one_active_per_user
  ON employment_contracts (org_id, user_id)
  WHERE status = 'active';

ALTER TABLE employment_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_contracts FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON employment_contracts
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON employment_contracts TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON employment_contracts FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON employment_contracts FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER employment_contracts_set_updated_at BEFORE UPDATE ON employment_contracts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- The documents
--
-- ── NO URL IS STORED, AND THAT IS THE POINT ─────────────────────────────────
--
-- §4.2 names the column `file_url`. It is `s3_key` here, because §7 requires
-- documents to be "served through short-lived signed URLs, not public links"
-- and a column called `file_url` is an invitation to put a URL in it. A URL
-- that is safe to store is a URL that does not expire, which is a public link
-- to somebody's signed contract.
--
-- So the row holds the object KEY, and `GET /org-chart/documents/:id/url`
-- mints a signed URL per request and logs the fact. Exactly the shape
-- `recordings` and `export_job_files` already use.
--
-- ── VERSIONS ARE ROWS, NOT AN EDIT ──────────────────────────────────────────
--
-- §6.3 asks for "contract documents with version history". A new version is a
-- new row with `version + 1`; the old object stays in storage and stays
-- downloadable. Overwriting the key would make an amendment destroy the
-- document it amends - and the one time anybody needs the superseded version
-- is a dispute about what was signed.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contract_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- §4.2 omits `org_id` here. It is added for the reason 0177's header gives:
  -- verify-rls fails the build for any public table that is not org-scoped,
  -- and rightly - RLS cannot express "reachable only through a parent", so a
  -- child table without it is directly SELECTable by any session.
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id  uuid NOT NULL REFERENCES employment_contracts(id) ON DELETE CASCADE,
  doc_type     text NOT NULL CHECK (doc_type IN
                 ('offer_letter', 'contract', 'nda', 'amendment', 'other')),
  s3_key       text NOT NULL,
  file_name    text NOT NULL,
  content_type text NOT NULL,
  bytes        bigint NOT NULL CHECK (bytes > 0),
  version      int NOT NULL DEFAULT 1 CHECK (version >= 1),
  uploaded_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  signed_at    date,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contract_documents_contract
  ON contract_documents (org_id, contract_id, doc_type, version DESC);
-- One version number per (contract, type). Without this, two uploads racing
-- both read `max(version) = 2` and both write 3, and the history has two
-- version 3s and no version 4.
CREATE UNIQUE INDEX IF NOT EXISTS contract_documents_version
  ON contract_documents (org_id, contract_id, doc_type, version);

ALTER TABLE contract_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_documents FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON contract_documents
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_documents TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON contract_documents FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON contract_documents FROM PUBLIC;

------------------------------------------------------------------------------
-- Who looked at it - §7's third MUST
--
-- "Log every view and download of a contract document to
-- `document_access_log`."
--
-- VIEW and DOWNLOAD are the same event here and the column says which was
-- asked for, because with a signed URL they are indistinguishable after the
-- fact: the API mints one URL and the browser decides whether to render the
-- PDF or save it. Recording `download` only when a `?download=1` was passed
-- would under-report every actual read. So `action` records what the API was
-- asked to produce - `list`, `url`, `upload` - and the honest reading of a
-- `url` row is "this person was handed the means to read this document".
--
-- Append-only, like `org_change_log` - and achieved by a REVOKE, not by a
-- narrow GRANT. 0001_init.sql's closing `ALTER DEFAULT PRIVILEGES ... GRANT
-- SELECT, INSERT, UPDATE, DELETE ON TABLES TO aura_app` means every new table
-- arrives with all four verbs, so granting a subset narrows nothing. An access
-- log a bug can delete rows from is not an access log. See 0177's note on
-- `org_change_log` for the verification.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document_access_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- text, not a FK. The log must survive the document it records being
  -- deleted - a cascade would erase the evidence along with the evidence's
  -- subject, which is the one combination an auditor cares about.
  document_id text NOT NULL,
  contract_id text,
  actor_type  text NOT NULL CHECK (actor_type IN ('user', 'operator', 'system')),
  actor_id    text NOT NULL,
  action      text NOT NULL CHECK (action IN ('list', 'url', 'upload', 'delete')),
  ip          text,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_access_log_org_at
  ON document_access_log (org_id, at DESC);
CREATE INDEX IF NOT EXISTS document_access_log_document
  ON document_access_log (org_id, document_id, at DESC);

ALTER TABLE document_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_access_log FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON document_access_log
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT ON document_access_log TO aura_app;
REVOKE UPDATE, DELETE ON document_access_log FROM aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON document_access_log FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON document_access_log FROM PUBLIC;

------------------------------------------------------------------------------
-- Permission grants for `employment_contract`
--
-- The three admin roles and NOBODY ELSE. `workspace_member` and `viewer` get
-- no row at all, which is what makes M7's acceptance criterion true by query:
-- `CrmPermissionsGuard` denies whatever it finds no grant for, so a telecaller
-- hitting any contract route gets a 403 before the handler runs - not a
-- redacted payload, not an empty list.
--
-- §7's "HR / finance handler" is not a persona here. Adding a fourth
-- `owner_role` would be fail-open during a rolling deploy (roles.ts records
-- why: an unknown persona resolves to the MOST permissive), so the handler is
-- whoever an owner grants `employment_contract:edit` to - a grid cell, which
-- is the axis built for exactly this.
--
-- THREE ACTIONS, NOT FIVE.
--
--   no `delete` - §6.5's timeline and a dispute about what was signed both
--   depend on the row surviving. A contract is `ended`, which is an `edit`.
--   A delete cell would be a checkbox with no route behind it, which is what
--   0158 refused for `dnc` and 0165 for `resource`.
--
--   no `export` - there is no route that emits contracts in bulk, and there
--   will not be one. The directory export (§6.6) is names, titles and
--   managers, built in the browser from rows already on screen, and carries
--   nothing from this file.
------------------------------------------------------------------------------

INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'employment_contract', a.action, 'all'
  FROM roles r
 CROSS JOIN (VALUES ('view'), ('create'), ('edit')) AS a(action)
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

------------------------------------------------------------------------------
-- Prove the NEGATIVE, which is the one that matters here
--
-- 0177's closing block checks that nobody was locked OUT. This one checks the
-- opposite direction: that no non-admin system role was accidentally let in.
--
-- The seeding above is three lines and obviously correct today. The reason to
-- assert it anyway is that the next person to add a permission object will
-- copy a block from somewhere, and the block they are most likely to copy is
-- 0177's five-role `view` grant - which, applied to this object, hands every
-- telecaller in every tenant the whole company's salaries. This fails the
-- deploy loudly instead.
--
-- An EXCEPTION, not a warning, and the only one in either file. 0103's
-- argument for warning - "aborting leaves the schema half-applied to report
-- something repairable from the console" - cuts the other way when the
-- condition is an over-grant: it is repairable from the console only by
-- somebody who knows it happened, and by then it has been readable for a week.
------------------------------------------------------------------------------

DO $do$
DECLARE leaked int;
BEGIN
  SELECT count(*) INTO leaked
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE rp.object_type = 'employment_contract'
     AND r.is_system
     AND r.key IN ('workspace_member', 'viewer');

  IF leaked > 0 THEN
    RAISE EXCEPTION
      '0178: % employment_contract grant(s) reached workspace_member or viewer. §7 gives staff no contract access; remove them before deploying.',
      leaked;
  END IF;
  RAISE NOTICE '0178: employment_contract is granted to admin roles only';
END $do$;

------------------------------------------------------------------------------
-- The partner wall for this file's three tables
--
-- Same mechanism and same reason as 0177's closing block: `org_isolation`
-- answers "which tenant", not "which kind of principal", and a channel-partner
-- session carries a legitimate `app.org_id` alongside `app.partner_id`.
--
-- Of every table this module creates, these are the three where an unwalled
-- policy would matter most. A partner principal would read the tenant's staff
-- salaries, notice periods and signed paperwork - and `document_access_log`
-- would record them doing it under their own id while the wall that should
-- have stopped it did not exist.
------------------------------------------------------------------------------

DO $do$
DECLARE t text; walled int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY['employment_contracts', 'contract_documents', 'document_access_log'] LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
      walled := walled + 1;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'partner_wall'
         AND tablename = ANY (ARRAY['employment_contracts', 'contract_documents',
                                    'document_access_log'])) < 3 THEN
    RAISE EXCEPTION '0178: only % of 3 contract tables are walled - refusing to leave salaries readable from the partner portal', walled;
  END IF;
  RAISE NOTICE '0178: partner_wall present on all 3 contract tables';
END $do$;
