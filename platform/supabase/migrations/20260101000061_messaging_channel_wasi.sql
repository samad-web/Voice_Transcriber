-- 0061_messaging_channel_wasi.sql — Kailash gap Milestone 3: wiring Aura up
-- to Wasi (the user's own WhatsApp Business Solution Provider platform,
-- `C:\Users\mas20\Desktop\work\Wasi`) as a Hub API client, rather than
-- integrating Meta's Cloud API directly. `messaging_channels.provider` (0056)
-- was already designed for exactly this — "a second provider is a row, not a
-- migration" — so a Wasi channel is `provider = 'wasi'` with its `client_id`
-- in the existing `config` jsonb, `api_base_url` = Wasi's host, `api_key` =
-- the Hub API key (already encrypted by the existing column). The ONE
-- genuinely new thing is below.

-- Wasi signs its inbound webhook deliveries (message.received/message.status/
-- message_template_status_update/account_update) with
-- `x-wasi-signature-256: sha256=<hmac>`, keyed by a per-WABA secret minted
-- when a Sirah-team admin configures "CRM Inbound Forwarding" on that
-- client's Wasi admin page (`POST /api/admin/clients/:id/hub-forward`). There
-- is no self-serve retrieval or rotation of that secret on Wasi's side, so it
-- is entered here once, by hand, the same way `api_key` is — encrypted with
-- the same `encryptSecret()`.
ALTER TABLE messaging_channels
  ADD COLUMN IF NOT EXISTS forward_secret text;

-- `message_template_status_update` and `account_update` forward Meta's raw
-- payload verbatim (see wasi.ts) — there is no existing table shaped to hold
-- "a WABA's template got paused" or "the account was restricted", and
-- inventing a reaction for either before a real one has ever been seen would
-- be guessing. Logged here, surfaced later; NOT acted on automatically, so
-- landing this doesn't touch any of the three safety rules.
CREATE TABLE IF NOT EXISTS messaging_channel_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  messaging_channel_id uuid NOT NULL REFERENCES messaging_channels(id) ON DELETE CASCADE,
  event               text NOT NULL,
  payload             jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messaging_channel_events_channel
  ON messaging_channel_events (messaging_channel_id, created_at DESC);

ALTER TABLE messaging_channel_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_channel_events FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON messaging_channel_events
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT ON messaging_channel_events TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON messaging_channel_events FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON messaging_channel_events FROM PUBLIC;
