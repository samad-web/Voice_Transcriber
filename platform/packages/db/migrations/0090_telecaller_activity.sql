-- 0090_telecaller_activity.sql - a daily productivity rollup per telecaller:
-- how much they called, how long they talked, and how long they sat idle
-- between calls.
--
-- ── WHY A ROLLUP TABLE AND NOT A VIEW ───────────────────────────────────────
--
-- Every number below is derivable from `calls` and `call_analytics` with a
-- window function, and at today's volume a view would be free. It is the shape
-- that stops working, not the size: the productivity page asks for a 30-day
-- range across every telecaller on the floor, and the report builder (0077)
-- would re-run the same window function on every scheduled delivery. That is
-- O(the tenant's entire call corpus) per page load, which is the same failure
-- 0019 documents for the un-indexed hot paths - it looks fine forever and then
-- does not.
--
-- So: computed once per day by the worker, read as one indexed row per person
-- per day. `usage_events_org_kind_time` (0086) is the same trade.
--
-- ── WHAT IS NULLABLE, AND WHY THAT MATTERS MORE THAN USUAL ──────────────────
--
-- Nearly every metric column here is nullable, and none of them default to 0.
-- This is a coaching surface: a manager reads these numbers in a performance
-- conversation, so a metric with no basis has to be ABSENT rather than zero.
-- The precedent is apps/worker/src/pipeline/talk-metrics-gate.test.ts, which
-- exists because the alternative - a confidently wrong 100% talk ratio on a
-- non-diarized call - is worse than showing nothing.
--
-- Concretely:
--   median_gap_seconds     NULL on a day with fewer than two calls. There is
--                          no gap between one call and nothing.
--   agent_talk_seconds     NULL unless the org runs with asr_diarization on
--   customer_talk_seconds  (0083). Without acoustic separation every segment
--   mean_talk_ratio        is labelled "Agent" and the ratio is a lie, so the
--   interruption_count     enrichment lane writes no talk metrics at all.
--   presence_seconds       NULL until the handset presence beacon ships. The
--                          `device_health` beacon is every SIX HOURS
--                          (HealthWorker.kt), which cannot resolve a shift.
--
-- ── active_span_seconds IS NOT LOGIN DURATION ───────────────────────────────
--
-- Stated here as well as in the column comment because it is the one number on
-- this table someone will read as something it is not. It is first call start
-- to last call end. A rep who takes one call at 09:00 and one at 18:00 reports
-- a nine-hour span having worked for six minutes. It is a useful proxy for
-- "was this person on the floor today" and it is not a measure of time worked;
-- presence_seconds is that, and is null until the beacon exists.

-- ── The day boundary ────────────────────────────────────────────────────────
--
-- "Per day" is meaningless without a timezone, and getting it wrong is not a
-- rounding error: computed in UTC, an Indian floor's 21:30 call lands on
-- tomorrow and Monday looks empty. SCHEDULER_TIMEZONE already defaults to
-- Asia/Kolkata for the marketing container's booking slots; this is the same
-- decision for the same reason, made per org because a tenant is entitled to
-- one that is not ours.
--
-- Validated against pg_timezone_names rather than left as free text - a typo
-- here silently shifts every number on the page by however many hours the
-- fallback differs by, and `AT TIME ZONE 'Asia/Kolkatta'` raises at query time,
-- inside a sweep, where nobody is watching.
--
-- ENFORCED BY A TRIGGER, NOT A CHECK, and not by preference: a CHECK constraint
-- may not contain a subquery ("cannot use subquery in check constraint"), and
-- pg_timezone_names is a view over a set-returning function, so there is no
-- immutable expression that answers "is this a real zone". The alternatives
-- were a hand-maintained enum of ~600 zone names that goes stale with tzdata,
-- or trusting the application. A trigger is the only thing here that actually
-- binds.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS reporting_timezone text NOT NULL DEFAULT 'Asia/Kolkata';

CREATE OR REPLACE FUNCTION assert_valid_reporting_timezone() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.reporting_timezone) THEN
    RAISE EXCEPTION
      'reporting_timezone "%" is not a recognised IANA zone', NEW.reporting_timezone
      USING HINT = 'See SELECT name FROM pg_timezone_names, e.g. Asia/Kolkata.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only fires when the column actually changes, so the trigger sits out of the
-- way of every other UPDATE on organizations - and this table is written on
-- ordinary paths (asr budget, module toggles, branding), not just admin ones.
DROP TRIGGER IF EXISTS organizations_check_reporting_timezone ON organizations;
CREATE TRIGGER organizations_check_reporting_timezone
  BEFORE INSERT OR UPDATE OF reporting_timezone ON organizations
  FOR EACH ROW EXECUTE FUNCTION assert_valid_reporting_timezone();

COMMENT ON COLUMN organizations.reporting_timezone IS
  'IANA zone deciding what "a day" means for every daily rollup and report. '
  'Not cosmetic: it sets which calendar day a late-evening call is counted on.';

-- ── The rollup ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS telecaller_daily_stats (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- CASCADE, not SET NULL: a stats row keyed on nobody is not a fact about
  -- anything. Unlike leads/calls, whose telecaller column is a write-once
  -- attribution worth keeping after the person is gone, this row IS the person.
  telecaller_id         uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,
  -- The calendar day in the org's reporting_timezone, not in UTC.
  day                   date NOT NULL,

  -- ── Volume. Free from `calls`, no diarization, no LLM. ──
  calls_total           int NOT NULL DEFAULT 0,
  -- A call that connected, i.e. lasted past the point where it could only have
  -- been a ring-out. Shares MIN_TRANSCRIBE_SECONDS' reasoning (0084) but not
  -- its value: that one decides what is worth PAYING to transcribe, this one
  -- decides what counts as having reached a human. 15s, overridable per org.
  calls_connected       int NOT NULL DEFAULT 0,
  total_call_seconds    int NOT NULL DEFAULT 0,

  -- ── Pacing. Free from `calls`. ──
  --
  -- Median rather than mean, deliberately: a lunch break, a training session
  -- or one long lead-qualification call drags a mean far enough to make the
  -- number useless for the thing it is for, which is spotting a rep who is
  -- idle between every call rather than one who took an afternoon off.
  -- p90 is what shows the long tail the median hides.
  median_gap_seconds    int,
  p90_gap_seconds       int,
  longest_gap_seconds   int,

  -- ── Span. Free, and NOT time worked - see the header. ──
  first_call_at         timestamptz,
  last_call_at          timestamptz,
  active_span_seconds   int,

  -- ── Presence. NULL until the handset beacon ships. ──
  presence_seconds      int,

  -- ── Talk. NULL unless the org has asr_diarization on (0083). ──
  agent_talk_seconds    int,
  customer_talk_seconds int,
  mean_talk_ratio       numeric,
  interruption_count    int,
  -- How many of the day's calls actually contributed talk metrics. Without it
  -- a floor that diarizes half its calls shows an agent_talk_seconds that
  -- looks like a whole day's talking and is a sample of unknown size.
  talk_sample_calls     int NOT NULL DEFAULT 0,

  computed_at           timestamptz NOT NULL DEFAULT now(),

  -- The upsert key. One row per person per day, recomputed in place.
  UNIQUE (org_id, telecaller_id, day)
);

-- The productivity page's only read: this org, this date range, every person.
CREATE INDEX IF NOT EXISTS telecaller_daily_stats_org_day
  ON telecaller_daily_stats (org_id, day DESC);

-- One person's own trend line, and the predicate a `telecaller` persona is
-- narrowed to by owner-scope.ts.
CREATE INDEX IF NOT EXISTS telecaller_daily_stats_telecaller_day
  ON telecaller_daily_stats (org_id, telecaller_id, day DESC);

COMMENT ON COLUMN telecaller_daily_stats.active_span_seconds IS
  'First call start to last call end. A PROXY for the working day, NOT login '
  'duration - one call at 09:00 and one at 18:00 reports nine hours. '
  'presence_seconds is the real measure and is NULL until the handset beacon '
  'ships.';

COMMENT ON COLUMN telecaller_daily_stats.median_gap_seconds IS
  'Median idle seconds between one call ending and the next starting, within '
  'the day. NULL on a day with fewer than two calls - there is no gap between '
  'one call and nothing. Median, not mean: a lunch break must not read as '
  'idleness on every call.';

COMMENT ON COLUMN telecaller_daily_stats.agent_talk_seconds IS
  'NULL unless the org runs with asr_diarization on (0083). Without acoustic '
  'separation every segment is labelled Agent and the number would be the '
  'whole call - see talk-metrics-gate.test.ts.';

COMMENT ON COLUMN telecaller_daily_stats.talk_sample_calls IS
  'How many of the day''s calls contributed talk metrics. Read the talk '
  'columns against this, not against calls_total: a partially-diarized day '
  'otherwise reports a fraction of the talking as if it were all of it.';

-- What counts as having reached a human, per org. Nullable so an unset
-- instance follows the deployment default rather than a number a migration
-- picked for it - the same shape 0084 uses for its own thresholds.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS connected_call_seconds int;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_connected_call_seconds_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_connected_call_seconds_check
  CHECK (connected_call_seconds IS NULL OR connected_call_seconds BETWEEN 0 AND 600);

COMMENT ON COLUMN organizations.connected_call_seconds IS
  'Duration at or above which a call counts as connected in the productivity '
  'rollup. NULL uses the deployment default (15s). Distinct from '
  'min_transcribe_seconds (0084), which decides what is worth paying to '
  'transcribe, not what reached a person.';

-- ── Tenancy ─────────────────────────────────────────────────────────────────
-- Required, not optional: packages/db/verify-rls.js enumerates every org_id
-- table from the catalog and fails the deploy BY NAME on any that lacks FORCE
-- RLS or an org_isolation policy carrying both USING and WITH CHECK.
ALTER TABLE telecaller_daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE telecaller_daily_stats FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON telecaller_daily_stats
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON telecaller_daily_stats TO aura_app;

-- 0007 revoked Supabase's default privileges for future tables, but only for
-- the role that ran it. Re-assert here so a table created under a different
-- owner cannot arrive readable by the public anon key.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON telecaller_daily_stats FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON telecaller_daily_stats FROM PUBLIC;
