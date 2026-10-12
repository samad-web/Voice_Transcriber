-- 0194_insights_facts.sql - the fact tables the KPI engine reads
-- (Build docs/no-crm-api-dashboard-build-plan.md §7 and §10, M3).
--
-- Five tables, all the same shape in the three places that matter:
--
--   1. `origin` says where the row came from - 'api', 'handset' or 'import'.
--   2. `env` says whether it is real - 'live' or 'test'. The engine reads
--      live only, which is what makes a sandbox a column rather than a schema.
--   3. `day` is the row's date IN THE ORG'S OWN TIMEZONE, computed at write
--      time. Not derived on read: `(started_at AT TIME ZONE tz)::date` in a
--      WHERE clause cannot use an index, and the engine groups by day over
--      months of rows. The write path has the org's `reporting_timezone` in
--      hand already (every other sweep here passes it), so this costs nothing.
--
-- ── WHY `origin` AND NOT A VIEW OVER `calls` ────────────────────────────────
--
-- The project owner asked (2026-10-10) that an API-only tenant also be able to
-- pair handsets. Those calls already exist in `calls`, so the obvious move is a
-- view that unions them with the ingested ones.
--
-- It is the wrong move, for three reasons written down in
-- INSIGHTS_TIER_DECISIONS §5: one query plan instead of two is what makes the
-- §11 p95 target reachable; late corrections then behave identically for both
-- sources; and most importantly the PROJECTION CARRIES NOTHING PRIVACY-BEARING.
-- A handset call becomes a row with a duration, a direction and a disposition -
-- no transcript, no recording key, no counterparty number, not even the hash.
-- A tenant on `api_insights` without `call_intel` has contracted not to get
-- call content, and a view over `calls` would put every one of those columns
-- one join away from a dashboard query. The copy is the boundary.
--
-- The cost is one extra row per call. Accepted, and written here so the next
-- person does not "fix" it into a view.
--
-- ── NOT PARTITIONED, DELIBERATELY, AND HERE IS THE PLAN ─────────────────────
--
-- §10 asks for the fact tables to be partitioned by month and §11 repeats it.
-- This migration does not partition them. The reason is local to this
-- repository rather than general: `verify-rls.js` ENUMERATES every table in
-- `public` carrying an `org_id` and requires RLS enabled, FORCED and a policy
-- on each. Every monthly partition is such a table. A sweep that creates next
-- month's partition therefore creates a table that must also create two
-- policies, and the first time that sweep half-fails, the next deploy's RLS
-- check fails with it - trading a performance problem nobody has yet for a
-- deploy that stops.
--
-- The conversion is kept mechanical for when it is needed (M10): `day` is
-- already stored and already the partition key, every index below already
-- leads with `org_id`, and nothing reads a fact table by primary key alone.
-- When volume justifies it, the work is a new partitioned table, an INSERT
-- SELECT, a rename, and teaching verify-rls to recognise a partition as
-- covered by its parent. That last part is the real work and it is the part
-- that must not be done in a hurry.

------------------------------------------------------------------------------
-- Calls
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS insights_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  origin         text NOT NULL CHECK (origin IN ('api', 'handset', 'import')),
  env            text NOT NULL DEFAULT 'live' CHECK (env IN ('test', 'live')),
  -- The caller's own id, or - for a handset projection - the `calls.id` uuid as
  -- text. One column either way, so the convergence key is the same shape for
  -- both origins and the engine never branches on it.
  external_id    text NOT NULL,

  -- Nullable, because a call whose telecaller could not be matched is held in
  -- `unmapped_refs` and NOT written here: a fact with no subject cannot appear
  -- on anybody's dashboard, and writing one would make the unmapped queue a
  -- cosmetic list rather than the thing standing between bad data and a wrong
  -- number. The column is nullable only so a telecaller can be ARCHIVED later
  -- without deleting their history (ON DELETE SET NULL).
  telecaller_id  uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  -- Snapshotted at write time, not joined on read. Same argument 0017 makes
  -- for `leads.telecaller_id`: a live join through the person's current team
  -- would move last quarter's numbers when somebody changes team, which is the
  -- reassignment bug one level up.
  team_id        uuid REFERENCES teams(id) ON DELETE SET NULL,

  started_at     timestamptz NOT NULL,
  day            date NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  -- Three-valued on purpose. `true`/`false` is what the customer told us;
  -- NULL is "they did not say", which is not the same as "nobody answered".
  -- D2 of doc 41: null means not enough to say, never 0 - so a tenant that
  -- never sends `connected` gets `connect_rate` suppressed with a reason
  -- rather than a flat 0% that looks like a catastrophe.
  connected      bool,
  duration_sec   int CHECK (duration_sec IS NULL OR duration_sec >= 0),
  talk_time_sec  int CHECK (talk_time_sec IS NULL OR talk_time_sec >= 0),
  -- The customer's own vocabulary, free text. Not a FK to `call_dispositions`:
  -- that table is Aura's configured list and an API tenant has their own.
  -- `disposition_group` is where a mapping would land if one is ever needed.
  disposition    text,
  -- A pseudonymous reference to whoever was called (§6.5). The customer's own
  -- id, never a phone number - and nothing in this schema invites one.
  lead_ref       text,
  campaign       text,
  lead_source    text,
  attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- The convergence key (§6.3). Includes `origin`, so an ingested call named
  -- `call_8841` and a handset call that happens to carry the same uuid-as-text
  -- cannot overwrite each other - and an API push into the handset's own
  -- namespace is a 409 rather than a silent replacement of a recorded call.
  UNIQUE (org_id, origin, external_id)
);

-- §10's minimum, and the engine's main access path.
CREATE INDEX IF NOT EXISTS call_facts_org_tc_started
  ON insights_calls (org_id, telecaller_id, started_at DESC);
-- The daily group-by the snapshot sweep runs. `env` in the key because every
-- engine read filters it, so a test-heavy sandbox never touches live pages.
CREATE INDEX IF NOT EXISTS call_facts_org_day
  ON insights_calls (org_id, env, day, telecaller_id);
CREATE INDEX IF NOT EXISTS call_facts_org_team_day
  ON insights_calls (org_id, env, team_id, day) WHERE team_id IS NOT NULL;
-- The funnel on §8.2, which groups by the customer's own disposition.
CREATE INDEX IF NOT EXISTS call_facts_org_disposition
  ON insights_calls (org_id, env, day, disposition) WHERE disposition IS NOT NULL;

------------------------------------------------------------------------------
-- Conversions
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS insights_conversions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  origin        text NOT NULL CHECK (origin IN ('api', 'handset', 'import')),
  env           text NOT NULL DEFAULT 'live' CHECK (env IN ('test', 'live')),
  external_id   text NOT NULL,
  telecaller_id uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  team_id       uuid REFERENCES teams(id) ON DELETE SET NULL,
  lead_ref      text,
  closed_at     timestamptz NOT NULL,
  day           date NOT NULL,
  -- Minor units plus a code, never a float (§2). NULL is a conversion whose
  -- value the customer did not send - an enrollment with no price is still a
  -- conversion, and `conversion_rate` must count it.
  value_minor   bigint CHECK (value_minor IS NULL OR value_minor >= 0),
  currency      text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  product       text,
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, origin, external_id),
  -- A value with no currency cannot be totalled or displayed; a currency with
  -- no value is harmless but meaningless. Reject the first, allow neither to
  -- be half-written.
  CONSTRAINT conversion_facts_money_complete CHECK (
    value_minor IS NULL OR currency IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS conversion_facts_org_tc_closed
  ON insights_conversions (org_id, telecaller_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS conversion_facts_org_day
  ON insights_conversions (org_id, env, day, telecaller_id);
-- Attribution back to the calls that produced it - §8.3's conversion rate per
-- telecaller is a join on `lead_ref`, not on a foreign key, because the
-- customer's lead is not a record we hold.
CREATE INDEX IF NOT EXISTS conversion_facts_org_lead_ref
  ON insights_conversions (org_id, lead_ref) WHERE lead_ref IS NOT NULL;

------------------------------------------------------------------------------
-- Payments (Growth and above, §4's `revenue_summary`)
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS insights_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  origin        text NOT NULL CHECK (origin IN ('api', 'handset', 'import')),
  env           text NOT NULL DEFAULT 'live' CHECK (env IN ('test', 'live')),
  external_id   text NOT NULL,
  -- Resolved from the payload's `conversion_external_id` at write time. A
  -- payment that names a conversion we have not been sent yet still lands,
  -- with this null, and the drain re-resolves it when the conversion arrives -
  -- out-of-order data is accepted (§6.3) and this is where that promise is
  -- actually kept.
  conversion_id uuid REFERENCES insights_conversions(id) ON DELETE SET NULL,
  telecaller_id uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),
  currency      text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  received_at   timestamptz NOT NULL,
  day           date NOT NULL,
  method        text,
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, origin, external_id)
);

CREATE INDEX IF NOT EXISTS payment_facts_org_tc_received
  ON insights_payments (org_id, telecaller_id, received_at DESC);
CREATE INDEX IF NOT EXISTS payment_facts_org_day
  ON insights_payments (org_id, env, day, telecaller_id);
-- The drain's re-resolution pass: payments still waiting for their conversion.
CREATE INDEX IF NOT EXISTS payment_facts_unlinked
  ON insights_payments (org_id, created_at) WHERE conversion_id IS NULL;

------------------------------------------------------------------------------
-- Attendance
--
-- A SECOND source for the same question, and that is why this is not
-- `attendance_days` (0140). That table is the attendance MODULE's computed
-- answer - shifts, breaks, exceptions, overrides, a classifier and a dirty-day
-- queue behind it. This one is what a customer told us over the API: present
-- or absent, logged in at, logged out at. One row per person per day.
--
-- `attendance_present_days` in the KPI catalogue reads whichever exists,
-- preferring the module's when a tenant has it, because a tenant running both
-- has a classifier whose answer is better than the raw mark. The catalogue
-- entry says so.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS insights_attendance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  origin        text NOT NULL CHECK (origin IN ('api', 'handset', 'import')),
  env           text NOT NULL DEFAULT 'live' CHECK (env IN ('test', 'live')),
  telecaller_id uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,
  day           date NOT NULL,
  status        text NOT NULL CHECK (status IN ('present', 'absent', 'leave', 'holiday', 'week_off')),
  login_at      timestamptz,
  logout_at     timestamptz,
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- One mark per person per day per env. The upsert key, and the reason
  -- `POST /v1/attendance` needs no external_id: a day already identifies the
  -- row it is correcting.
  UNIQUE (org_id, telecaller_id, day, env)
);

CREATE INDEX IF NOT EXISTS attendance_marks_org_day
  ON insights_attendance (org_id, env, day, telecaller_id);

------------------------------------------------------------------------------
-- Quality reviews (§7: human-entered, never AI)
--
-- `reviewer` is free text, not a user reference: the reviewer is the
-- customer's own QA person and may have no login here. §4 puts this on Growth
-- and above, enforced by the `manual_quality_scoring` entitlement.
--
-- `score` and `max_score` together, not a percentage: a rubric out of 10 and
-- one out of 100 are both normal, and storing the ratio would lose the
-- denominator the KPI engine needs (G1 - store numerator and denominator,
-- never the rate).
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS insights_quality_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  origin           text NOT NULL CHECK (origin IN ('api', 'handset', 'import')),
  env              text NOT NULL DEFAULT 'live' CHECK (env IN ('test', 'live')),
  external_id      text NOT NULL,
  telecaller_id    uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  -- Which call was reviewed, as the customer's own id. Text and not a FK to
  -- `insights_calls`, because a review can legitimately arrive before the call it
  -- scores, and a FK would reject it.
  call_external_id text,
  reviewer         text,
  score            numeric NOT NULL CHECK (score >= 0),
  max_score        numeric NOT NULL CHECK (max_score > 0),
  rubric           jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_at      timestamptz NOT NULL,
  day              date NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, origin, external_id),
  CONSTRAINT quality_reviews_score_in_range CHECK (score <= max_score)
);

CREATE INDEX IF NOT EXISTS quality_reviews_org_day
  ON insights_quality_reviews (org_id, env, day, telecaller_id);
CREATE INDEX IF NOT EXISTS quality_reviews_org_call
  ON insights_quality_reviews (org_id, call_external_id) WHERE call_external_id IS NOT NULL;

------------------------------------------------------------------------------
-- RLS + the partner wall
------------------------------------------------------------------------------

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'insights_calls', 'insights_conversions', 'insights_payments', 'insights_attendance', 'insights_quality_reviews'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    END IF;
    BEGIN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I
           FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_set_updated_at', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $$;

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY[
      'insights_calls', 'insights_conversions', 'insights_payments', 'insights_attendance', 'insights_quality_reviews'
    ]) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
        AND policyname = 'partner_wall' AND permissive = 'RESTRICTIVE'
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0194: partner_wall missing or not RESTRICTIVE on: %', missing;
  END IF;
END $$;

------------------------------------------------------------------------------
-- Where the handset projection's watermark lives
--
-- The sweep that projects `calls` into `insights_calls` needs to know how far it
-- got, or every tick rescans the whole history. A column on `organizations`
-- rather than a table: one value per org, read and written by one sweep.
--
-- It is a WATERMARK, not a cursor on ids: the sweep re-reads a padded window
-- behind it every tick, because a call's `disposition_key` is set by a person
-- minutes or hours after the call row appeared, and a cursor that only moves
-- forward would project every such call before it had an outcome. Same
-- recompute-don't-accumulate reasoning as telecaller-stats.
------------------------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS handset_facts_watermark timestamptz;

COMMENT ON COLUMN organizations.handset_facts_watermark IS
  '0194. How far handset-fact projection has got for this org. The sweep '
  're-reads a padded window behind it, because a disposition is written after '
  'the call. NULL means never projected, which is every org until the tenant '
  'holds the api_insights module.';
