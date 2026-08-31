------------------------------------------------------------------------------
-- 0030 - slots closed because the team is busy in Google Calendar
--
-- Until now the sync ran one way only: a booking made on the website was
-- mirrored INTO Google. Nothing came back. So an hour blocked out in the team's
-- own calendar - an existing client call, a dentist appointment, anything not
-- created by this funnel - stayed on offer to visitors, and the first anyone
-- knew was a double-booked human.
--
-- WHY A TIMESTAMP AND NOT A NEW `status`
--
-- `status` is CHECK-constrained to ('open','booked','cancelled') and it means
-- what the FUNNEL did with the slot. A fourth value would overload it with
-- something the funnel did not do, and the concurrency control in bookSlot()
-- keys on `status = 'open'` - every query touching it would need to learn about
-- the new value, which is how a claim path quietly stops being atomic.
--
-- This column is orthogonal instead: the slot is still 'open' as far as the
-- funnel is concerned, and separately not offerable right now. Reversible by
-- setting it back to NULL, which is exactly what has to happen when the
-- external meeting is cancelled - a slot that could never reopen would make
-- the calendar a one-way ratchet, losing availability permanently every time
-- someone moved a meeting.
--
-- NULL means "not blocked". The timestamp records WHEN the sweep last saw it
-- busy, which is what makes a stale block visible: a value hours older than the
-- last sweep means the sweep stopped running, not that the team is busy.
------------------------------------------------------------------------------

ALTER TABLE marketing.booking_slots
  ADD COLUMN IF NOT EXISTS external_busy_at timestamptz;

-- The sweep's own working set, and the listing's filter. Partial, because the
-- blocked slots are the small minority and an index over all of them would be
-- mostly empty pages.
CREATE INDEX IF NOT EXISTS booking_slots_external_busy_idx
  ON marketing.booking_slots (starts_at)
  WHERE external_busy_at IS NOT NULL;

------------------------------------------------------------------------------
-- Grants
--
-- NONE NEEDED, and that is worth stating rather than leaving to inference.
-- 0023 granted SELECT on the whole TABLE (`GRANT SELECT ON
-- marketing.booking_slots`), so a column added later is covered automatically.
-- The column-scoped grants that bit us in 0027 and 0029 were UPDATE grants -
-- `GRANT UPDATE (a, b, c)` does not extend to column d.
--
-- `aura_marketing` deliberately gets no UPDATE here. The public website must
-- never be able to mark a slot busy or clear a block; only the worker, which
-- connects as the schema owner, writes this column.
------------------------------------------------------------------------------
