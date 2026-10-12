-- 0195_kpi_spine.sql - the configurable KPI spine: what an owner chose, what
-- the bands are, and what the engine computed.
--
-- This is `Build docs/41_TELECALLER_PERFORMANCE_KPI_SPINE.md` Parts F2, F3 and
-- G1, which were designed on 2026-10-09 and never built. The API-only tier
-- (Build docs/no-crm-api-dashboard-build-plan.md §7, M4) needs exactly this
-- spine, so it is built here once and serves both tiers - a KPI engine is not
-- a no-CRM feature, it is a feature the no-CRM tier is built out of, and
-- building it twice would be the mistake. INSIGHTS_TIER_DECISIONS §3.
--
-- Doc 41 numbered these migrations 0172/0173; those numbers went to the
-- finance back office in the meantime. The design is unchanged.
--
-- ── THE CATALOGUE IS NOT HERE ────────────────────────────────────────────────
--
-- The no-CRM spec's §10 puts `kpi_catalog` in the database. Doc 41 F1 refuses,
-- and this migration follows doc 41: a KPI's definition is a numerator, a
-- denominator and a source predicate - SQL that ships with the code that runs
-- it. A tenant-editable formula is an injection surface; a tenant-editable row
-- pointing AT code is two places to keep in step. The catalogue lives in
-- `packages/shared/src/kpi-catalog.ts`, next to the derivations already there.
--
-- `kpi_key` below is therefore free text with no FK and no CHECK listing the
-- keys. A CHECK would be a second copy of the catalogue that fails at write
-- time in production; 0101's header makes the same call for feature keys. The
-- API validates against `KpiKey` in zod, and `kpi-catalog.test.ts` pins the
-- set.

------------------------------------------------------------------------------
-- F2: what the owner chose
--
-- ── WHY FOUR SCOPE COLUMNS AND NOT ONE POLYMORPHIC `scope_id` ───────────────
--
-- Doc 41 wrote `scope_kind, scope_id`. A single uuid cannot do it: an
-- `owner_role` scope names a persona ('telecaller', 'manager'), which is text,
-- and a uuid pointing at either `teams` or `telecallers` depending on a
-- sibling column can carry no foreign key at all. So a target for a team that
-- is later deleted would survive as a row scoped to nothing, quietly applying
-- to nobody - or worse, matching a new team that reuses the id.
--
-- Three typed columns plus a CHECK that exactly the right one is populated
-- costs two columns and buys real referential integrity: deleting a team takes
-- its targets with it.
--
-- `workspace` from doc 41's list is deliberately replaced by `team`. A
-- workspace is an Aura recording concept that an API-only tenant does not
-- have; a team is the unit both tiers share. Specificity order is therefore
-- telecaller > owner_role > team > org.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_kpi_config (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kpi_key             text NOT NULL,
  scope_kind          text NOT NULL CHECK (scope_kind IN ('org', 'team', 'owner_role', 'telecaller')),
  scope_team_id       uuid REFERENCES teams(id) ON DELETE CASCADE,
  scope_telecaller_id uuid REFERENCES telecallers(id) ON DELETE CASCADE,
  scope_owner_role    text,

  -- NULL is legal and means "measure it, do not judge it": the KPI appears on
  -- the dashboard with its actual value and contributes NOTHING to the
  -- composite, because achievement needs a target to divide by. An owner who
  -- wants to watch connect rate before committing to a number gets that
  -- without a fake target, and doc 41 D2's "null means not enough to say"
  -- extends naturally to "no target means no achievement".
  target_value        numeric CHECK (target_value IS NULL OR target_value >= 0),
  period              text NOT NULL DEFAULT 'monthly'
                        CHECK (period IN ('daily', 'weekly', 'monthly')),
  -- 0 is legal: a selected KPI the owner does not want in the score. The
  -- 100-total rule is cross-row and therefore cannot be a CHECK - it is
  -- validated on save and there is a verification query in
  -- scripts/verify-kpi-weights.sql that finds any org whose active set does
  -- not total 100. Doc 41 F4 says exactly this.
  weight_pct          int NOT NULL DEFAULT 0 CHECK (weight_pct BETWEEN 0 AND 100),

  effective_from      date NOT NULL,
  effective_to        date,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT org_kpi_config_scope_matches_kind CHECK (
    CASE scope_kind
      WHEN 'org'        THEN scope_team_id IS NULL AND scope_telecaller_id IS NULL AND scope_owner_role IS NULL
      WHEN 'team'       THEN scope_team_id IS NOT NULL AND scope_telecaller_id IS NULL AND scope_owner_role IS NULL
      WHEN 'telecaller' THEN scope_telecaller_id IS NOT NULL AND scope_team_id IS NULL AND scope_owner_role IS NULL
      WHEN 'owner_role' THEN scope_owner_role IS NOT NULL AND scope_team_id IS NULL AND scope_telecaller_id IS NULL
    END
  ),
  -- A window that ends before it starts applies to no day and would sit in the
  -- table looking like a live target.
  CONSTRAINT org_kpi_config_window_ordered CHECK (
    effective_to IS NULL OR effective_to > effective_from
  )
);

-- One row per (scope, kpi, start date). `COALESCE` over the three scope
-- columns because a plain UNIQUE treats two NULLs as distinct, so
-- ('org', NULL, NULL, NULL) could be inserted twice - and two org-level
-- targets for one KPI means the resolver picks one, and which one it picked
-- decides everybody's score.
CREATE UNIQUE INDEX IF NOT EXISTS org_kpi_config_unique_scope
  ON org_kpi_config (
    org_id, kpi_key, scope_kind,
    COALESCE(scope_team_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(scope_telecaller_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(scope_owner_role, ''),
    effective_from
  );

-- The resolver's access path: every row that could apply to a day, narrowest
-- first is sorted in code.
CREATE INDEX IF NOT EXISTS org_kpi_config_active
  ON org_kpi_config (org_id, kpi_key, effective_from DESC);
CREATE INDEX IF NOT EXISTS org_kpi_config_live
  ON org_kpi_config (org_id, effective_from DESC) WHERE effective_to IS NULL;

------------------------------------------------------------------------------
-- F3: the rating bands
--
-- Effective-dated like the targets and for the same reason: changing a band
-- next month must not restate last month's ratings. `kpi_snapshots.band_key`
-- stores the band a day was rated into, so a past day keeps its verdict even
-- after the bands move.
--
-- `tone` is a palette name, not a colour. The console's standing rule is that
-- RED means MISSED and ORANGE means ERROR, and a person behind pace is
-- neither a missed call nor a system fault - so the lowest band must NOT
-- render in the error orange. Doc 41 F3 says this; the legal values here are
-- the KPI palette's, which has no `danger`.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_kpi_bands (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  band_key       text NOT NULL CHECK (band_key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label          text NOT NULL,
  -- Achievement percent. `min_pct` inclusive, `max_pct` exclusive and NULL for
  -- the top band - a half-open interval, so three bands cover every value
  -- with no gap and no overlap by construction rather than by arithmetic.
  min_pct        numeric NOT NULL CHECK (min_pct >= 0),
  max_pct        numeric CHECK (max_pct IS NULL OR max_pct > min_pct),
  tone           text NOT NULL DEFAULT 'neutral'
                   CHECK (tone IN ('neutral', 'attention', 'steady', 'strong')),
  sort           int NOT NULL DEFAULT 0,
  effective_from date NOT NULL,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_kpi_bands_window_ordered CHECK (
    effective_to IS NULL OR effective_to > effective_from
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS org_kpi_bands_unique
  ON org_kpi_bands (org_id, band_key, effective_from);
CREATE INDEX IF NOT EXISTS org_kpi_bands_active
  ON org_kpi_bands (org_id, effective_from DESC, sort);

------------------------------------------------------------------------------
-- G1: what the engine computed
--
-- ── THE MOST IMPORTANT COLUMN CHOICE ON THE TABLE ───────────────────────────
--
-- `numerator` and `denominator` are stored. The RATE IS NOT. A week is
-- `Σnum ÷ Σden`; a week built from stored daily rates is an average of
-- averages, which weights a four-call Saturday exactly like a ninety-call
-- Tuesday. Doc 41 G1.
--
-- Daily rows only. Weekly, monthly, quarterly and custom ranges all derive on
-- read by summing, which is why there is no `period` column here and why there
-- must never be one: a second grain is a second answer to the same question.
--
-- `denominator` is NULL for a count KPI (`calls_made` has no denominator) and
-- 0 is legal for a rate KPI with no base that day - the engine stores it and
-- the reader suppresses it, rather than the engine deciding not to write a row
-- at all. A missing row and a row with denominator 0 look identical to a
-- `COUNT(*)` and mean very different things: "not computed" versus "computed,
-- nothing to compute it from".
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS kpi_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- D3 of doc 41: `telecallers.user_id` is nullable, so the identity gap is
  -- admitted rather than averaged away. Each catalogue entry declares which
  -- identity it lives on, and this column records the one it was computed for.
  -- 'team' and 'org' are additions for the no-CRM tier's §8.2/§8.4 roll-ups:
  -- a percentile KPI cannot be re-derived from per-person rows (a median of
  -- medians is not a median), so the engine computes those grains itself.
  subject_kind  text NOT NULL CHECK (subject_kind IN ('telecaller', 'user', 'team', 'org')),
  -- NULL only when subject_kind = 'org'. No FK: it points at three different
  -- tables depending on the kind, which is the one case where a polymorphic
  -- reference is unavoidable - unlike org_kpi_config above, this table is
  -- rebuilt from facts on every sweep, so a dangling id self-heals on the next
  -- tick rather than persisting as a wrong target.
  subject_id    uuid,

  kpi_key       text NOT NULL,
  day           date NOT NULL,

  numerator     numeric NOT NULL,
  denominator   numeric,

  -- Snapshotted from the config that applied ON THAT DAY, resolved by F2's
  -- specificity rule. Stored rather than joined, which is what makes "changing
  -- a target next month must not rewrite last month" true by construction:
  -- the recompute re-resolves per day and gets the same answer it got the
  -- first time.
  target_value  numeric,
  -- The PERIOD that target was set over, carried alongside it because a bare
  -- number is not a target: 500 is 500 a day, a week or a month, and the read
  -- path has to pro-rate it to the window somebody asked for. Storing it per
  -- day is what makes a target that CHANGED mid-window come out right - the
  -- window's expected value is the sum of each day's own share, so a target
  -- raised on the 15th is honoured from the 15th rather than retrospectively.
  target_period text CHECK (target_period IS NULL
                    OR target_period IN ('daily', 'weekly', 'monthly')),
  weight_pct    int,
  direction     text NOT NULL CHECK (direction IN ('higher', 'lower')),
  band_key      text,

  computed_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The idempotency key for the sweep's INSERT ... ON CONFLICT DO UPDATE.
-- COALESCE on subject_id for the same NULL-is-distinct reason as above.
CREATE UNIQUE INDEX IF NOT EXISTS kpi_snapshots_unique
  ON kpi_snapshots (
    org_id, subject_kind,
    COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kpi_key, day
  );

-- The read paths: one subject over a range (a drill-down), and one day across
-- subjects (a leaderboard).
CREATE INDEX IF NOT EXISTS kpi_snapshots_subject_range
  ON kpi_snapshots (org_id, subject_kind, subject_id, day DESC);
CREATE INDEX IF NOT EXISTS kpi_snapshots_org_day
  ON kpi_snapshots (org_id, day DESC, kpi_key);

------------------------------------------------------------------------------
-- §8.11: the tier's own settings
--
-- Every column NULLable with NO DEFAULT, deliberately - the same call
-- `org_chart_settings` (0177) and `finance_settings` (0172) make. The defaults
-- live in `INSIGHTS_DEFAULTS` (packages/shared/src/insights-settings.ts) and
-- the API coalesces to them. A DEFAULT here would be a second copy that
-- quietly wins, so changing the shared default would reach new orgs only -
-- the hardest kind of inconsistency to notice.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS insights_settings (
  org_id                 uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- §16's default is "own rank only for telecallers", and it is an owner
  -- setting because a leaderboard is a management choice, not a product one.
  leaderboard_visibility text CHECK (leaderboard_visibility IS NULL
                           OR leaderboard_visibility IN ('hidden', 'own_rank', 'full')),
  -- §8.1's labelled, isolated demo data. A flag and not a seeded tenant: the
  -- demo rows carry `env = 'test'`, so they are already excluded from every
  -- engine read, and this says whether the console should show them.
  demo_mode              bool,
  -- §8.2's freshness stamp turns from a note into a warning past this.
  stale_feed_hours       int CHECK (stale_feed_hours IS NULL OR stale_feed_hours > 0),
  -- The composite is suppressed below this fraction of configured weight
  -- answering (doc 41 G2's coverage floor, default 0.6).
  coverage_floor         numeric CHECK (coverage_floor IS NULL
                           OR (coverage_floor > 0 AND coverage_floor <= 1)),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

------------------------------------------------------------------------------
-- RLS + the partner wall
------------------------------------------------------------------------------

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'org_kpi_config', 'org_kpi_bands', 'kpi_snapshots', 'insights_settings'
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
      'org_kpi_config', 'org_kpi_bands', 'kpi_snapshots', 'insights_settings'
    ]) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
        AND policyname = 'partner_wall' AND permissive = 'RESTRICTIVE'
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0195: partner_wall missing or not RESTRICTIVE on: %', missing;
  END IF;
END $$;

------------------------------------------------------------------------------
-- No seed, and that is the point
--
-- Not one row of `org_kpi_config` is written here. A target nobody agreed to
-- is a target that will be used to judge somebody, and doc 41 D4 is explicit
-- that a description must never silently become a quota. An org with no config
-- has no composite, no bands and no achievement - its dashboard shows actuals
-- and says, in words, that no targets are set.
--
-- The default BANDS are seeded for any org that later gets a config, by the
-- API's first write, from `DEFAULT_KPI_BANDS` in @aura/shared. Not here,
-- because an org that never adopts KPIs should not carry three band rows
-- forever.
------------------------------------------------------------------------------
