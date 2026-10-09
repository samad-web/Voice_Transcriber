-- 0176_finance_advisor_snapshots.sql
-- Build docs/finance-section-build-plan, M6/M8/M9: rollups, the Advisor, forecasts.
--
-- ── NOTHING IN HERE CALLS A LANGUAGE MODEL ──────────────────────────────────
--
-- §12 is a MUST: "rules and statistics decide; language only explains. No LLM
-- call may create, suppress or re-rank an alert." The structural guarantee is
-- that the deciding code - `packages/shared/src/finance-stats.ts` and the
-- detectors in the worker - is pure and takes no client, and that
-- `advisor_alerts.explain` is written by the detector that fired. There is no
-- `ai_outputs` row, no prompt and no model name anywhere under finance.
--
-- ── AND NOTHING IN HERE SENDS TO A CUSTOMER ─────────────────────────────────
--
-- §12.5: "notify-only by default. It must not message customers or move money
-- unless the owner enables a specific action." There is no outbox table here
-- and no column that could hold a customer's number. An alert produces an
-- in-app notification and a task for a member of STAFF, through the existing
-- `notifications` and `tasks` tables - which is the same rule the follow-up
-- ladder, the outreach sweep and the document-date sweep all hold to.

-- ── §11/§9 the nightly rollup ──────────────────────────────────────────────
--
-- ── WHY EVERY FIELD IS ADDITIVE EXCEPT TWO, AND WHY THAT MATTERS ───────────
--
-- One row per (date, scope, scope_id) answers "this month", "last quarter" and
-- "year to date" by summing - which is what keeps §13's "dashboards load from
-- snapshots, not raw scans" affordable. A non-additive field here (an average,
-- a rate) would silently produce the mean of means when a caller summed a week,
-- so the rates are computed from the summed totals by `finance-metrics.ts` and
-- are deliberately absent from this table.
--
-- `outstanding` and the five aging columns are the exception: they are
-- BALANCES as at the end of that day. `sumTotals()` takes the LAST row's value
-- for them rather than adding, because summing thirty days of receivables
-- would show a dashboard ₹3 crore of dues against ₹10 lakh of real ones.
CREATE TABLE IF NOT EXISTS finance_snapshots (
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  snapshot_date  date NOT NULL,
  scope          text NOT NULL CHECK (scope IN ('org', 'user', 'campaign', 'source', 'template')),
  -- NULL for scope 'org'. Not a foreign key, deliberately: it points at five
  -- different tables depending on `scope`, and five nullable FK columns to
  -- express one relationship is how a rollup table becomes unreadable. The
  -- builder only ever writes ids it just read.
  scope_id       uuid,

  booked         numeric NOT NULL DEFAULT 0,
  billed         numeric NOT NULL DEFAULT 0,
  collected      numeric NOT NULL DEFAULT 0,
  refunded       numeric NOT NULL DEFAULT 0,
  disputed       numeric NOT NULL DEFAULT 0,
  fees           numeric NOT NULL DEFAULT 0,
  costs          numeric NOT NULL DEFAULT 0,
  incentive      numeric NOT NULL DEFAULT 0,

  outstanding    numeric NOT NULL DEFAULT 0,
  aging_current  numeric NOT NULL DEFAULT 0,
  aging_0_30     numeric NOT NULL DEFAULT 0,
  aging_31_60    numeric NOT NULL DEFAULT 0,
  aging_61_90    numeric NOT NULL DEFAULT 0,
  aging_90_plus  numeric NOT NULL DEFAULT 0,

  deals_closed   int NOT NULL DEFAULT 0,
  new_customers  int NOT NULL DEFAULT 0,
  -- The per-payment collection delays that make up this day, so a period's
  -- median and p90 (§11) are computed over the PERIOD's payments rather than
  -- as an average of daily medians - which is a different and wrong number.
  days_to_collect int[] NOT NULL DEFAULT '{}',

  -- §11's freshness stamp: when this row was built.
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, snapshot_date, scope, scope_id)
);

-- A NULL `scope_id` in a primary key is not allowed, so scope 'org' needs a
-- value. The all-zeros uuid is used as the sentinel and the builder is the only
-- writer - stated here because a reader finding 00000000-… in a column that
-- looks like a foreign key deserves to know it is not one.
COMMENT ON COLUMN finance_snapshots.scope_id IS
  'The user/campaign/source/template this row is about. '
  '00000000-0000-0000-0000-000000000000 for scope = ''org'' - a primary key '
  'cannot hold NULL, so the sentinel stands in. Not a foreign key.';

CREATE INDEX IF NOT EXISTS finance_snapshots_org_date
  ON finance_snapshots (org_id, snapshot_date DESC, scope);

ALTER TABLE finance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_snapshots FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON finance_snapshots
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- DELETE is granted: a snapshot is a CACHE (DECISIONS.md §4), and the honest
-- repair for a wrong one is to drop the day and rebuild it from the ledger.
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_snapshots TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON finance_snapshots FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON finance_snapshots FROM PUBLIC;

-- ── §12.4 the rules, per org ───────────────────────────────────────────────
--
-- A row per (org, rule). The CATALOGUE lives in
-- `packages/shared/src/finance-advisor.ts` - label, template, routing,
-- defaults - and this table holds only what an owner CHANGED. Keeping the
-- catalogue in code and the overrides in data is what lets a rule's wording
-- improve in a deploy without a migration, while an owner's tuned threshold
-- survives it.
CREATE TABLE IF NOT EXISTS advisor_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code          text NOT NULL,
  -- NULL means "use the catalogue's". Merged, not replaced, so a rule that
  -- grows a second param next quarter does not read it as 0 for every org
  -- that tuned the first one.
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity      text CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
  route_to_role text CHECK (route_to_role IS NULL OR route_to_role IN
                  ('telecaller', 'manager', 'owner', 'finance_handler')),
  enabled       boolean NOT NULL DEFAULT true,
  -- §12.5's snooze. A whole RULE silenced until a date - distinct from
  -- snoozing one alert, which lives on the alert.
  snooze_until  timestamptz,
  -- How many of this rule's alerts have been dismissed with no action. Drives
  -- §12.5's threshold SUGGESTION, which an owner approves - nothing may apply
  -- one automatically.
  dismiss_count int NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS advisor_rules_unique ON advisor_rules (org_id, code);

ALTER TABLE advisor_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE advisor_rules FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON advisor_rules
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON advisor_rules TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON advisor_rules FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON advisor_rules FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER advisor_rules_set_updated_at BEFORE UPDATE ON advisor_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §12.4/§12.5 the alerts ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS advisor_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_code       text NOT NULL,
  -- What the alert is ABOUT: a schedule item, a payment, an expense, a
  -- connector, a source, a person. A (type, id) pair rather than six nullable
  -- FKs, for the same reason `finance_snapshots.scope_id` is not one - and the
  -- dedupe key depends on it being a single value.
  subject_type    text NOT NULL,
  subject_ref     text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  -- NULL for the rules that have no amount (`connector_unhealthy`). Used by
  -- §12.6's leak report to rank, so a NULL sorts last rather than as zero.
  amount_at_risk  numeric,
  currency        text NOT NULL DEFAULT 'INR',
  -- The person who owes the work. Resolved from the rule's `route_to_role` at
  -- detection time - for dues, the deal's own telecaller (§12.5: "the person
  -- closest to the money").
  assignee_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Which role it is currently sitting with, so an escalation is visible even
  -- when the target role has several people in it.
  assigned_role   text,
  due_at          timestamptz,
  -- §12.5's ladder. `escalated_to` is the role it last climbed to, so the
  -- sweep does not re-escalate to the same place every tick.
  escalated_at    timestamptz,
  escalated_to    text,
  -- §12.5: "dismissed (reason required)".
  resolved_reason text,
  -- §12.6's explain panel, written by the detector that fired. STORED and not
  -- recomputed: an alert raised when a category's median was 40,000 must still
  -- explain itself next month when the median is 60,000, or the panel
  -- eventually contradicts the alert it belongs to.
  explain         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The rendered message. Also stored, for the same reason.
  message         text NOT NULL DEFAULT '',
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  -- §12.5's per-alert snooze, as distinct from the rule-wide one.
  snooze_until    timestamptz,
  -- How many times this alert has been dismissed and come back. Feeds the
  -- rule's `dismiss_count`, and is what `shouldReopen` consults.
  dismiss_count   int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── §12.5's de-duplication: ONE OPEN ALERT PER RULE + SUBJECT ──────────────
--
-- Partial, over the two LIVE statuses only. That is the whole design:
--
--   * Without the partial clause, a resolved alert would block the same
--     problem from being raised again next month - so a customer who slips a
--     second promise would never be chased.
--   * Without the index at all, an hourly detector would insert a new row
--     every hour and the inbox would be unusable by lunchtime. This is the
--     thing that makes "nothing changed, so say nothing" the default.
--
-- The detectors therefore INSERT … ON CONFLICT DO UPDATE SET last_seen_at,
-- which is how a still-true condition refreshes rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS advisor_alerts_dedupe
  ON advisor_alerts (org_id, rule_code, subject_ref)
  WHERE status IN ('open', 'acknowledged');

-- §9's required index.
CREATE INDEX IF NOT EXISTS advisor_alerts_org_status_assignee
  ON advisor_alerts (org_id, status, assignee_id);
-- The escalation sweep: open, unacknowledged, oldest first.
CREATE INDEX IF NOT EXISTS advisor_alerts_escalation
  ON advisor_alerts (org_id, first_seen_at)
  WHERE status = 'open';
-- The leak report.
CREATE INDEX IF NOT EXISTS advisor_alerts_leaks
  ON advisor_alerts (org_id, amount_at_risk DESC)
  WHERE status IN ('open', 'acknowledged');

ALTER TABLE advisor_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE advisor_alerts FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON advisor_alerts
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE ON advisor_alerts TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON advisor_alerts FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON advisor_alerts FROM PUBLIC;
-- An alert is resolved or dismissed, never deleted: §12.5's lifecycle is the
-- audit trail of what the business was told and when.
REVOKE DELETE ON advisor_alerts FROM aura_app;
DO $$ BEGIN
  CREATE TRIGGER advisor_alerts_set_updated_at BEFORE UPDATE ON advisor_alerts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §12.5 the audit trail of an alert's life ───────────────────────────────
--
-- §12.5: "record each step in alert_event". Append-only for the same reason
-- the ledger is: this is the evidence that an escalation happened, and an
-- evidence table that can be rewritten is not evidence.
CREATE TABLE IF NOT EXISTS alert_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alert_id   uuid NOT NULL REFERENCES advisor_alerts(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN
               ('opened', 'ack', 'escalated', 'resolved', 'reopened',
                'dismissed', 'snoozed', 'notified')),
  -- NULL for a step the system took (`opened`, `escalated`, `notified`).
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Where it went, for `escalated`/`notified`.
  target_role text,
  note       text,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_events_alert ON alert_events (alert_id, at);

ALTER TABLE alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_events FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON alert_events
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT ON alert_events TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON alert_events FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON alert_events FROM PUBLIC;
-- Append-only for the reason the ledger is: this is the EVIDENCE that an
-- escalation happened, and evidence that can be rewritten is not evidence.
REVOKE UPDATE, DELETE ON alert_events FROM aura_app;

-- ── §12.5's reminder ladder, as a ledger of what was sent ──────────────────
--
-- T-3 / T0 / T+3 / T+7 per schedule item (§15). One row per rung ACTUALLY
-- raised, which is what `dueRemindersOwing()` reads.
--
-- A ledger rather than a schedule table, deliberately: a worker that was down
-- for two days then catches up on every rung it missed in one tick, instead of
-- skipping them because their scheduled instant has passed. The same reasoning
-- `call-reminders.ts` records for booking reminders - except that one DOES
-- pre-schedule, because a booking reminder is useless after the call, while a
-- collections nudge is not.
CREATE TABLE IF NOT EXISTS due_reminders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  schedule_item_id uuid NOT NULL REFERENCES payment_schedules(id) ON DELETE CASCADE,
  -- Days relative to the due date. Negative is before.
  offset_days      int NOT NULL,
  -- The task this created for the collector. §12.5: each reminder "creates a
  -- task for the collector" - it does not message the customer.
  task_id          uuid REFERENCES tasks(id) ON DELETE SET NULL,
  raised_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS due_reminders_unique
  ON due_reminders (schedule_item_id, offset_days);

ALTER TABLE due_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE due_reminders FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON due_reminders
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT ON due_reminders TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON due_reminders FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON due_reminders FROM PUBLIC;
-- The ledger of which rungs were raised. Deleting one would re-raise it, and
-- editing one would make the ladder un-auditable.
REVOKE UPDATE, DELETE ON due_reminders FROM aura_app;

-- ── §12.2 forecast runs ────────────────────────────────────────────────────
--
-- `inputs_hash` is §12.2's own requirement and it earns its place: a forecast
-- is expensive to compute and is read by a dashboard on every load, so the run
-- is reused whenever the inputs have not moved. It is also the honest answer to
-- "why did the forecast change?" - a different hash means different inputs, and
-- the same hash with a different output means a code change.
CREATE TABLE IF NOT EXISTS forecast_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  horizon_days  int NOT NULL CHECK (horizon_days > 0 AND horizon_days <= 365),
  generated_at  timestamptz NOT NULL DEFAULT now(),
  inputs_hash   text NOT NULL,
  -- The three scenarios, the assumptions table and the trough. One JSONB
  -- rather than a row per day: it is written once, read whole, and never
  -- queried INTO - and 90 days x 3 scenarios as rows would be 270 rows per run
  -- that nothing would ever filter.
  output        jsonb NOT NULL,
  -- §12.2: "label the forecast low confidence" when history is thin. A column
  -- rather than a field inside `output`, because the console's badge and the
  -- `cash_runway_low` detector both read it and neither should have to parse
  -- the payload to find out.
  low_confidence boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS forecast_runs_org
  ON forecast_runs (org_id, horizon_days, generated_at DESC);
-- The reuse lookup.
CREATE INDEX IF NOT EXISTS forecast_runs_hash
  ON forecast_runs (org_id, inputs_hash);

ALTER TABLE forecast_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE forecast_runs FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON forecast_runs
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, DELETE ON forecast_runs TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON forecast_runs FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON forecast_runs FROM PUBLIC;
-- A run is immutable - that is what `inputs_hash` is for. Stale runs are
-- deleted wholesale, never edited.
REVOKE UPDATE ON forecast_runs FROM aura_app;

-- ── §12.5's threshold suggestions, awaiting approval ───────────────────────
--
-- "Dismissal reasons feed SUGGESTED threshold changes. The owner approves;
-- thresholds are never changed silently."
--
-- A table, because that sentence requires a thing that exists and is not yet
-- applied. The worker inserts; only an owner's PATCH moves `advisor_rules.params`.
CREATE TABLE IF NOT EXISTS advisor_suggestions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_code   text NOT NULL,
  param       text NOT NULL,
  from_value  numeric NOT NULL,
  to_value    numeric NOT NULL,
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One pending suggestion per rule+param, so the sweep refreshes rather than
-- piling up a suggestion a week.
CREATE UNIQUE INDEX IF NOT EXISTS advisor_suggestions_pending
  ON advisor_suggestions (org_id, rule_code, param) WHERE status = 'pending';

ALTER TABLE advisor_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE advisor_suggestions FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON advisor_suggestions
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE ON advisor_suggestions TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON advisor_suggestions FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON advisor_suggestions FROM PUBLIC;
-- Decided, not deleted: a declined suggestion is the record of an owner
-- having been asked and said no, which is what stops it being re-proposed.
REVOKE DELETE ON advisor_suggestions FROM aura_app;

-- ── §12.4's notification kind ──────────────────────────────────────────────
--
-- ── WHY THIS BLOCK EXISTS AT ALL ───────────────────────────────────────────
--
-- `notifications.kind` has a CHECK constraint and a zod enum that have drifted
-- apart before and thrown 23514 at runtime - the failure that broke lead
-- routing once already. So the constraint is widened HERE, in the migration
-- that introduces the kind, rather than discovered when the first alert fires
-- into a notification the database refuses.
--
-- Written as a drop-and-recreate of whatever CHECK currently constrains the
-- column, with the new values appended - because the constraint's name and
-- contents have changed across migrations and hard-coding either would break
-- on the next one. Twenty-seven kinds are already in that list and this must
-- not be the migration that silently drops one.
--
-- ── THE SURGERY IS ANCHORED ON THE ARRAY, NOT ON THE PARENTHESES ───────────
--
-- `pg_get_constraintdef` normalises `IN (...)` to
-- `CHECK ((kind = ANY (ARRAY['a'::text, ...])))`, so the new values belong
-- INSIDE the `]`. Appending after the trailing `))` instead produces
-- `CHECK ((kind = ANY (...)), 'finance_alert', ...)` - a record expression, and
-- Postgres rejects it with "argument of CHECK must be type boolean, not type
-- record". That was the first version of this block, and it failed on the
-- first run rather than shipping, which is the whole reason migrations get
-- applied to a disposable database before they are committed.
--
-- The pattern matches the LAST `]` that is followed only by closing
-- parentheses, which is the end of the value list for both the bare
-- `ARRAY[...]` and the `ARRAY[...]::text[]` shapes. An unrecognised shape
-- WARNS and changes nothing: a notification kind the database refuses is a
-- broken feature, but a mangled CHECK on this table would break every
-- notification in the product.
DO $do$
DECLARE
  con_name text;
  con_def  text;
  new_def  text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid)
    INTO con_name, con_def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'notifications'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%kind%'
   LIMIT 1;

  IF con_name IS NULL THEN
    RAISE NOTICE '0176: notifications.kind has no CHECK constraint - nothing to widen';
  ELSIF con_def LIKE '%finance_alert%' THEN
    RAISE NOTICE '0176: notifications.kind already allows finance_alert';
  ELSE
    new_def := regexp_replace(
      con_def,
      '\](\s*(?:::\s*text\s*\[\s*\])?\s*\)*\s*)$',
      ', ''finance_alert''::text, ''finance_payout''::text]\1'
    );

    IF new_def = con_def THEN
      RAISE WARNING '0176: could not widen notifications.kind - unrecognised CHECK shape: %. Add ''finance_alert'' and ''finance_payout'' by hand before enabling the finance module', con_def;
    ELSE
      EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', con_name);
      EXECUTE format('ALTER TABLE notifications ADD CONSTRAINT %I %s', con_name, new_def);
      RAISE NOTICE '0176: notifications.kind widened for finance_alert / finance_payout';
    END IF;
  END IF;
END $do$;

-- ── Seed the rules for any org that already has the module ─────────────────
--
-- Rows are only needed for an OVERRIDE (the catalogue supplies every default),
-- so this seeds nothing and is deliberately not a loop over `ADVISOR_RULES`.
-- The API creates a row the first time an owner changes a rule.
--
-- Stated out loud because the absence looks like an omission next to 0172's
-- insistence on seeding grants - and the difference is that a missing
-- `advisor_rules` row means "use the default", while a missing
-- `role_permissions` row means "denied".
DO $do$
BEGIN
  RAISE NOTICE '0176: advisor_rules is intentionally empty - the catalogue in @aura/shared supplies every default, and a row here is an override';
END $do$;

-- ── THE SECOND ISOLATION AXIS: the partner wall (0163) ─────────────────────
--
-- ── WHAT THIS IS, AND WHY IT HAS TO BE IN EVERY MIGRATION THAT ADDS A TABLE ─
--
-- `PartnerScopeGuard` (doc 39 P4) is the only principal in this platform with a
-- SECOND identity axis: a channel partner authenticates as a partner, and
-- their transaction must set `app.org_id` to read their own three tables
-- (`partners`, `partner_users`, `partner_submissions`). That means
-- `org_isolation` - which keys on `app.org_id` and nothing else - admits a
-- partner principal to EVERY other tenant table in that org.
--
-- 0163 closed that by adding a RESTRICTIVE `partner_wall` to every table
-- carrying `org_id`: a policy that passes only when `app.partner_id` is unset.
-- RESTRICTIVE is load-bearing - a PERMISSIVE copy ORs with `org_isolation`,
-- admits everything it was meant to deny, and reads identically in
-- `pg_policies`.
--
-- But 0163 walled the tables that existed WHEN IT RAN. Twenty-three new ones
-- land in 0172-0176, and `verify-rls.js` fails the build until each carries the
-- wall - which is exactly how this hole was found here, on the first local run,
-- rather than in production. It is also the hole doc 39's own plan missed.
--
-- The loop is over this module's tables BY NAME, not a re-run of 0163's
-- catalogue enumeration. Naming them means a reader can see what is walled,
-- and a table added to the finance module later fails `verify-rls` loudly
-- instead of being silently swept up by a query.
DO $do$
DECLARE
  t text;
  walled int := 0;
  finance_tables text[] := ARRAY[
    -- 0172
    'finance_settings', 'deal_templates', 'payment_schedules', 'finance_periods',
    -- 0173
    'finance_payments', 'finance_refunds', 'finance_disputes', 'ledger_entries',
    'finance_settlements',
    -- 0174
    'connector_accounts', 'connector_events',
    -- 0175
    'expenses', 'cost_drivers', 'incentive_plans', 'incentive_payouts', 'incentive_lines',
    -- 0176
    'finance_snapshots', 'advisor_rules', 'advisor_alerts', 'alert_events',
    'due_reminders', 'forecast_runs', 'advisor_suggestions'
  ];
BEGIN
  FOREACH t IN ARRAY finance_tables LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
      walled := walled + 1;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
  RAISE NOTICE '0176: partner_wall added to % finance table(s)', walled;

  -- Non-vacuity, the lesson 0163's own block records: if this loop ever walls
  -- nothing because a table was renamed, it would succeed silently and leave
  -- the portal reading the whole finance module. An EXCEPTION and not a
  -- warning, for 0163's reason: there is no "fix it afterwards" for a tenant
  -- boundary that is not there.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname = 'partner_wall'
         AND tablename = ANY(finance_tables)) <> array_length(finance_tables, 1) THEN
    RAISE EXCEPTION '0176: % of % finance tables are walled - refusing to leave the portal open',
      (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public' AND policyname = 'partner_wall'
          AND tablename = ANY(finance_tables)),
      array_length(finance_tables, 1);
  END IF;
END $do$;

-- ── PROVE THE APPEND-ONLY SURFACES ARE ACTUALLY APPEND-ONLY ───────────────
--
-- Because a GRANT in this schema narrows nothing on its own. 0001's
-- `ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE` hands every
-- new public table full DML to `aura_app`, so a migration that writes
-- `GRANT SELECT, INSERT` and stops has written a comment, not a restriction.
--
-- That is exactly what 0172-0176 did in their first version. The headers said
-- "append-only, enforced by the grant", DECISIONS.md repeated it, and an UPDATE
-- followed by a DELETE on `ledger_entries` as `aura_app` both succeeded. It was
-- found by running the claim as SQL rather than reading it.
--
-- So the REVOKEs are asserted here, across all five migrations, from
-- `information_schema` - the only place that knows what the role can really do.
-- An EXCEPTION rather than a warning: §6.3 is a MUST and a ledger that can be
-- rewritten is not an audit trail, so a deploy that cannot enforce it must not
-- finish.
DO $do$
DECLARE wrong text;
BEGIN
  SELECT string_agg(format('%s:%s', v.tbl, v.priv), ', ') INTO wrong
    FROM (VALUES
            -- §6.3: never edited, never deleted.
            ('ledger_entries', 'UPDATE'), ('ledger_entries', 'DELETE'),
            ('alert_events', 'UPDATE'),   ('alert_events', 'DELETE'),
            ('due_reminders', 'UPDATE'),  ('due_reminders', 'DELETE'),
            -- Reversed, never removed.
            ('finance_payments', 'DELETE'), ('finance_refunds', 'DELETE'),
            ('finance_disputes', 'DELETE'), ('finance_settlements', 'DELETE'),
            ('expenses', 'DELETE'),         ('incentive_payouts', 'DELETE'),
            ('advisor_alerts', 'DELETE'),   ('advisor_suggestions', 'DELETE'),
            ('deal_templates', 'DELETE'),
            -- Created or removed, never edited.
            ('finance_periods', 'UPDATE'),  ('forecast_runs', 'UPDATE')
         ) AS v(tbl, priv)
   WHERE EXISTS (
     SELECT 1 FROM information_schema.role_table_grants g
      WHERE g.grantee = 'aura_app'
        AND g.table_schema = 'public'
        AND g.table_name = v.tbl
        AND g.privilege_type = v.priv
   );

  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION '0176: aura_app still holds %. A GRANT does not narrow anything here - 0001 grants full DML by default, so each of these needs an explicit REVOKE', wrong;
  END IF;
  RAISE NOTICE '0176: every finance append-only surface is append-only for aura_app';
END $do$;

-- And prove the wall is RESTRICTIVE, the same assertion 0163 makes, scoped to
-- this module's tables. A PERMISSIVE `partner_wall` is the one failure in this
-- file that would change nothing visible and remove the entire boundary.
DO $do$
DECLARE wrong text;
BEGIN
  SELECT string_agg(tablename, ', ') INTO wrong
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname = 'partner_wall'
     AND permissive <> 'RESTRICTIVE'
     AND tablename LIKE ANY (ARRAY['finance_%', 'advisor_%', 'incentive_%', 'connector_%',
                                   'deal_templates', 'payment_schedules', 'ledger_entries',
                                   'expenses', 'cost_drivers', 'alert_events',
                                   'due_reminders', 'forecast_runs']);
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION '0176: partner_wall is PERMISSIVE on %, which removes the boundary it looks like', wrong;
  END IF;
  RAISE NOTICE '0176: every finance partner_wall is RESTRICTIVE';
END $do$;
