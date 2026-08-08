------------------------------------------------------------------------------
-- 0029 — the Google Meet link for a booked call
--
-- Google mints a Meet URL when the calendar event is created with a
-- `conferenceData.createRequest`. It cannot be constructed or guessed, and it
-- is not derivable from the event id, so the only way to tell the enquirer
-- where to join is to store what Google returned.
--
-- Nullable, and it will be null more often than not:
--   · Google Calendar is not configured, so no event and no link
--   · the event was created before this column existed
--   · the insert succeeded but returned no conference block, which happens and
--     is deliberately NOT treated as a failure (the meeting is real and in the
--     calendar either way; failing a booking over a video URL would be the tail
--     wagging the dog)
--
-- So anything reading this must handle its absence. The booking confirmation
-- template drops the "join here" line rather than sending an empty link.
------------------------------------------------------------------------------

ALTER TABLE marketing.booking_slots
  ADD COLUMN IF NOT EXISTS meeting_url text;

------------------------------------------------------------------------------
-- Grants
--
-- 0023 gave `aura_marketing` UPDATE on a NAMED COLUMN LIST, and 0027 had to
-- extend it for the same reason: a column-scoped grant does not cover columns
-- added later. Without this the public site would create the meeting, receive
-- the link, and fail with "permission denied for column meeting_url" while
-- writing it down — after the slot was already claimed.
------------------------------------------------------------------------------

GRANT UPDATE (meeting_url) ON marketing.booking_slots TO aura_marketing;

------------------------------------------------------------------------------
-- The booking confirmation now offers the Meet link.
--
-- 0026 seeded this row and has already been applied, so it is left alone: an
-- applied migration is a record of what ran, not a document to edit.
--
-- Guarded on the OLD text. If an operator has since reworded this message in
-- the console, theirs wins and this does nothing — a migration that silently
-- overwrote hand-written copy would make the editor untrustworthy.
--
-- `{{meet_link}}` is OPTIONAL: fillTemplate() deletes the sentence containing
-- it when no link exists, rather than substituting a placeholder word. Without
-- that the message would read "Join here: there ." on every booking made while
-- Google Calendar is unconfigured, which is most of them today.
------------------------------------------------------------------------------

UPDATE marketing.message_templates
   SET body = 'Hi {{first_name}}, your call with Aura is confirmed for {{slot}}. ' ||
              'Join here: {{meet_link}} . If that time stops working, reply here and we''ll move it.'
 WHERE key = 'booking_confirmed'
   AND channel = 'whatsapp'
   AND body = 'Hi {{first_name}}, your call with Aura is confirmed for {{slot}}. ' ||
              'We''ll call you on this number. If that time stops working, reply here and we''ll move it.';
