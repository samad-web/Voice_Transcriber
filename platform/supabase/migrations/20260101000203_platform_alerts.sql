-- 0203_platform_alerts.sql
--
-- Somewhere for an alert to be remembered, and a heartbeat for the process that
-- cannot report its own death. Doc 49 P2-B.
--
-- ── WHY AN ALERT NEEDS A TABLE AT ALL ───────────────────────────────────────
--
-- The naive version is a cron that runs some SQL and posts anything that looks
-- wrong. It fails twice, in opposite directions, and both failures end with
-- nobody reading it:
--
--   * EVERY RUN RE-ALERTS. A condition that lasts a week - which is exactly
--     what P1 was - becomes 2,016 identical messages at five-minute
--     resolution. People mute the channel on day one, and then the next real
--     alert arrives in a muted channel.
--   * NOTHING SAYS IT ENDED. An alert that fires and then goes quiet is
--     ambiguous: fixed, or still broken and the monitor died? Silence from a
--     monitor is the least useful signal there is, and this project has a
--     measured 62-day example of exactly what ambiguity costs.
--
-- So: state per alert key. First firing notifies, repeats are counted and
-- re-notified only on a slow clock, and the recovery is announced once. That is
-- the difference between an alerting system and a spam cannon.
--
-- ── AND WHY A HEARTBEAT ─────────────────────────────────────────────────────
--
-- The worker is the process where the 62-day outage happened, and it cannot
-- alert on being dead. The queue-depth and stuck-call checks catch it
-- indirectly, but both are inferences with their own false negatives - a dead
-- worker on a quiet night has no queue to back up. A heartbeat makes "the
-- worker is not running" a fact the alert script reads rather than deduces,
-- and the script runs from cron, so it is alive when the worker is not.
--
-- ── NEITHER TABLE IS TENANT DATA ────────────────────────────────────────────
--
-- An alert is about the PLATFORM: a vendor's wallet, a disk, a queue, a
-- process. There is no org_id to put on it, and a per-tenant copy of "the disk
-- is 81% full" would be four copies of one fact. Both tables are therefore on
-- `verify-rls.js`'s reviewed non-tenant allowlist, edited in this same commit.

BEGIN;

-- 1 ── WHAT IS WRONG, AND WHETHER ANYBODY HAS BEEN TOLD ─────────────────────

CREATE TABLE IF NOT EXISTS platform_alerts (
  /**
   * A stable identifier for the CONDITION, not for the firing: 'asr_success',
   * 'provider_parked', 'queue_depth'. Stable is the whole point - it is what
   * lets a week-long condition be one row with a count instead of 2,016 rows,
   * and what lets the recovery find the firing it is recovering.
   */
  key             text PRIMARY KEY,
  /**
   * 'firing' or 'ok'. Kept rather than deleted on recovery, so the table is
   * also the answer to "has this alarm ever fired?" - and an alarm nobody has
   * ever seen fire is an alarm nobody trusts.
   */
  state           text NOT NULL DEFAULT 'firing',
  /** The operator-facing sentence, as it was most recently true. */
  detail          text,
  /**
   * How bad. 'critical' is "the product is not working"; 'warning' is "it will
   * not be working soon unless somebody acts". Only the vocabulary the alert
   * script uses - deliberately two values, because a severity scale nobody can
   * tell apart is a severity scale nobody sorts by.
   */
  severity        text NOT NULL DEFAULT 'warning',
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  /** When a human was last actually told. NULL means nobody has been. */
  last_notified_at timestamptz,
  /** Consecutive checks that found this condition true. */
  occurrences     integer NOT NULL DEFAULT 1,
  resolved_at     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_alerts DROP CONSTRAINT IF EXISTS platform_alerts_state_check;
ALTER TABLE platform_alerts ADD CONSTRAINT platform_alerts_state_check
  CHECK (state IN ('firing', 'ok'));

ALTER TABLE platform_alerts DROP CONSTRAINT IF EXISTS platform_alerts_severity_check;
ALTER TABLE platform_alerts ADD CONSTRAINT platform_alerts_severity_check
  CHECK (severity IN ('critical', 'warning'));

-- A resolved row is not firing, and a firing row is not resolved. Cheap, and it
-- stops a half-applied recovery leaving a row that is both.
ALTER TABLE platform_alerts DROP CONSTRAINT IF EXISTS platform_alerts_resolved_consistent;
ALTER TABLE platform_alerts ADD CONSTRAINT platform_alerts_resolved_consistent
  CHECK ((state = 'ok') = (resolved_at IS NOT NULL));

COMMENT ON TABLE platform_alerts IS
  'One row per alert CONDITION (not per firing), so a week-long outage is one '
  'row with an occurrence count rather than 2,016 identical messages. Written '
  'only by scripts/alerts.js on the admin pool. Platform-scoped: an alert is '
  'about a vendor, a disk, a queue or a process, none of which belong to a '
  'tenant. Exempt from the verify-rls tenant sweep by a reviewed allowlist entry.';

COMMENT ON COLUMN platform_alerts.last_notified_at IS
  'When a human was last told. The gap between this and last_seen_at is the '
  'reminder interval; NULL means the firing has never been delivered, which is '
  'itself worth knowing when a webhook has been misconfigured.';

CREATE INDEX IF NOT EXISTS platform_alerts_firing_idx
  ON platform_alerts (severity, first_seen_at)
  WHERE state = 'firing';

-- 2 ── IS THE PROCESS ALIVE ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_heartbeats (
  /** 'worker', 'api'. One row per long-lived process, forever. */
  service    text PRIMARY KEY,
  beat_at    timestamptz NOT NULL DEFAULT now(),
  /** The deployed commit, so a heartbeat also answers "what is running". */
  release    text,
  /** Free-form, small: queue prefetches, sweeps started. Never tenant data. */
  detail     text
);

COMMENT ON TABLE platform_heartbeats IS
  'When each long-lived process last proved it was running, and which build. '
  'Read by scripts/alerts.js, which runs from cron and is therefore alive when '
  'the process it is checking is not - the reason this is a table rather than '
  'an in-process metric. Also makes "which commit is actually running" '
  'answerable without SSH, which doc 49 P7 names as the reason deploy drift '
  'survives.';

COMMIT;

-- ── WHO MAY READ EITHER ─────────────────────────────────────────────────────
--
-- Nobody a request can reach. REVOKE BEFORE GRANT - the lesson of
-- `marketing-schema-grants-trap`, where a GRANT-only migration narrowed
-- nothing because the role already held more than the GRANT named.
--
-- RLS FORCED with no policy, the established way this schema says "no
-- RLS-bound role may see any row" (auth_events, billing_webhook_events,
-- asr_provider_health). Merely ENABLED would let 0007's FORCE loop skip the
-- table and leave it looking like an ordinary non-tenant one, which is the hole
-- verify-rls.js exists to catch.
ALTER TABLE platform_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_alerts FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_heartbeats FORCE ROW LEVEL SECURITY;

REVOKE ALL ON platform_alerts FROM PUBLIC;
REVOKE ALL ON platform_heartbeats FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['aura_app', 'anon', 'authenticated', 'service_role']
  LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON platform_alerts FROM %I', r);
      EXECUTE format('REVOKE ALL ON platform_heartbeats FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--
--   \d+ platform_alerts
--   \d+ platform_heartbeats
--   node packages/db/verify-rls.js --structural-only   -- both on the allowlist
--   SET ROLE aura_app; SELECT * FROM platform_alerts;  -- → permission denied
--
--   -- and the consistency CHECK binds:
--   INSERT INTO platform_alerts (key, state) VALUES ('x', 'ok');
--   -- → ERROR: violates platform_alerts_resolved_consistent
