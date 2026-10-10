-- 0181_compliance_calendar.sql
-- Build docs/indian-business-finance-documents-cycles-import §2: the compliance
-- calendar and the month-end close checklist.
--
-- ── THE DATES ARE DATA, WHICH IS THE WHOLE POINT OF THIS MIGRATION ──────────
--
-- §2 is explicit, and it is the requirement that shapes every table here:
--
--   "Treat all due dates and thresholds in this document as defaults. Dates,
--    thresholds and forms change by budget, notification and extension. Store
--    them in an editable compliance calendar table (name, frequency, due-date
--    rule, applicability, reminder offsets) and ship seed data that a CA or
--    admin can edit, rather than putting dates in code."
--
-- So `compliance_items` is the editable table, seeded from
-- `COMPLIANCE_CATALOGUE` in packages/shared/src/compliance.ts, and the API
-- generates filings from the TENANT'S rows. Nothing in the API or the worker
-- reads the shared catalogue to decide a due date; it is used once, at seed
-- time, and `compliance.test.ts` has a test that the catalogue contains no
-- section number, rule number or Act citation anywhere - because §2 also says
-- "the module must not hard-code legal references."
--
-- ── STATUS IS DERIVED, AGAIN ───────────────────────────────────────────────
--
-- §2 asks for "status (upcoming, due, filed, overdue)". Only `filed_on` and
-- `waived_at` are stored. `overdue` and `due_soon` come from
-- `complianceStatus(filing, today)`, for the reason 0180 and 0172 both give:
-- `invoices.status` has allowed `'overdue'` since migration 0060 and nothing
-- ever set it. A CHECK below keeps the derived values out of the table by
-- having no status column at all to put them in.
--
-- It creates:
--   compliance_items        the editable calendar (name, frequency, rule)
--   compliance_filings      one row per (item, period), with its due date
--   month_end_close_steps   §2's checklist, one row per (month, step)

------------------------------------------------------------------------------
-- The editable calendar
--
-- `due_rule` is jsonb holding one of the three shapes `DueRule` parses:
--
--   {"kind":"day_of_month_after","day":20,"monthsAfter":1}
--   {"kind":"days_after","days":15}
--   {"kind":"fy_month_day","monthIntoFy":2,"day":15}
--
-- jsonb and not columns, because the three shapes have disjoint fields and a
-- flattened table would be eight nullable columns with a CHECK nobody can
-- read. The zod union validates on the way in and `compliance.test.ts` parses
-- every shipped rule through it.
--
-- `day_of_month_after` also carries an optional `overrides` map keyed by the
-- period's end month, which exists for one rule that would otherwise ship
-- wrong for every tenant every year: TDS deducted in March is due on 30 April,
-- not 7 April like every other month's.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS compliance_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code          text NOT NULL,
  name          text NOT NULL,
  -- Who collects it, in the words a business uses: "GST", "Income tax",
  -- "EPFO", "MCA / ROC". Never a section number.
  authority     text NOT NULL,
  form_name     text,
  frequency     text NOT NULL CHECK (frequency IN
                  ('monthly', 'quarterly', 'half_yearly', 'yearly', 'one_time')),
  due_rule      jsonb NOT NULL,
  -- Applicability. Empty `entity_types` means "every legal form"; every tag in
  -- `tags` must be present in the org's registrations.
  entity_types  text[] NOT NULL DEFAULT '{}',
  tags          text[] NOT NULL DEFAULT '{}',
  reminder_offsets int[] NOT NULL DEFAULT '{}',
  notes         text,
  -- §2's "Verify with your CA", per item rather than as a banner people stop
  -- reading. Cleared by whoever has had the date confirmed.
  verify_with_ca boolean NOT NULL DEFAULT true,
  -- Who files it. NULL falls back to whoever holds `finance:edit`, the same
  -- way the Advisor's `finance_handler` route resolves.
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- A tenant switching an item off stops future generation. Existing filings
  -- stay, and the console offers to waive the open ones - deleting them would
  -- erase the record that a return was considered and found not to apply.
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS compliance_items_code
  ON compliance_items (org_id, code);
CREATE INDEX IF NOT EXISTS compliance_items_enabled
  ON compliance_items (org_id, frequency) WHERE enabled;

COMMENT ON TABLE compliance_items IS
  'The editable compliance calendar (§2). Seeded from COMPLIANCE_CATALOGUE and '
  'owned by the tenant thereafter - a CA edits dates here, not in code.';

ALTER TABLE compliance_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_items FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON compliance_items
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON compliance_items TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON compliance_items FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON compliance_items FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER compliance_items_set_updated_at
    BEFORE UPDATE ON compliance_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- The filings
--
-- One row per (item, period). Generated a year ahead so the calendar has
-- something to show, and regenerating is idempotent on the unique index below.
--
-- ── `due_on` IS STORED, NOT COMPUTED AT READ TIME ──────────────────────────
--
-- Unlike `status`, and for the opposite reason. A due date is a FACT ABOUT THE
-- PAST once the period has been generated: if a CA corrects the rule in
-- November, last July's filing was still due on the date everybody worked to,
-- and recomputing it from the current rule would silently rewrite history and
-- make a filed-on-time return look late. So the rule generates the date once
-- and `due_on_overridden` records that a human moved it - which happens every
-- year, because extensions are announced after the calendar is generated.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS compliance_filings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES compliance_items(id) ON DELETE CASCADE,
  -- Denormalised from the item so a filing survives being re-pointed and so
  -- the worker's candidate query needs no join to dedupe an alert.
  item_code     text NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  -- "September 2026", "Q2 FY 2026-27", "FY 2026-27". Stored because it is
  -- computed from the FY start AT GENERATION TIME, and a tenant who changes
  -- their financial year must not have last year's labels change under them.
  period_label  text NOT NULL,
  due_on        date NOT NULL,
  due_on_overridden boolean NOT NULL DEFAULT false,
  -- The only two state columns. Everything §2 calls a status is derived.
  filed_on      date,
  filed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  waived_at     timestamptz,
  waived_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  waived_reason text,
  -- What was paid with it, where anything was. `numeric` like every other
  -- money column in this platform (see 0172's header).
  amount        numeric,
  currency      text NOT NULL DEFAULT 'INR',
  -- The challan or acknowledgement. §2: "a document vault tied to each
  -- compliance item (for example, the GSTR-3B challan attached to its
  -- filing)." RESTRICT, not CASCADE: deleting the challan must not delete the
  -- record that the return was filed.
  document_id   uuid REFERENCES business_documents(id) ON DELETE RESTRICT,
  reference     text,
  assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT compliance_filings_period CHECK (period_end >= period_start),
  -- A waiver needs a reason, for the same reason §12.5 requires one to dismiss
  -- an alert: "not applicable" with no note is indistinguishable from somebody
  -- clearing a red row they did not understand.
  CONSTRAINT compliance_filings_waiver
    CHECK (waived_at IS NULL OR (waived_reason IS NOT NULL AND length(btrim(waived_reason)) > 0)),
  -- Filed and waived at once is a contradiction the console cannot render.
  -- `complianceStatus` resolves it in favour of filed, but it should not have
  -- to - a filing that was made is not a filing that did not apply.
  CONSTRAINT compliance_filings_not_both
    CHECK (filed_on IS NULL OR waived_at IS NULL)
);

-- One filing per item per period. This is what makes regeneration idempotent:
-- the generator can run every night and insert nothing.
CREATE UNIQUE INDEX IF NOT EXISTS compliance_filings_period_unique
  ON compliance_filings (org_id, item_id, period_start, period_end);
-- The calendar's own read: what is open, soonest first.
CREATE INDEX IF NOT EXISTS compliance_filings_open
  ON compliance_filings (org_id, due_on)
  WHERE filed_on IS NULL AND waived_at IS NULL;
CREATE INDEX IF NOT EXISTS compliance_filings_assignee
  ON compliance_filings (org_id, assignee_user_id, due_on)
  WHERE filed_on IS NULL AND waived_at IS NULL;

COMMENT ON TABLE compliance_filings IS
  'One row per (compliance item, period), with the due date the rule produced '
  'at generation time. upcoming/due/overdue are derived by complianceStatus; '
  'only filed_on and waived_at are stored.';

ALTER TABLE compliance_filings ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_filings FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON compliance_filings
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON compliance_filings TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON compliance_filings FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON compliance_filings FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER compliance_filings_set_updated_at
    BEFORE UPDATE ON compliance_filings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- §2's month-end close checklist
--
-- A row per (month, step) that has been TICKED. Absence is "not done", so an
-- eight-step checklist for a month nobody has touched is zero rows rather than
-- eight - which matters because the steps are defined in
-- `CLOSE_CHECKLIST` and a renamed step would otherwise leave an orphan row
-- claiming progress. `closeReadiness` counts against the catalogue, not
-- against the rows, so a stale key is ignored rather than reported as 9 of 8.
--
-- `month` is the first of the month, matching `finance_periods` (0172) exactly,
-- because the lock and the checklist are read together: §2 asks for "a
-- month-end close checklist, with period locking from the finance spec".
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS month_end_close_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  month       date NOT NULL CHECK (month = date_trunc('month', month)::date),
  step_key    text NOT NULL,
  done_at     timestamptz NOT NULL DEFAULT now(),
  done_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS month_end_close_steps_unique
  ON month_end_close_steps (org_id, month, step_key);
CREATE INDEX IF NOT EXISTS month_end_close_steps_month
  ON month_end_close_steps (org_id, month);

COMMENT ON TABLE month_end_close_steps IS
  'Ticked steps of the month-end close (§2). A row means done; absence means '
  'not done. Step keys come from CLOSE_CHECKLIST in @aura/shared.';

ALTER TABLE month_end_close_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE month_end_close_steps FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON month_end_close_steps
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- DELETE is granted here, unlike the vault: un-ticking a step is a normal
-- correction, and the checklist is working state rather than a record anybody
-- audits. The period LOCK is the auditable artefact and 0172 owns that.
GRANT SELECT, INSERT, UPDATE, DELETE ON month_end_close_steps TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON month_end_close_steps FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON month_end_close_steps FROM PUBLIC;

------------------------------------------------------------------------------
-- The partner wall - 0176's argument, three more tables
------------------------------------------------------------------------------

DO $do$
DECLARE
  t text;
  calendar_tables text[] := ARRAY[
    'compliance_items', 'compliance_filings', 'month_end_close_steps'
  ];
BEGIN
  FOREACH t IN ARRAY calendar_tables LOOP
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
         AND tablename = ANY(calendar_tables)) <> array_length(calendar_tables, 1) THEN
    RAISE EXCEPTION '0181: only % of % calendar tables are walled - refusing to leave the portal open',
      (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'partner_wall'
          AND tablename = ANY(calendar_tables)),
      array_length(calendar_tables, 1);
  END IF;
END $do$;

------------------------------------------------------------------------------
-- Prove there is no status column to drift
--
-- The one assertion that makes "status is derived" structural rather than a
-- convention. A well-meant `ALTER TABLE ... ADD COLUMN status` later would
-- recreate `invoices.status` exactly: a column the console filters on that
-- nothing ever sets.
------------------------------------------------------------------------------

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'compliance_filings'
       AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION
      '0181: compliance_filings has a status column - upcoming/due/overdue are derived by complianceStatus, not stored';
  END IF;
END $do$;
