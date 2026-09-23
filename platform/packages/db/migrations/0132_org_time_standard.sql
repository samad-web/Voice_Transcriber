-- 0132_org_time_standard.sql - one clock per workspace (Build docs/30).
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────
--
-- 0095 gave SQL one question it could ask in the org's own time zone - "what
-- is today" (org_reporting_today()) - and everything else kept asking the
-- database, which runs in UTC. So the dashboard filed every call made between
-- midnight and 05:29 IST under the previous day (`date_trunc('day', ts)` on a
-- UTC timestamptz), and its "last 30 days" was a rolling `now() - 30 days`
-- that no list filter - all of which take calendar dates - could reproduce.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────────
--
--   org_reporting_tz()        the current org's zone, else 'Asia/Kolkata'.
--   org_reporting_today()     re-expressed on top of it; same result as 0095.
--   org_window_start(days)    the instant the last `days` calendar days began,
--                             today included, at the org's own midnight.
--
-- `days = 1` is "today so far"; `days = 30` starts at midnight 29 days ago.
-- The previous window of equal length is [org_window_start(2n),
-- org_window_start(n)), which is why the function takes a count rather than a
-- date - both edges come from one definition.
--
-- ── WHY AT TIME ZONE ON A DATE AND NOT now() - interval ─────────────────────
--
-- `(date)::timestamp AT TIME ZONE tz` converts LOCAL MIDNIGHT ON THAT DATE to
-- an instant using the offset in force ON THAT DATE. Subtracting an interval
-- from now() uses today's offset for every day in the window, which is an hour
-- wrong across a DST change - irrelevant for IST, not for a tenant in London.
--
-- ── PER-ROW USE ─────────────────────────────────────────────────────────────
--
-- org_reporting_tz() runs a subquery, and Postgres will not inline it, so do
-- NOT call it once per row in a large scan. Read it once into a CTE and join:
--
--     WITH z AS (SELECT org_reporting_tz() AS tz)
--     SELECT (c.started_at AT TIME ZONE z.tz)::date AS day, ... FROM calls c, z
--
-- Like org_reporting_today(), both read `app.org_id` (set by withOrg) and fall
-- back to the deployment default outside org context rather than raising. A
-- cross-org job (the worker's sweeps) must join `organizations` and use each
-- row's own reporting_timezone instead.

CREATE OR REPLACE FUNCTION org_reporting_tz() RETURNS text AS $fn$
  SELECT COALESCE(
           (SELECT o.reporting_timezone
              FROM organizations o
             WHERE o.id = NULLIF(current_setting('app.org_id', true), '')::uuid),
           'Asia/Kolkata'
         );
$fn$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION org_reporting_tz() IS
  'The current org''s reporting_timezone (0090), else Asia/Kolkata. The one '
  'zone every day boundary and every displayed time uses (Build docs/30). '
  'Read it once per statement (a CTE), not once per row.';

CREATE OR REPLACE FUNCTION org_reporting_today() RETURNS date AS $fn$
  SELECT (now() AT TIME ZONE org_reporting_tz())::date;
$fn$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION org_reporting_today() IS
  'Today''s date in the current org''s reporting_timezone (0090). Use this and '
  'never current_date for anything a person reads as "today": the database '
  'runs in UTC and an Indian floor is five and a half hours ahead of it.';

CREATE OR REPLACE FUNCTION org_window_start(p_days integer) RETURNS timestamptz AS $fn$
  SELECT ((org_reporting_today() - (GREATEST(p_days, 1) - 1))::timestamp
            AT TIME ZONE org_reporting_tz());
$fn$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION org_window_start(integer) IS
  'The instant the last p_days calendar days began in the org''s zone, today '
  'included (Build docs/29 P1, docs/30 R4). The previous window of equal '
  'length is [org_window_start(2n), org_window_start(n)).';
