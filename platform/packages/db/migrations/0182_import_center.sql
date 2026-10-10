-- 0182_import_center.sql
-- Build docs/indian-business-finance-documents-cycles-import §3: staging,
-- dry run, saved mappings, and an undo.
--
-- ── IT EXTENDS 0062 RATHER THAN BUILDING A SECOND IMPORTER ──────────────────
--
-- §4 of the document asks for ONE import centre: "Org chart spec: employee and
-- contract imports plug into the same import center. KPI section: call logs
-- and lead lists come in through the same import flow." A finance-only
-- importer under /owner/finance would be the opposite of that, and the two
-- would drift immediately - the existing one already has a mapping step,
-- header-alias guessing, a downloadable template, a row-error report and a
-- 5,000-row cap, all driven off `IMPORT_FIELDS`.
--
-- So `import_jobs` (0062) grows the columns §3 needs, `ImportEntity` grows
-- three finance members, and two new tables carry staging and saved mappings.
--
-- ── THE CHECK IS RESTATED LITERALLY, NOT WIDENED DYNAMICALLY ────────────────
--
-- `import_jobs.entity` has `CHECK (entity IN ('contact','account','deal'))`.
-- It is replaced below with the full six-value list written out in full, NOT
-- with a dynamic `ADD VALUE`-style rewrite, and that is a deliberate repeat of
-- the lesson migration 0179 records about `notifications.kind`:
--
--   0176 widened that CHECK dynamically. A parallel session's 0177 then did
--   DROP + ADD with an explicit list written before 0176 existed, and silently
--   removed two kinds. The first symptom would have been a 23514 in
--   production.
--
-- A literal list is also what lets `import.test.ts` read this file and pin the
-- zod enum against it. A dynamically-built CHECK leaves that guard comparing
-- against something it cannot parse, which is worse than no guard.

------------------------------------------------------------------------------
-- 0062's job table, widened
------------------------------------------------------------------------------

ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_entity_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_entity_check
  CHECK (entity IN ('contact', 'account', 'deal', 'payment', 'expense', 'bank_txn'));

-- `status` gains the two states a dry run and an undo need. Restated in full
-- for the same reason as `entity`.
ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_status_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_status_check
  CHECK (status IN ('staged', 'running', 'done', 'failed', 'rolled_back'));

ALTER TABLE import_jobs
  -- What the person uploaded. Kept for the history page, which is useless if
  -- every row reads "contact import" with no way to tell three apart.
  ADD COLUMN IF NOT EXISTS file_name   text,
  ADD COLUMN IF NOT EXISTS sheet_name  text,
  -- Which row the headers were read from, and whether a person chose it. A
  -- re-import of the same bank's statement next month wants the same answer.
  ADD COLUMN IF NOT EXISTS header_row  int,
  -- §3 step 4's "saved mapping templates per source".
  ADD COLUMN IF NOT EXISTS source      text,
  ADD COLUMN IF NOT EXISTS template_id uuid,
  -- §3 step 7: create only / update existing / upsert.
  ADD COLUMN IF NOT EXISTS mode        text NOT NULL DEFAULT 'create',
  -- The resolved date order (`dmy`, `mdy`, `iso`). Stored because it is the
  -- single most consequential decision in a finance import: a file read as
  -- mm/dd moves every payment by up to eleven months, and when somebody
  -- queries it six weeks later the only way to answer is to know what was
  -- chosen.
  ADD COLUMN IF NOT EXISTS date_order  text,
  ADD COLUMN IF NOT EXISTS duplicate_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rolled_back_at timestamptz,
  ADD COLUMN IF NOT EXISTS rolled_back_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;

ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_mode_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_mode_check
  CHECK (mode IN ('create', 'update', 'upsert'));

ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_date_order_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_date_order_check
  CHECK (date_order IS NULL OR date_order IN ('iso', 'dmy', 'mdy'));
-- `ambiguous` and `conflict` are absent on purpose. They are detector verdicts,
-- not decisions - a job may not be committed while the order is unresolved, so
-- there is no legal row that could carry one.

------------------------------------------------------------------------------
-- Saved mappings - §3 step 4
--
-- "After the first import, a saved template makes later imports one click."
--
-- Keyed by (org, entity, name) rather than by source, because one tenant may
-- bank with three banks and each statement is a different shape. `source` is
-- stored as a hint so `detectSource` can offer the right one first.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS import_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  entity      text NOT NULL CHECK (entity IN
                ('contact', 'account', 'deal', 'payment', 'expense', 'bank_txn')),
  source      text,
  -- target field -> source header, exactly the shape `mapRow` consumes.
  mapping     jsonb NOT NULL DEFAULT '{}'::jsonb,
  header_row  int,
  date_order  text CHECK (date_order IS NULL OR date_order IN ('iso', 'dmy', 'mdy')),
  -- §3 step 5's "handle unknown columns dynamically": the headers a person
  -- chose to IGNORE. Stored so the next import of the same file does not ask
  -- again about the same six columns.
  ignored_headers text[] NOT NULL DEFAULT '{}',
  times_used  int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS import_templates_name
  ON import_templates (org_id, entity, lower(name));
CREATE INDEX IF NOT EXISTS import_templates_entity
  ON import_templates (org_id, entity, last_used_at DESC NULLS LAST);

ALTER TABLE import_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_templates FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON import_templates
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON import_templates TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON import_templates FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON import_templates FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER import_templates_set_updated_at
    BEFORE UPDATE ON import_templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Added after the table exists, so the FK can point at it.
ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_template_fk;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_template_fk
  FOREIGN KEY (template_id) REFERENCES import_templates(id) ON DELETE SET NULL;

------------------------------------------------------------------------------
-- Staging - §3's first key design point
--
-- "Staging first: parse into a staging table, validate there, and only then
-- write to real tables."
--
-- ── AND IT IS WHAT MAKES THE UNDO POSSIBLE ─────────────────────────────────
--
-- §3 step 11: "every import is a batch with an ID, so the whole batch can be
-- rolled back (subject to period locks)." That needs a record of WHAT EACH ROW
-- DID, which is `target_table` + `target_id` below. Without it an undo would
-- have to re-derive the rows from the file, and anything edited in between
-- would be destroyed by the re-derivation.
--
-- `row_key` is the natural key `rowFingerprint` produces - a readable string
-- like `payment|reference|axis0098122`, not a hash. The header of that
-- function gives the reasoning: a hash collision silently skips a real row,
-- and when somebody asks why a row was skipped as a duplicate, a key answers
-- it and an MD5 does not.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS import_staging_rows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id      uuid NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  -- 1-based line number IN THE FILE, not in the staged set. §3 step 10 wants a
  -- "downloadable error file with row numbers and reasons, so the user can fix
  -- and re-upload only failed rows" - and a number that counts staged rows
  -- points at the wrong line of their spreadsheet the moment one blank row is
  -- skipped.
  source_row_number int NOT NULL,
  raw         jsonb NOT NULL,
  -- The row after mapping, type coercion and amount/date parsing. Null when
  -- validation failed before normalization could finish.
  normalized  jsonb,
  row_key     text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN
                ('pending', 'valid', 'duplicate', 'error', 'imported', 'updated', 'skipped')),
  error       text,
  -- Which real record this row became. Populated on commit, read on rollback.
  target_table text,
  target_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS import_staging_rows_job
  ON import_staging_rows (job_id, source_row_number);
CREATE INDEX IF NOT EXISTS import_staging_rows_status
  ON import_staging_rows (job_id, status);
-- The rollback's own read: everything this job actually wrote.
CREATE INDEX IF NOT EXISTS import_staging_rows_targets
  ON import_staging_rows (job_id, target_table)
  WHERE target_id IS NOT NULL;
-- §3's idempotency: the same key may not be staged twice inside one job, which
-- is in-file duplicate detection enforced by the database rather than only in
-- the detector. Partial, because a row with no natural key cannot be
-- de-duplicated at all and several of those are legitimate.
CREATE UNIQUE INDEX IF NOT EXISTS import_staging_rows_key_unique
  ON import_staging_rows (job_id, row_key) WHERE row_key IS NOT NULL;

COMMENT ON TABLE import_staging_rows IS
  'Parsed and validated rows awaiting commit (§3). target_table/target_id '
  'record what each row became, which is what makes the batch undo possible.';

ALTER TABLE import_staging_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_staging_rows FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON import_staging_rows
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- DELETE is granted: staging is scratch space and a job's rows are cleared
-- when it is discarded. The AUDIT of what happened lives on `import_jobs`
-- and in `audit_log`, neither of which this can touch.
GRANT SELECT, INSERT, UPDATE, DELETE ON import_staging_rows TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON import_staging_rows FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON import_staging_rows FROM PUBLIC;

------------------------------------------------------------------------------
-- One column on 0175's expenses
--
-- §3's idempotency rule - "use a natural key (invoice number, bank reference),
-- so re-importing the same file doesn't duplicate data" - has nowhere to put
-- an expense's bill number today. Without it the only available key is
-- (date, amount, vendor, category), which collides on exactly the rows a
-- business has many of: four ₹2,360 telecom bills in one month.
--
-- §1 lists "Vendor bills and purchase orders" and "Expense vouchers" as
-- documents a business keeps, so the number is worth a column regardless of
-- the import.
------------------------------------------------------------------------------

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS bill_number text;

-- Not UNIQUE. A vendor can legitimately re-use a number across years, and two
-- tenants obviously can. De-duplication happens against the staged row's
-- natural key, where a near-match is reported to a person rather than
-- enforced by a constraint that would reject a legitimate row at commit time.
CREATE INDEX IF NOT EXISTS expenses_bill_number
  ON expenses (org_id, lower(vendor), bill_number)
  WHERE bill_number IS NOT NULL;

------------------------------------------------------------------------------
-- Bank statement lines
--
-- ── A STATEMENT LINE IS NOT A PAYMENT, AND MUST NOT BECOME ONE ─────────────
--
-- This is the table a `bank_txn` import writes to, and the reason it exists
-- rather than mapping statement rows onto `finance_payments`:
--
-- A payment is what the BUSINESS believes it collected. A statement line is
-- what the BANK says happened. §2 lists "bank statements and bank
-- reconciliation statements" as separate documents because reconciliation is
-- the act of comparing the two, and you cannot compare two things that are
-- rows in the same table. Importing statement lines as payments would also
-- double every collection that arrived through a gateway - once from the
-- webhook, once from the bank - and the dashboard would report twice the
-- revenue with no way to tell which half was real.
--
-- So these rows are evidence. `matched_payment_id` is the reconciliation, and
-- an unmatched credit line is the signal worth acting on: money arrived that
-- the business has not recorded.
--
-- `amount` is SIGNED - negative for a withdrawal. One column rather than
-- separate debit/credit columns, because every bank formats that pair
-- differently (two columns, one signed column, one column plus a Dr/Cr
-- marker) and `parseAmountCell` already normalises all three on the way in.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bank_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Which import brought it in. SET NULL rather than CASCADE: deleting an
  -- import's history must not delete the bank's record of what happened.
  import_job_id uuid REFERENCES import_jobs(id) ON DELETE SET NULL,
  value_date    date NOT NULL,
  narration     text NOT NULL,
  amount        numeric NOT NULL,
  currency      text NOT NULL DEFAULT 'INR',
  reference     text,
  balance       numeric,
  -- The reconciliation. NULL means "not yet matched to anything we recorded".
  matched_payment_id uuid REFERENCES finance_payments(id) ON DELETE SET NULL,
  matched_at    timestamptz,
  matched_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Set when a person decides a line needs no match - bank charges, an
  -- internal transfer, interest. Distinct from matched: "accounted for" and
  -- "matched to a payment" are different facts and the reconciliation report
  -- needs both.
  ignored_at    timestamptz,
  ignored_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bank_transactions_ignored_reason
    CHECK (ignored_at IS NULL OR (ignored_reason IS NOT NULL AND length(btrim(ignored_reason)) > 0))
);

CREATE INDEX IF NOT EXISTS bank_transactions_date
  ON bank_transactions (org_id, value_date DESC);
-- The reconciliation's own read: credits nobody has accounted for.
CREATE INDEX IF NOT EXISTS bank_transactions_unreconciled
  ON bank_transactions (org_id, value_date)
  WHERE matched_payment_id IS NULL AND ignored_at IS NULL;
-- §3's idempotency for this entity: the same line of the same statement must
-- not land twice when somebody re-uploads an overlapping date range, which is
-- what people actually do. (date, amount, reference, narration) is the line's
-- identity; `md5` keeps the index narrow enough for a btree whatever length
-- the narration is.
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_identity
  ON bank_transactions (org_id, value_date, amount, md5(COALESCE(reference, '') || '|' || narration));

COMMENT ON TABLE bank_transactions IS
  'Imported bank statement lines - the BANK''s record, kept separate from '
  'finance_payments (what the business recorded) so the two can be reconciled. '
  'amount is signed; negative is a withdrawal.';

ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON bank_transactions
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- DELETE is granted: §3 step 11's undo has to be able to remove the lines a
-- batch created, and a statement line carries no accounting consequence of its
-- own - nothing is posted to the ledger from this table. The LEDGER is the
-- append-only surface, and 0176 enforces that.
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_transactions TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON bank_transactions FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON bank_transactions FROM PUBLIC;

------------------------------------------------------------------------------
-- The partner wall
--
-- `import_jobs` and `import_job_errors` were walled by 0163. The three new
-- tables are not, so they are walled here. 0176's header has the argument.
------------------------------------------------------------------------------

DO $do$
DECLARE
  t text;
  import_tables text[] := ARRAY['import_templates', 'import_staging_rows', 'bank_transactions'];
BEGIN
  FOREACH t IN ARRAY import_tables LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname = 'partner_wall'
         AND tablename = ANY(import_tables)) <> array_length(import_tables, 1) THEN
    RAISE EXCEPTION '0182: only % of % import tables are walled - refusing to leave the portal open',
      (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'partner_wall'
          AND tablename = ANY(import_tables)),
      array_length(import_tables, 1);
  END IF;
END $do$;

------------------------------------------------------------------------------
-- Prove the widened CHECK admits exactly the six entities
--
-- Not a style check. An `entity` CHECK that silently lost `payment` would make
-- every finance import fail with a 23514 at commit time, after the person had
-- mapped their columns and read a dry run that said it would work. Asserted by
-- trying all six against the constraint rather than by reading its text,
-- because the text can be reformatted and the behaviour cannot.
------------------------------------------------------------------------------

DO $do$
DECLARE
  e text;
  allowed text[] := ARRAY['contact', 'account', 'deal', 'payment', 'expense', 'bank_txn'];
  probe_org uuid;
BEGIN
  -- A savepoint-per-probe insert, rolled back. Needs one real org to satisfy
  -- the FK; on an empty database there is nothing to prove and nothing to
  -- break, so the check is skipped rather than failed.
  SELECT id INTO probe_org FROM organizations LIMIT 1;
  IF probe_org IS NULL THEN
    RAISE NOTICE '0182: no organizations yet, skipping the entity CHECK probe';
    RETURN;
  END IF;

  FOREACH e IN ARRAY allowed LOOP
    BEGIN
      INSERT INTO import_jobs (org_id, entity, status) VALUES (probe_org, e, 'staged');
      -- Undo it immediately; this is a probe, not a seed.
      DELETE FROM import_jobs
       WHERE org_id = probe_org AND entity = e AND status = 'staged' AND total_rows = 0;
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION '0182: import_jobs rejects entity %, so that import can never be committed', e;
    END;
  END LOOP;
END $do$;
