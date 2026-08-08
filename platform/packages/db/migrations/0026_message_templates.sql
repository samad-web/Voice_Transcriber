------------------------------------------------------------------------------
-- 0026 — editable message copy
--
-- WHY THIS TABLE EXISTS
--
-- Until now every word sent to an enquirer lived in a TypeScript string literal
-- in apps/worker/src/pipeline/whatsapp.ts. Changing a sentence meant an edit, a
-- typecheck, a build and a deploy — so in practice the copy was whatever the
-- developer wrote once, and the person who actually owns the tone of voice
-- could not touch it. This moves the copy into a row an operator can edit from
-- the console, while the code keeps its own copy as the fallback.
--
-- ── WHATSAPP ONLY, DELIBERATELY ────────────────────────────────────────────
--
-- The `channel` column exists so email can join later without a migration, but
-- only whatsapp rows are seeded. Email copy is still owned by
-- apps/worker/src/pipeline/funnel-followup.ts, and duplicating those five-
-- paragraph templates into a table nobody is editing would create two sources
-- of truth for text that currently cannot even be delivered (no mail provider
-- is configured — see that file's header). When email goes live, seed it here
-- and delete the literals there, in that order.
--
-- ── THE CODE COPY IS STILL THE FALLBACK, AND THAT IS NOT BELT-AND-BRACES ───
--
-- The worker reads this table on a short cache and falls back to its own
-- literals when a row is missing, disabled, or the query fails. Without that, a
-- database hiccup or a row someone deleted would turn into a dead-lettered
-- rejection — i.e. a person who is never told. Copy that is slightly out of
-- date beats no message at all.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing.message_templates (
  key         text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  -- Email only. NULL for whatsapp, which has no subject line — a subject
  -- pasted into a chat message is the tell that a human did not write it.
  subject     text,
  body        text NOT NULL CHECK (length(btrim(body)) > 0),
  -- Off means "do not send this stage at all", NOT "send an empty message".
  -- The worker skips a disabled row rather than substituting a blank.
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (key, channel)
);

------------------------------------------------------------------------------
-- Widen the outbox's template check.
--
-- 0024 pinned it to the three templates that existed. Two of the stages seeded
-- below (booking_confirmed, reminder_followup) have no sender yet, but a
-- template an operator can edit and the outbox cannot store is a trap: the
-- first time either is wired the INSERT would fail the check, at runtime, in
-- production. Widening now costs nothing and removes that.
------------------------------------------------------------------------------

ALTER TABLE marketing.funnel_followups
  DROP CONSTRAINT IF EXISTS funnel_followups_template_check;

ALTER TABLE marketing.funnel_followups
  ADD CONSTRAINT funnel_followups_template_check
  CHECK (template IN (
    'disqualified_neutral',
    'custom_crm_info',
    'rejected',
    'booking_confirmed',
    'reminder_followup'
  ));

------------------------------------------------------------------------------
-- Seed — the copy that is live today, VERBATIM.
--
-- `rejected`, `custom_crm_info` and `disqualified_neutral` are transcribed from
-- renderWhatsApp() in apps/worker/src/pipeline/whatsapp.ts with one change: the
-- greeting is now a {{first_name}} placeholder. The code built it conditionally
-- ("Hi Ramesh, " or "Hello, " when the name was unusable); the placeholder
-- resolves to "there" in that case, so "Hi there, thanks for…" is the worst it
-- can produce. It cannot produce "Hi , thanks".
--
-- ON CONFLICT DO NOTHING so re-running this never overwrites edited copy. That
-- is the whole point of the table — a migration that reset an operator's
-- wording on every deploy would be worse than no table.
------------------------------------------------------------------------------

INSERT INTO marketing.message_templates (key, channel, body, enabled) VALUES

-- LIVE. Queued by POST /v1/admin/leads/:id/reject.
('rejected', 'whatsapp',
 'Hi {{first_name}}, thanks for your interest in Aura and for telling us about your business. ' ||
 'Having looked at it properly we don''t think we''re the right fit for you at the moment, ' ||
 'so we won''t take this further. If things change, do come back to us.',
 true),

-- NOT SENT YET. Copy exists; nothing enqueues it. The funnel writes the
-- disqualified status but the marketing role holds no grant on funnel_followups
-- (0024, deliberately), so the enqueue has to come from the worker.
('disqualified_neutral', 'whatsapp',
 'Hi {{first_name}}, thanks for your enquiry about Aura. Someone from the team will get back to you. ' ||
 'If anything changes on your side in the meantime, we''d be glad to hear from you.',
 true),

-- NOT SENT YET. Same reason.
('custom_crm_info', 'whatsapp',
 'Hi {{first_name}}, thanks for asking about a CRM built around your business. Reply here and tell us ' ||
 'how you sell today, and we''ll say honestly whether you need a new system or just a ' ||
 'connector to the one you have.',
 true),

-- NOT SENT YET, and no code copy behind it either — this stage has never had a
-- message. {{slot}} is the booked time, rendered in Asia/Kolkata.
('booking_confirmed', 'whatsapp',
 'Hi {{first_name}}, your call with Aura is confirmed for {{slot}}. ' ||
 'We''ll call you on this number. If that time stops working, reply here and we''ll move it.',
 true),

-- NOT SENT YET at the time this ran: there was no reminder job.
-- UPDATE (2026-08-09, same day): the job now exists —
-- apps/worker/src/pipeline/funnel-reminders.ts — but ships switched off behind
-- FUNNEL_REMINDERS_ENABLED. Noted here rather than rewritten because this file
-- has already been applied and records what was true when it ran.
('reminder_followup', 'whatsapp',
 'Hi {{first_name}}, following up on your enquiry about Aura. ' ||
 'If you''d still like to see what your calls are saying, reply here and we''ll set up a time.',
 true)

ON CONFLICT (key, channel) DO NOTHING;

------------------------------------------------------------------------------
-- Grants
--
-- apps/api and apps/worker reach this through the admin pool, which connects as
-- the schema owner, so neither needs a grant.
--
-- `aura_marketing` — the public, unauthenticated website — gets NOTHING, for
-- the same reason 0024 gave it nothing on funnel_followups. 0020 set ALTER
-- DEFAULT PRIVILEGES granting SELECT/INSERT/UPDATE on future tables in this
-- schema, so without this REVOKE it would inherit UPDATE on the exact text the
-- platform sends to people. That is a public server that can rewrite the
-- company's outgoing messages.
------------------------------------------------------------------------------

REVOKE ALL ON marketing.message_templates FROM aura_marketing;

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON marketing.message_templates FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
