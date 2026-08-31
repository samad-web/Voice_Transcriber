-- 0056_messaging_channels.sql - per-org messaging identities.
--
-- ── WHY THIS HAD TO COME FIRST ──────────────────────────────────────────
--
-- 0055 gave every org an inbox. Nothing could arrive in it. Every message
-- this platform has ever sent goes through ONE Evolution instance configured
-- at the process level (EVOLUTION_BASE_URL / EVOLUTION_API_KEY) on behalf of
-- the platform's own funnel, and `organizations` carries no messaging columns
-- at all. So an inbound reply had no org to belong to, and an org-scoped
-- conversation had no way to be reached.
--
-- This is that missing half: the number/address a tenant receives on, the
-- credentials to answer with, and - the part that actually does the work - a
-- routing key that turns an anonymous webhook POST into a known tenant.
--
-- ── HOW A WEBHOOK FINDS ITS TENANT ──────────────────────────────────────
--
-- By `webhook_token`, carried in the URL path, not by the receiving number.
--
-- Routing on the number is the obvious idea and it is wrong twice over.
-- Providers disagree on whether the receiving address is even reported and in
-- what shape (Evolution reports a JID, Twilio an E.164, a mail relay an
-- envelope recipient that may be an alias), so the one field the routing
-- depends on is the least reliable one in the payload. And a number is
-- public - anyone who knows a tenant's WhatsApp number could POST messages
-- into their inbox. A token identifies AND authenticates in the same lookup.
--
-- `inbound_address` is still stored and still UNIQUE across the platform,
-- because a number genuinely belongs to one tenant, and a second org claiming
-- it should collide loudly at configuration time rather than quietly steal
-- traffic later.
--
-- ── THE LOOKUP DELIBERATELY BYPASSES RLS ────────────────────────────────
--
-- Resolving the token is the step that DECIDES the org, so it cannot itself
-- run inside an org context - the same bootstrap-shaped exception
-- DbService.adminPool() documents for enrollment-token lookup. Everything
-- after the token resolves runs under withOrg() like any other write. The
-- table still carries full RLS below so that ordinary console reads of it are
-- tenant-isolated in the normal way.

CREATE TABLE IF NOT EXISTS messaging_channels (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE SET NULL,

  channel         text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  -- 'evolution' today; the column exists so a second provider is a row, not a
  -- migration. Deliberately not a CHECK: the set of providers is expected to
  -- grow and is validated in the API against a shared zod enum, the same way
  -- crm_connectors handles its own provider list.
  provider        text NOT NULL,

  -- The address this tenant receives on: E.164 for phone channels, lower-cased
  -- address for email. UNIQUE platform-wide, not per-org - see header.
  inbound_address text NOT NULL,
  display_name    text,

  -- The routing + authentication key in the webhook URL. UNIQUE and generated
  -- with a CSPRNG by the API; never derived from anything guessable such as
  -- the org id or the number.
  webhook_token   text NOT NULL,

  -- Sealed by encryptSecret() (packages/db/src/secrets.ts, AES-256-GCM under
  -- CRM_SECRET_KEY) - the same envelope connected_accounts and the CRM
  -- connectors' API keys already use. RLS does not protect a stolen dump, so
  -- the value at rest is ciphertext regardless of who can SELECT it.
  api_key         text,
  api_base_url    text,
  -- Non-secret per-channel settings: the Evolution instance name, a sender
  -- id, whatever the next provider needs. jsonb so a provider-specific field
  -- is not a schema change.
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 'disabled' stops the webhook accepting for this channel without deleting
  -- the history hanging off it.
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled')),

  -- Observability for the thing that fails silently: a provider misconfigured
  -- three months ago looks identical to a quiet week until someone asks.
  last_inbound_at timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT messaging_channels_address_unique UNIQUE (inbound_address, channel),
  CONSTRAINT messaging_channels_token_unique   UNIQUE (webhook_token)
);

CREATE INDEX IF NOT EXISTS messaging_channels_org
  ON messaging_channels (org_id, channel);

ALTER TABLE messaging_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_channels FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON messaging_channels
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON messaging_channels TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON messaging_channels FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON messaging_channels FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER messaging_channels_set_updated_at BEFORE UPDATE ON messaging_channels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Which channel a conversation arrived on ─────────────────────────────
-- Nullable: 0055's rows predate this, and a thread created by hand from the
-- console has no channel row behind it. SET NULL rather than CASCADE - losing
-- the configuration must not delete the correspondence.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS messaging_channel_id uuid
    REFERENCES messaging_channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_messaging_channel
  ON conversations (messaging_channel_id) WHERE messaging_channel_id IS NOT NULL;
