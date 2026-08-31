------------------------------------------------------------------------------
-- 0027 - connect a booked slot to Google Calendar
--
-- WHAT WAS BROKEN
--
-- Two slot systems existed and did not speak to each other:
--
--   apps/marketing/lib/scheduler/   Google Calendar. 700 lines, a real service
--                                   account client, invites, free/busy reads.
--                                   Used only by /booked.
--   marketing.booking_slots (0023)  A diary an operator fills from the console.
--                                   Used by the ACTUAL funnel at /start.
--
-- So every real booking went into Postgres and Google Calendar never heard about
-- it. The visitor got a confirmation, the row said 'booked', and no event ever
-- appeared in anyone's calendar - a booking that is real in our database and
-- invisible to the person who has to attend it.
--
-- The DB stays the source of truth for AVAILABILITY: it is the concurrency
-- control (`UPDATE ... WHERE status = 'open'` is what stops two visitors taking
-- 18:30), and the console is where the team defines when they are free. This
-- migration adds the two columns that record what happened when we then tried to
-- mirror the booking into Google.
------------------------------------------------------------------------------

ALTER TABLE marketing.booking_slots
  -- The Google Calendar event id, so a booking can be traced to the event and
  -- the event cancelled if the slot is later released.
  ADD COLUMN IF NOT EXISTS calendar_event_id text,
  -- Why the mirror failed, when it did. NOT a reason to fail the booking: the
  -- slot is genuinely claimed and the visitor has already been told so, and
  -- throwing that away because Google timed out would be the worse outcome. It
  -- is recorded so the team can see which confirmed bookings are missing from
  -- their calendar, rather than finding out by not turning up.
  ADD COLUMN IF NOT EXISTS calendar_error text;

-- Find the bookings that did not make it into the calendar:
--
--   SELECT id, starts_at, booked_name, calendar_error
--     FROM marketing.booking_slots
--    WHERE status = 'booked' AND calendar_event_id IS NULL
--    ORDER BY starts_at;
--
-- Partial, because the answer is almost always empty and the index should stay
-- a page or two rather than covering every slot ever generated.
CREATE INDEX IF NOT EXISTS booking_slots_calendar_unsynced
  ON marketing.booking_slots (starts_at)
  WHERE status = 'booked' AND calendar_event_id IS NULL;

------------------------------------------------------------------------------
-- Grants
--
-- 0023 REVOKEd everything from `aura_marketing` and granted back SELECT plus
-- UPDATE on exactly four columns. That column list is the security model of the
-- public site's access to this table - it may take an appointment out of the
-- diary and it categorically cannot invent availability - so the two new
-- columns have to be added to it explicitly. A plain `GRANT UPDATE` would hand
-- the public server the whole row, including starts_at.
------------------------------------------------------------------------------

GRANT UPDATE (status, submission_id, booked_at, booked_name, calendar_event_id, calendar_error)
  ON marketing.booking_slots TO aura_marketing;
