-- 0098_meta_messaging.sql - WhatsApp Business API, Instagram Direct and
-- Facebook Messenger as inbox channels.
--
-- ── WHAT WAS ALREADY HERE ───────────────────────────────────────────────────
--
-- `messaging_channels` (0056) is already provider-agnostic: `provider` is
-- free text on purpose, so onboarding a vendor is a row rather than a
-- migration, and `wasi` and `evolution` - the paired-handset kind of WhatsApp
-- - already work through it. `conversations` and `messages` (0055) already
-- thread by counterparty and carry direction, so nothing about the inbox needs
-- to change to gain a channel.
--
-- What was NOT here is the vocabulary. `channel` carries a CHECK of
-- ('whatsapp','sms','email'), which is the one place the schema takes a
-- position on what a conversation can be - and Instagram DMs and Facebook
-- Messenger are neither of the three.
--
-- ── WHY WABA IS A PROVIDER AND INSTAGRAM IS A CHANNEL ───────────────────────
--
-- This is the distinction the whole file turns on, and getting it backwards
-- would produce an inbox nobody can filter.
--
-- WhatsApp Business API and a paired personal handset are the SAME channel: a
-- WhatsApp message, from a phone number, to a person who does not know or care
-- which API carried it. They differ in how we reach the network - approval,
-- templates, session windows - which is exactly what `provider` is for.
--
-- Instagram and Messenger are DIFFERENT channels: the counterparty is not a
-- phone number, the identity does not dedupe against a contact's mobile, and
-- "reply to this on Instagram" is not the same act as "reply on WhatsApp". A
-- tenant filtering their inbox by channel means these to be separate, and a
-- provider field cannot express that.
--
-- ── THE 24-HOUR WINDOW IS A PRODUCT FACT, NOT A DETAIL ──────────────────────
--
-- All three Meta channels only allow a free-form reply within 24 hours of the
-- customer's last message; after that WhatsApp needs an approved template and
-- Instagram/Messenger need a permitted tag or nothing at all. The console has
-- to be able to say "you can still reply for another 3 hours", so the window
-- is derived from `conversations.last_inbound_at`, which 0055 already records -
-- no new column, and no second clock to get out of step with the messages.

-- ── The channel vocabulary ──────────────────────────────────────────────────
ALTER TABLE messaging_channels DROP CONSTRAINT IF EXISTS messaging_channels_channel_check;
ALTER TABLE messaging_channels ADD CONSTRAINT messaging_channels_channel_check
  CHECK (channel IN ('whatsapp', 'sms', 'email', 'instagram', 'facebook'));

-- `conversations` carries the same vocabulary and must move with it, or the
-- first Instagram message ingested fails its own CHECK after the channel row
-- was accepted - the worst place to discover a mismatch.
DO $do$
DECLARE
  tbl text;
  con text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['conversations', 'messages'] LOOP
    FOR con IN
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
       WHERE t.relname = tbl
         AND c.contype = 'c'
         AND a.attname = 'channel'
         AND c.conkey = ARRAY[a.attnum]
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, con);
    END LOOP;
    -- Only if the table actually has the column: `messages` may carry the
    -- channel on its conversation rather than on itself, and adding a
    -- constraint to a column that is not there would abort the migration.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = tbl AND column_name = 'channel'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (channel IN (
           ''whatsapp'', ''sms'', ''email'', ''instagram'', ''facebook''))',
        tbl, tbl || '_channel_check');
    END IF;
  END LOOP;
END $do$;

-- ── What a Meta channel needs to store ──────────────────────────────────────
--
-- All of it goes in `config` jsonb rather than in columns, which is what 0056
-- built that field for: a WABA channel needs a phone_number_id and a
-- business_account_id, Instagram needs an ig_user_id, Messenger needs a
-- page_id, and a column each would be four migrations and four mostly-null
-- columns on every SMS channel.
--
-- The ACCESS TOKEN is the exception and already has a home: `api_key`, sealed
-- with encryptSecret() like every other stored credential. A page token in
-- jsonb would be a secret in a column nothing treats as one.
COMMENT ON COLUMN messaging_channels.config IS
  'Per-provider settings. WABA: phoneNumberId, businessAccountId, '
  'verifyToken. Instagram: igUserId, pageId. Messenger: pageId. Wasi: '
  'wasiClientId. The credential itself lives in api_key, encrypted.';

-- ── Approved WhatsApp templates ─────────────────────────────────────────────
--
-- ── WHY A TABLE AND NOT A FETCH ─────────────────────────────────────────────
--
-- Templates could be read from Meta on demand. They are cached here because
-- the console needs them to RENDER a composer - a dropdown that waits on a
-- Graph round trip, and fails when Meta is slow, makes the reply box feel
-- broken - and because approval state changes underneath us: a template that
-- was approved yesterday can be paused by Meta today, and a send against a
-- paused template fails with an error the rep cannot interpret. Cached, the
-- console can grey it out and say why.
--
-- ── AND WHY THEY ARE ONE TABLE ACROSS CHANNELS ──────────────────────────────
--
-- The Hawcus teardown (§3.4) found a single templates table serving four
-- channels with Meta's approval state modelled inline, and called it the right
-- design. It is: a template is a named, parameterised message, and the channel
-- is an attribute of it rather than a reason for a separate table. Aura's
-- existing `marketing.message_templates` (0026) is deliberately NOT this - it
-- is funnel-scoped, lives in the marketing schema, and is written by us rather
-- than by the tenant.
CREATE TABLE IF NOT EXISTS message_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel_id  uuid REFERENCES messaging_channels(id) ON DELETE CASCADE,

  channel     text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  -- Meta's own name for it, which is what the send API takes. Unique per
  -- channel because that is what Meta enforces, and a duplicate here would
  -- make "which one did we send" unanswerable.
  name        text NOT NULL,
  language    text NOT NULL DEFAULT 'en',
  category    text,

  -- Meta's approval state, cached. `local` is for a template that exists only
  -- here - the personal-WhatsApp providers have no approval process, and their
  -- "templates" are canned replies a person picks from.
  status      text NOT NULL DEFAULT 'local'
                CHECK (status IN ('local', 'pending', 'approved', 'rejected', 'paused', 'disabled')),

  header      text,
  body        text NOT NULL,
  footer      text,
  -- Quick-reply and call-to-action buttons, as Meta returns them.
  buttons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The {{1}}, {{2}} placeholders, in order, with an example each so the
  -- composer can show what it is asking for.
  variables   jsonb NOT NULL DEFAULT '[]'::jsonb,

  meta_template_id text,
  synced_at        timestamptz,
  rejected_reason  text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One template per name+language per channel, which is Meta's own key.
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_channel_name
  ON message_templates (org_id, channel_id, name, language);
CREATE INDEX IF NOT EXISTS message_templates_org_usable
  ON message_templates (org_id, channel) WHERE status IN ('approved', 'local');

ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON message_templates
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

GRANT SELECT, INSERT, UPDATE, DELETE ON message_templates TO aura_app;
DO $do$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON message_templates FROM %I', api_role);
    END IF;
  END LOOP;
END $do$;
