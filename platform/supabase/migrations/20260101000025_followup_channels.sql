------------------------------------------------------------------------------
-- 0025 — the follow-up outbox carries a channel
--
-- 0024 created an outbox that could only send email. WhatsApp is the channel
-- this market actually replies on, so the outbox becomes channel-aware rather
-- than growing a second parallel table: the retry, backoff, attempt-capping and
-- dead-lettering are identical for both, and duplicating them would mean fixing
-- every future bug twice.
--
-- `channel` defaults to 'email' so every existing row keeps its meaning.
------------------------------------------------------------------------------

ALTER TABLE marketing.funnel_followups
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

ALTER TABLE marketing.funnel_followups
  DROP CONSTRAINT IF EXISTS funnel_followups_channel_check;

ALTER TABLE marketing.funnel_followups
  ADD CONSTRAINT funnel_followups_channel_check
  CHECK (channel IN ('email', 'whatsapp'));

------------------------------------------------------------------------------
-- The "once per person" rule now includes the channel.
--
-- 0024's index was (submission_id, template) — one follow-up of each kind per
-- person, ever. That was right when email was the only channel and is wrong
-- now: rejecting someone should be able to send BOTH an email and a WhatsApp
-- message, and the old index would have silently swallowed the second one as a
-- conflict. Adding channel keeps the guarantee that matters (never the same
-- message twice on the same channel) without blocking the one that does not.
------------------------------------------------------------------------------

DROP INDEX IF EXISTS marketing.funnel_followups_once;

CREATE UNIQUE INDEX IF NOT EXISTS funnel_followups_once
  ON marketing.funnel_followups (submission_id, template, channel);

-- The drain selects due rows per channel, so the channel belongs in the index.
DROP INDEX IF EXISTS marketing.funnel_followups_due;

CREATE INDEX IF NOT EXISTS funnel_followups_due
  ON marketing.funnel_followups (channel, status, next_attempt_at)
  WHERE status = 'pending';

------------------------------------------------------------------------------
-- The recipient's number is on funnel_submissions already (phone_e164,
-- whatsapp_e164), so nothing is duplicated here. The drain joins to it exactly
-- as it joins for the email address.
--
-- Grants unchanged: aura_marketing still has nothing on this table. A public
-- unauthenticated web server that can insert into an outbox is a public web
-- server that can make the platform send WhatsApp messages to a number of its
-- choosing — which is spam sent from the owner's own account.
------------------------------------------------------------------------------
