------------------------------------------------------------------------------
-- 0053 - the booking lifecycle: reminders, reschedule, attendance, nurture
--
-- Everything the funnel does to a submission BEFORE a booking exists is already
-- built: capture, qualify, dedupe, the resume nudge. Nothing exists for what
-- happens AFTER a slot is booked except the one-off WhatsApp confirmation
-- (0032). This migration adds the rest of that lifecycle:
--
--   · pre-call reminders at 24h / 1h / 5min, each carrying a reschedule link
--   · the reschedule link itself (a bearer token, same shape as 0033's resume
--     token, minted by the worker)
--   · attendance ("did the call happen"), recorded by an operator
--   · a nurture drip for a no-show, gated on the lead not having converted
--
-- ── WHY A SECOND OUTBOX, NOT A WIDER funnel_followups ───────────────────────
--
-- funnel_followups is keyed (submission_id, template, channel) and that key
-- means "once per person, ever" - the right rule for a rejection or a
-- went-quiet nudge, which happen at most once in a person's life in this
-- system. A reminder does not fit that key: a rescheduled call needs a SECOND
-- 24h/1h/5min sequence for the same submission, and a person who no-shows,
-- gets nurtured, then books and no-shows again needs a second nurture drip.
-- The natural key for all of this is the BOOKING, not the person, so it is a
-- separate table keyed on booking_slot_id - everything else about it (the
-- queue is the table, attempts/backoff/dead-letter, ON CONFLICT DO NOTHING) is
-- copied from funnel_followups unchanged.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- Form fields (§ the salutation and the business-type "other" gap)
--
-- Both descriptive, not qualifying - same status as digital_presence already
-- has. Neither feeds qualify() and neither gets a NOT NULL: every question on
-- this form is optional except the three contact fields (§3.3).
------------------------------------------------------------------------------

ALTER TABLE marketing.funnel_submissions
  ADD COLUMN IF NOT EXISTS salutation text
    CHECK (salutation IN ('mr', 'mrs', 'ms', 'dr', 'other')),
  -- Free text, populated only when business_type = 'other'. Same shape as
  -- crm_name (free text behind a select) - no CHECK, because what someone
  -- types to describe "something else" cannot be enumerated in advance.
  ADD COLUMN IF NOT EXISTS business_type_other text;

ALTER TABLE marketing.funnel_contact_history
  ADD COLUMN IF NOT EXISTS salutation text,
  ADD COLUMN IF NOT EXISTS business_type_other text;

------------------------------------------------------------------------------
-- Attendance
--
-- NULL = the call hasn't happened yet, or happened and nobody has recorded the
-- outcome. Deliberately not folded into `booking_slots.status` (open / booked
-- / cancelled) - status answers "is this hour claimed", attendance answers
-- "did the conversation happen", and a slot can be booked with either
-- attendance value or none. Recorded by an operator from the console, so who
-- and when are worth keeping for the same reason rejected_by/rejected_at are.
------------------------------------------------------------------------------

ALTER TABLE marketing.booking_slots
  ADD COLUMN IF NOT EXISTS attendance text
    CHECK (attendance IN ('attended', 'no_show')),
  ADD COLUMN IF NOT EXISTS attendance_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS attendance_recorded_by text;

------------------------------------------------------------------------------
-- The reschedule token
--
-- Identical reasoning to 0033's funnel_resume_tokens: a table and not a signed
-- URL, because it is minted by the worker and verified by the marketing app
-- (sharing FUNNEL_COOKIE_SECRET across both would be a second copy of a
-- security primitive), and because it needs to be revocable - it grants
-- write access to someone's calendar slot and travels over WhatsApp/email.
-- Only the hash is stored, for the same reason a password hash is.
--
-- Keyed on booking_slot_id, not submission_id: a reschedule link is a link to
-- swap THIS booking, and once the swap happens the old booking_slot_id is
-- released and the token naturally stops resolving to anything live.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing.reschedule_tokens (
  token_hash      text PRIMARY KEY,
  booking_slot_id uuid NOT NULL REFERENCES marketing.booking_slots(id) ON DELETE CASCADE,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reschedule_tokens_booking_slot
  ON marketing.reschedule_tokens (booking_slot_id);

------------------------------------------------------------------------------
-- The booking-notification outbox
--
-- Same shape as marketing.funnel_followups (0024): the queue is the table,
-- ON CONFLICT DO NOTHING makes enqueue idempotent, NULL next_attempt_at is
-- terminal. The unique key is (booking_slot_id, template, channel) rather than
-- (submission_id, template, channel) - see the file header for why.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing.booking_notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_slot_id     uuid NOT NULL
                      REFERENCES marketing.booking_slots(id) ON DELETE CASCADE,
  template            text NOT NULL
                      CHECK (template IN (
                        'reminder_call_24h',
                        'reminder_call_1h',
                        'reminder_call_5m',
                        'call_attended',
                        'call_no_show',
                        'nurture_1',
                        'nurture_2',
                        'nurture_3'
                      )),
  channel             text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sent', 'dead')),
  attempts            int  NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,      -- NULL = terminal, same convention as funnel_followups
  last_attempt_at     timestamptz,
  error               text,
  provider_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_notifications_once
  ON marketing.booking_notifications (booking_slot_id, template, channel);

CREATE INDEX IF NOT EXISTS booking_notifications_due
  ON marketing.booking_notifications (status, next_attempt_at)
  WHERE status = 'pending';

------------------------------------------------------------------------------
-- Seed the copy.
--
-- The three reminder_call_* and nurture_1/2/3 stages seed DISABLED, for two
-- different reasons that land on the same switch:
--
--   reminder_call_*  is a NEW, untested delivery path (a new outbox, a new
--                    worker sweep) going out to people close to a real
--                    appointment - 0033's lesson (shipped enabled once,
--                    three real people were messaged before the owner had
--                    read the wording) applies directly.
--
--   nurture_1/2/3    quotes the two landing-page testimonials in proof.tsx,
--                    which that file's own header states plainly were never
--                    approved by the customers they are attributed to. A
--                    one-to-one WhatsApp/email message is a materially
--                    different exposure than a sentence on a public page, and
--                    turning this on is the owner's call, not a default.
--
-- call_attended/call_no_show ship enabled: they are a direct, human-triggered
-- reply to an operator's own button press, the same category as `rejected`.
--
-- ON CONFLICT DO NOTHING so a redeploy never overwrites an operator's edits.
------------------------------------------------------------------------------

INSERT INTO marketing.message_templates (key, channel, body, enabled) VALUES

('reminder_call_24h', 'whatsapp',
 'Hi {{title_name}}, a reminder that your call with Aura is tomorrow at {{slot}}. ' ||
 'Need a different time? Reschedule here: {{reschedule_link}}',
 false),

('reminder_call_1h', 'whatsapp',
 'Hi {{title_name}}, your call with Aura is in about an hour, at {{slot}}. ' ||
 'Can''t make it? Reschedule here: {{reschedule_link}}',
 false),

('reminder_call_5m', 'whatsapp',
 'Hi {{title_name}}, your call with Aura starts in a few minutes. ' ||
 'Join here: {{meet_link}} . Running late or need a new time? {{reschedule_link}}',
 false),

('call_attended', 'whatsapp',
 'Hi {{title_name}}, thanks for the call today. It was good to talk through what you''re ' ||
 'looking for - we''ll follow up with next steps shortly.',
 true),

('call_no_show', 'whatsapp',
 'Hi {{title_name}}, we had a call scheduled today and didn''t manage to connect. ' ||
 'No trouble at all - pick a new time whenever suits: {{reschedule_link}}',
 true),

('nurture_1', 'whatsapp',
 -- ⚠️ UNAPPROVED WORDING - see components/proof.tsx in apps/marketing. Get the
 -- customer's written sign-off before enabling this row.
 'Hi {{title_name}}, following up after the call we missed. One of our customers, RD Interlock ' ||
 'Bricks, told us: "Our conversion rate is five times what it was. We are not calling more ' ||
 'people, we finally know which calls are worth following up." Still worth a look? ' ||
 '{{reschedule_link}}',
 false),

('nurture_2', 'whatsapp',
 -- ⚠️ UNAPPROVED WORDING - same caveat as nurture_1.
 'Hi {{title_name}}, another quick note. Fortune Innovatives told us: "The insights are ' ||
 'what we train the team on now. Our objection handling is a different thing from what ' ||
 'it was." If you''d still like to see this on your own calls: {{reschedule_link}}',
 false),

('nurture_3', 'whatsapp',
 'Hi {{title_name}}, last note from us on this - the offer to talk stands whenever you''re ' ||
 'ready, no pressure. Pick a time here if that changes: {{reschedule_link}}',
 false)

ON CONFLICT (key, channel) DO NOTHING;

------------------------------------------------------------------------------
-- NO EMAIL ROWS ARE SEEDED HERE, and that is deliberate.
--
-- Every stage now carries email copy in the @aura/shared catalogue, which the
-- worker falls back to when the table has no row and which the console editor
-- renders as the starting text. Seeding fifteen more rows would mean a second
-- copy of that prose living in a file that can never be edited again once
-- applied, kept in sync by hand. The row appears the first time an operator
-- saves an edit, which is exactly when a stored override starts to mean
-- something.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- The booking confirmation now offers a way to move the call.
--
-- Guarded on the exact text 0029 left behind, for the reason 0029 gives: if an
-- operator has since reworded this in the console, theirs wins and this does
-- nothing. A migration that silently overwrote hand-written copy would make the
-- editor untrustworthy.
--
-- `{{reschedule_link}}` is OPTIONAL, like `{{meet_link}}` beside it -
-- fillTemplate() deletes the sentence containing it when no link could be
-- minted, rather than substituting a placeholder word. So a deployment with no
-- SITE_DOMAIN keeps sending a correct confirmation that simply does not offer
-- self-service rescheduling, instead of dead-lettering every booking.
------------------------------------------------------------------------------

UPDATE marketing.message_templates
   SET body = 'Hi {{title_name}}, your call with Aura is confirmed for {{slot}}. ' ||
              'Join here: {{meet_link}} . If that time stops working, move it here: {{reschedule_link}}'
 WHERE key = 'booking_confirmed'
   AND channel = 'whatsapp'
   AND body = 'Hi {{first_name}}, your call with Aura is confirmed for {{slot}}. ' ||
              'Join here: {{meet_link}} . If that time stops working, reply here and we''ll move it.';

------------------------------------------------------------------------------
-- Greet people with the title they gave us.
--
-- The form now asks for a salutation, so `{{title_name}}` resolves to
-- "Mr. Ramesh Kumar" for anyone who chose one. It degrades in two steps -
-- to the first name when they did not, and to "there" when the name is
-- unusable - so this is strictly an upgrade over `{{first_name}}` and cannot
-- produce a worse greeting than the one it replaces.
--
-- Every default body in @aura/shared now opens with it. These UPDATEs bring the
-- ALREADY-SEEDED rows (0026 and 0033) into line, because a row that exists wins
-- over the code fallback - without them, production would keep sending
-- "Hi Ramesh," from the database while the catalogue claimed otherwise, and
-- message-templates.test.ts would be asserting a string nothing sends.
--
-- ── GUARDED ON THE EXACT PRIOR TEXT, ONE STATEMENT PER STAGE ──────────────
--
-- The tempting version is one `regexp_replace` over every row. It is wrong
-- twice: it would rewrite copy an operator has reworded (0029's rule - theirs
-- wins), and it would leave no literal of the new text anywhere in the SQL, so
-- the catalogue-vs-seed drift test would have nothing to match and would stop
-- being able to tell these two sources apart. Verbose and checkable beats
-- clever and silent.
------------------------------------------------------------------------------

UPDATE marketing.message_templates
   SET body = 'Hi {{title_name}}, thanks for your interest in Aura and for telling us about your business. ' ||
              'Having looked at it properly we don''t think we''re the right fit for you at the moment, ' ||
              'so we won''t take this further. If things change, do come back to us.'
 WHERE key = 'rejected' AND channel = 'whatsapp'
   AND body = 'Hi {{first_name}}, thanks for your interest in Aura and for telling us about your business. ' ||
              'Having looked at it properly we don''t think we''re the right fit for you at the moment, ' ||
              'so we won''t take this further. If things change, do come back to us.';

UPDATE marketing.message_templates
   SET body = 'Hi {{title_name}}, thanks for your enquiry about Aura. Someone from the team will get back to you. ' ||
              'If anything changes on your side in the meantime, we''d be glad to hear from you.'
 WHERE key = 'disqualified_neutral' AND channel = 'whatsapp'
   AND body = 'Hi {{first_name}}, thanks for your enquiry about Aura. Someone from the team will get back to you. ' ||
              'If anything changes on your side in the meantime, we''d be glad to hear from you.';

UPDATE marketing.message_templates
   SET body = 'Hi {{title_name}}, thanks for asking about a CRM built around your business. Reply here and tell us ' ||
              'how you sell today, and we''ll say honestly whether you need a new system or just a ' ||
              'connector to the one you have.'
 WHERE key = 'custom_crm_info' AND channel = 'whatsapp'
   AND body = 'Hi {{first_name}}, thanks for asking about a CRM built around your business. Reply here and tell us ' ||
              'how you sell today, and we''ll say honestly whether you need a new system or just a ' ||
              'connector to the one you have.';

UPDATE marketing.message_templates
   SET body = 'Hi {{title_name}}, following up on your enquiry about Aura. ' ||
              'If you''d still like to see what your calls are saying, reply here and we''ll set up a time.'
 WHERE key = 'reminder_followup' AND channel = 'whatsapp'
   AND body = 'Hi {{first_name}}, following up on your enquiry about Aura. ' ||
              'If you''d still like to see what your calls are saying, reply here and we''ll set up a time.';

UPDATE marketing.message_templates
   SET body = 'Hi {{title_name}}, you started telling us about your business on Aura but didn''t finish. ' ||
              'It takes under a minute - pick up where you left off: {{resume_link}}'
 WHERE key = 'resume_form' AND channel = 'whatsapp'
   AND body = 'Hi {{first_name}}, you started telling us about your business on Aura but didn''t finish. ' ||
              'It takes under a minute - pick up where you left off: {{resume_link}}';

UPDATE marketing.message_templates
   SET body = 'Hi {{title_name}}, your Aura enquiry is still open. Answer the last few questions and ' ||
              'we''ll tell you honestly whether we can help: {{resume_link}}'
 WHERE key = 'resume_form_2' AND channel = 'whatsapp'
   AND body = 'Hi {{first_name}}, your Aura enquiry is still open. Answer the last few questions and ' ||
              'we''ll tell you honestly whether we can help: {{resume_link}}';

------------------------------------------------------------------------------
-- Grants
--
-- apps/api and apps/worker reach every table above through the admin pool
-- (schema owner), so neither needs a grant.
--
-- `aura_marketing` - the public, unauthenticated website - gets:
--   · booking_slots: no NEW grant needed. attendance/attendance_recorded_*
--     are written only from the admin console via the admin pool; the
--     existing column-scoped UPDATE from 0023 is untouched and does not cover
--     these columns.
--   · reschedule_tokens: SELECT + UPDATE (used_at) only, identical reasoning
--     to 0033 - the website must read a token and stamp first-use, and must
--     never be able to mint one itself.
--   · booking_notifications: NOTHING, for the same reason funnel_followups
--     gets nothing (0024) - an internet-facing server that can insert into an
--     outbox is one that can make the platform message an arbitrary number.
------------------------------------------------------------------------------

-- REVOKE FIRST. This is not defensive tidying - without it the two GRANTs
-- below are no-ops on top of something wider. See the block at the end of this
-- file for what that cost, and why it is being fixed here for two other tables
-- as well.
REVOKE ALL ON marketing.reschedule_tokens FROM aura_marketing;

GRANT SELECT           ON marketing.reschedule_tokens TO aura_marketing;
GRANT UPDATE (used_at) ON marketing.reschedule_tokens TO aura_marketing;

------------------------------------------------------------------------------
-- The column-scoped UPDATE that 0051 forgot and 0052 had to add afterwards.
--
-- 0020 granted `funnel_contact_history` only SELECT and INSERT table-wide, so
-- EVERY updatable column on it has to be named explicitly - 0022 did it for the
-- original seven answers, 0028 for crm_satisfied, and 0052 for digital_presence
-- after 0051 shipped without it and every step-2 submission in production
-- failed with "permission denied for table funnel_contact_history".
--
-- `business_type_other` is written by the same UPDATE in recordQualification(),
-- so it needs the same grant, in the same migration that adds the column rather
-- than in a follow-up after the same outage.
--
-- `salutation` on that table needs nothing: it is only ever INSERTed, on the
-- history row created at step 1, and INSERT is already granted table-wide.
-- Both columns on `funnel_submissions` need nothing either - 0020 granted
-- SELECT, INSERT and UPDATE table-wide there.
------------------------------------------------------------------------------

GRANT UPDATE (business_type_other) ON marketing.funnel_contact_history TO aura_marketing;

REVOKE ALL ON marketing.booking_notifications FROM aura_marketing;

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON marketing.reschedule_tokens FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON marketing.booking_notifications FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

------------------------------------------------------------------------------
-- Closing the same hole on two tables that already have it. 🔴
--
-- FOUND while verifying this migration against a real database: the grants
-- `aura_marketing` actually holds are not the ones two earlier migrations
-- believe they granted.
--
--   marketing.funnel_resume_tokens   (0033)  SELECT, INSERT, UPDATE
--   marketing.funnel_criteria        (0031)  SELECT, INSERT, UPDATE
--
-- Both files say plainly that the public website must have less than that.
-- 0033: "It must never be able to CREATE one: an internet-facing server that
-- can mint resume tokens is an internet-facing server that can mint working
-- links into any enquiry in the table." 0031 grants "SELECT only", with a
-- comment explaining why write access is withheld. Neither is what is in the
-- database.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- 0020 ends with
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA marketing
--       GRANT SELECT, INSERT, UPDATE ON TABLES TO aura_marketing;
--
-- so every table created in this schema afterwards ARRIVES with all three.
-- A migration that only adds grants therefore narrows nothing - the GRANT is a
-- no-op on top of something wider, and the file reads as though it worked.
-- 0023, 0024, 0026 and 0032 all get this right by doing `REVOKE ALL ... FROM
-- aura_marketing` first; 0031 and 0033 skipped that step, and the comments
-- describing the intended boundary are the only place that boundary existed.
--
-- ── WHAT IT MEANT ─────────────────────────────────────────────────────────
--
-- Exploiting it needs a second bug - an injection or a code path that writes
-- where it should not - because nothing in the application issues these
-- statements. That is exactly the point: this is the containment layer that is
-- supposed to hold WHEN something else fails, and it was not holding. With
-- INSERT on funnel_resume_tokens, the compromise of a public unauthenticated
-- server becomes a working link into any enquirer's record.
--
-- Fixed here rather than in a follow-up migration because it is two lines and
-- because leaving a known hole open while adding a third table beside it would
-- be indefensible. Idempotent, and safe to re-run.
------------------------------------------------------------------------------

REVOKE ALL ON marketing.funnel_resume_tokens FROM aura_marketing;
GRANT SELECT           ON marketing.funnel_resume_tokens TO aura_marketing;
GRANT UPDATE (used_at) ON marketing.funnel_resume_tokens TO aura_marketing;

REVOKE ALL ON marketing.funnel_criteria FROM aura_marketing;
GRANT SELECT ON marketing.funnel_criteria TO aura_marketing;

------------------------------------------------------------------------------
-- And stop the next table inheriting it.
--
-- The default is narrowed to SELECT and INSERT: SELECT because every table here
-- is read by the site, INSERT because `funnel_contact_history` and
-- `funnel_rate_limit` genuinely need it table-wide. UPDATE is dropped, because
-- every table that needs it has needed it on SPECIFIC COLUMNS - booking_slots
-- (0023/0027/0029), funnel_resume_tokens (0033), reschedule_tokens (above) -
-- and a table-wide default is what silently overrode each of those.
--
-- `funnel_submissions` and `funnel_criteria` keep their existing table-wide
-- UPDATE, granted explicitly by 0020 and unaffected by a change to the DEFAULT.
-- This governs tables created from here on, so the next one arrives needing its
-- write access asked for rather than taken away.
------------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES IN SCHEMA marketing
  REVOKE UPDATE ON TABLES FROM aura_marketing;
