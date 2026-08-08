------------------------------------------------------------------------------
-- 0023 — bookable slots, owned by the application
--
-- Until now "availability" was three environment variables (SCHEDULER_DAY_START,
-- _DAY_END, _WEEKDAYS) intersected with busy events from a Google Calendar. That
-- has two problems the owner ran into immediately:
--
--   · there is nowhere in the product to open a day and say "these four times
--     are free" — changing availability means editing an env file and
--     redeploying;
--   · it requires a Google Cloud project to exist before anyone can be booked
--     at all.
--
-- This table makes slots first-class data. An operator creates them in the
-- console; the funnel offers the open ones; booking one flips it to 'booked'.
-- Google Calendar remains optional and becomes a mirror, not the source.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing.booking_slots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stored as timestamptz — an absolute instant, not a wall-clock time. The
  -- console composes it from a date, a time and the team's zone; everything
  -- downstream compares instants and renders in whatever zone it displays.
  -- A naive `time` column would silently break the first time the team travels
  -- or the server moves region.
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,

  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'booked', 'cancelled')),

  -- Who booked it. ON DELETE SET NULL rather than CASCADE: erasing an enquirer's
  -- personal data must not delete the operator's calendar out from under them,
  -- it must leave the slot standing with the person detached.
  submission_id uuid REFERENCES marketing.funnel_submissions(id) ON DELETE SET NULL,
  booked_at     timestamptz,
  booked_name   text,

  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT booking_slots_ends_after_starts CHECK (ends_at > starts_at),
  -- A booked slot must know who booked it, and an open one must not claim to.
  CONSTRAINT booking_slots_booked_has_booker
    CHECK ((status = 'booked') = (booked_at IS NOT NULL))
);

-- No two live slots may start at the same instant. Partial, so a cancelled slot
-- does not block re-creating that time — which is exactly what an operator does
-- after cancelling one by mistake.
CREATE UNIQUE INDEX IF NOT EXISTS booking_slots_starts_uniq
  ON marketing.booking_slots (starts_at)
  WHERE status <> 'cancelled';

-- The funnel's only query: the next few open slots.
CREATE INDEX IF NOT EXISTS booking_slots_open_upcoming
  ON marketing.booking_slots (starts_at)
  WHERE status = 'open';

------------------------------------------------------------------------------
-- Grants — narrower than the schema default, deliberately
--
-- 0020 set ALTER DEFAULT PRIVILEGES granting SELECT, INSERT and UPDATE on every
-- future table in this schema to aura_marketing, so this table arrives with all
-- three. INSERT and table-wide UPDATE are both wrong here:
--
--   INSERT would let the public, unauthenticated marketing site CREATE its own
--   availability. Slots are the sales team's diary; the website may read them
--   and claim one, never invent one.
--
--   Table-wide UPDATE would let it rewrite starts_at — moving an appointment
--   rather than booking it — or flip a booked slot back to open.
--
-- So: SELECT, plus UPDATE on exactly the four columns that booking touches.
------------------------------------------------------------------------------

REVOKE ALL ON marketing.booking_slots FROM aura_marketing;

GRANT SELECT ON marketing.booking_slots TO aura_marketing;
GRANT UPDATE (status, submission_id, booked_at, booked_name)
  ON marketing.booking_slots TO aura_marketing;

-- Same treatment 0020 gives every other table here: Supabase's PostgREST roles
-- must never reach this schema. Belt and braces — 0020 already revoked schema
-- USAGE, which is sufficient on its own.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON marketing.booking_slots FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
