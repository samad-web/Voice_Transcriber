------------------------------------------------------------------------------
-- 0032 — switch on the booking confirmation, without messaging the backlog
--
-- The `booking_confirmed` WhatsApp message has existed, unsent, since 0026. It
-- was off by decision (owner, 2026-08-09: nobody who books a call gets
-- messaged), and the owner reversed that on 2026-08-10 so the lead receives the
-- Google Meet link on the channel this market actually reads.
--
-- Turning it on means a worker sweep that queues a confirmation for any booked
-- slot that has not got one. Run against the database as it stands today, that
-- sweep would immediately message every person who has ALREADY booked — people
-- who booked days ago, under the explicit promise that we would not message
-- them, and who would receive an out-of-the-blue WhatsApp about a call they
-- arranged last week. One of them is booked into a slot that has already
-- passed.
--
-- So the backlog is marked as handled BEFORE the sweeper can see it. The
-- outbox's own unique key — (submission_id, template, channel) — is the marker,
-- and the sweeper's ON CONFLICT DO NOTHING then skips these rows forever.
--
-- ── WHY status = 'dead' AND NOT 'sent' ──────────────────────────────────────
--
-- 'sent' would be a lie in the table an operator consults to find out what we
-- sent someone. These messages were never sent and never will be. 'dead' with a
-- reason is the truthful record of a message that was deliberately not
-- delivered, and it reads correctly in the console: not delivered, here is why.
--
-- ── WHY THIS IS A MIGRATION AND NOT A TIME WINDOW IN THE SWEEPER ────────────
--
-- The obvious alternative — only confirm bookings made in the last N hours —
-- fails in both directions. Too narrow and a worker restart during an outage
-- silently drops a real confirmation; too wide and it messages the backlog on
-- the first tick after deploy. A persisted marker has neither failure mode:
-- every booking that exists right now is settled, every booking made after this
-- is confirmed, and how long the worker was down stops mattering.
------------------------------------------------------------------------------

INSERT INTO marketing.funnel_followups
  (submission_id, template, channel, status, attempts, next_attempt_at, error)
SELECT DISTINCT
  b.submission_id,
  'booking_confirmed',
  'whatsapp',
  'dead',
  0,
  NULL,
  'predates booking confirmations (migration 0032) — deliberately not sent'
FROM marketing.booking_slots b
WHERE b.status = 'booked'
  AND b.submission_id IS NOT NULL
ON CONFLICT (submission_id, template, channel) DO NOTHING;

------------------------------------------------------------------------------
-- Finding the bookings still owed a confirmation.
--
-- The sweeper runs this shape every minute: booked slots with no outbox row for
-- this (template, channel). Without an index it is a sequential scan of the
-- slot table on every tick, forever, for a table that only grows.
--
-- Partial, because the sweeper only ever asks about booked slots — which are a
-- small and slowly-growing subset of a table that holds every OPEN slot the
-- generator has ever produced.
------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS booking_slots_booked_submission
  ON marketing.booking_slots (submission_id)
  WHERE status = 'booked' AND submission_id IS NOT NULL;

------------------------------------------------------------------------------
-- Grants
--
-- NONE, deliberately, and this is the load-bearing decision in the file.
--
-- `aura_marketing` — the role the public, unauthenticated website runs as —
-- gets no access to `funnel_followups` here, exactly as 0024 and 0025 refused
-- it. An internet-facing server that can INSERT into the outbox is an
-- internet-facing server that can make us send WhatsApp messages to arbitrary
-- numbers. The confirmation is queued by the WORKER, which is not reachable
-- from the internet, and that is the whole reason the sweeper exists instead of
-- the far simpler "enqueue it in the booking transaction".
------------------------------------------------------------------------------
