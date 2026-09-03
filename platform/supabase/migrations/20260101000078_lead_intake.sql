-- 0078_lead_intake.sql - the lead intake engine: one front door per channel,
-- one write path behind all of them, one ledger over the lot.
--
-- ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────
--
-- Leads reached this platform by four unrelated routes that had nothing in
-- common but the table they eventually touched:
--
--   * the handset call pipeline (leads.ts)      -> leads + contacts + deals
--   * POST /public/leads with an API key        -> leads + contacts + deals
--   * the Meta lead-ads webhook (0063)          -> contacts + deals ONLY
--   * the Meta MCP pull (0074)                  -> leads + contacts + deals
--
-- Three consequences, all of them live today:
--
--  1. A Meta ad lead has never appeared on /owner/board or /owner/leads,
--     because those read `leads` and the webhook does not write one. See
--     meta-mcp-sync.ts's header - the pull was built to paper over exactly
--     this, and the webhook still has the hole.
--  2. `leads` has NO column saying where a row came from. An owner looking at
--     the board cannot tell an ad lead from a phone call from a CSV import,
--     so "which channel is worth the money" is unanswerable from the data.
--  3. There is no record of what ARRIVED - only of what was successfully
--     stored. A malformed webhook, a duplicate, a lead for a page nobody has
--     connected: all of it vanished into a log line. Nothing to show a tenant
--     asking "we submitted the form, where is it".
--
-- A web form, an enquiry mailbox and a CTI screen-pop had no route at all.
--
-- ── WHAT IS ADDED ───────────────────────────────────────────────────────
--
--   lead_sources          one configured inbound channel, carrying the token
--                         that IS its credential and the mapping that turns a
--                         provider payload into a lead.
--   lead_intake_events    every arrival, accepted or not, with its payload so
--                         a failure can be diagnosed and replayed.
--   linkedin_connections  per-org LinkedIn Marketing API grant, for the one
--                         channel with no webhook to receive.
--   leads.source_channel / lead_source_id / marketing_source_id
--                         provenance on the record the console renders.
--
-- ── WHY A TOKEN IN THE URL AND NOT A KEY IN A HEADER ────────────────────
--
-- Same reasoning, and the same shape, as messaging_channels.webhook_token
-- (0056): a form on a tenant website, an Exotel passthrough and a Mailgun
-- inbound route cannot present an admin key or an org header. The token is a
-- CSPRNG value, UNIQUE platform-wide, and resolving it both authenticates the
-- caller and names the tenant. An unknown token is a 404 with nothing in it.
--
-- Unlike an API key, a form token is PUBLIC by construction - it ships in the
-- HTML of the tenant own site. So it is deliberately weak and carries exactly
-- one capability: create a lead on this one source. It can read nothing. That
-- is why intake is a separate table from api_keys (0076) rather than another
-- scope on one.

-- ── lead_sources ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Which desk the lead lands on. NULL means "the org first workspace",
  -- resolved at write time - the same fallback crm-ingest.service.ts already
  -- uses, kept here so a single-workspace tenant never has to think about it.
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,

  -- CLOSED vocabulary, unlike marketing_sources.channel which is the tenant
  -- own free text. A channel here is a code path - a route, a parser, a sweep
  -- - so a new one is a deployment, and a CHECK is the honest expression of
  -- that.
  kind         text NOT NULL CHECK (kind IN (
                 'web_form', 'email', 'telephony', 'meta_ads', 'linkedin_ads', 'api')),

  name         text NOT NULL CHECK (length(btrim(name)) > 0),

  -- The vendor inside the channel: 'generic' | 'exotel' | 'knowlarity' |
  -- 'ozonetel' | 'twilio' for telephony, 'mailgun' | 'sendgrid' | 'postmark' |
  -- 'ses' | 'generic' for email. Free text validated in code against the
  -- catalogue in packages/shared/src/lead-intake.ts, for the same reason
  -- messaging_channels.provider is: onboarding a vendor is a row in a
  -- catalogue, not a migration.
  provider     text NOT NULL DEFAULT 'generic',

  -- THE CREDENTIAL. Unique platform-wide because resolution happens before an
  -- org is known - the token is what names the tenant.
  intake_token text NOT NULL,

  -- Optional shared secret for providers that sign their payloads (Twilio
  -- X-Twilio-Signature, Mailgun HMAC). Sealed with encryptSecret(), same as
  -- every other stored credential in this schema. NULL means the provider does
  -- not sign, and the token alone is the credential.
  signing_secret text,

  status       text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'paused', 'disabled')),

  -- Per-source shape: allowed browser origins for a web form, the field map
  -- that turns this provider payload into a lead, the intake address for an
  -- email source, the honeypot field name. jsonb because every channel needs a
  -- different handful and a column per channel would be a migration each time
  -- a vendor is added.
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- ── What every lead from this source inherits ────────────────────────
  -- Attribution is the entire point of the table: "this form is the Google Ads
  -- landing page" is knowledge the tenant has once, not something to re-derive
  -- per submission.
  marketing_source_id    uuid REFERENCES marketing_sources(id) ON DELETE SET NULL,
  project_id             uuid REFERENCES crm_projects(id)      ON DELETE SET NULL,
  -- Round-robin is deliberately NOT here. One named owner is a decision a
  -- person made; a rotation is a scheduling policy, and this table is not a
  -- scheduler. NULL leaves the lead unassigned, which is what the board
  -- already renders for every call lead today.
  assigned_telecaller_id uuid REFERENCES telecallers(id)       ON DELETE SET NULL,

  -- Health, so a source that quietly stopped working is visible on the page
  -- that configures it rather than in a log nobody reads. Counters, not a
  -- derived count over lead_intake_events: that table is prunable and these
  -- must survive it.
  event_count   bigint NOT NULL DEFAULT 0,
  error_count   bigint NOT NULL DEFAULT 0,
  last_event_at timestamptz,
  last_error    text,
  last_error_at timestamptz,

  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Platform-wide, not per-org: this index is what makes "resolve the token,
-- learn the tenant" a single lookup with no org context, and what stops one
-- tenant token from ever colliding with another.
CREATE UNIQUE INDEX IF NOT EXISTS lead_sources_token ON lead_sources (intake_token);
CREATE INDEX IF NOT EXISTS lead_sources_org ON lead_sources (org_id, kind, status);

-- One source per name per channel. Two things need this: a tenant with two
-- sources both called "Website" cannot tell their leads apart, and the built-in
-- connectors (Meta, LinkedIn) find-or-create their own source row by name on
-- every single lead - without a unique key that is a race that quietly produces
-- a new source per concurrent webhook delivery.
CREATE UNIQUE INDEX IF NOT EXISTS lead_sources_org_kind_name
  ON lead_sources (org_id, kind, lower(btrim(name)));

ALTER TABLE lead_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_sources FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON lead_sources
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE ON lead_sources TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON lead_sources FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON lead_sources FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER lead_sources_set_updated_at BEFORE UPDATE ON lead_sources
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── lead_intake_events ──────────────────────────────────────────────────
--
-- Both the idempotency ledger and the diagnostic record, exactly like
-- meta_leadgen_events (0063) - and generalised, because the same two jobs
-- recur for every channel. A row is written for EVERY arrival, including the
-- ones that produce no lead, which is the half meta_leadgen_events does not do
-- and the half a tenant asks about.
CREATE TABLE IF NOT EXISTS lead_intake_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- CASCADE, not SET NULL: a source is retired by setting status='disabled'
  -- (there is no delete route), so a real DELETE here is an operator removing
  -- a mistake, and its arrivals should go with it.
  source_id  uuid NOT NULL REFERENCES lead_sources(id) ON DELETE CASCADE,
  -- Denormalised so a query over the ledger never needs the join.
  channel    text NOT NULL,

  -- The provider own id for this arrival (leadgen_id, CallSid, Message-Id, a
  -- form submission id). NULL when the provider offers none - a plain browser
  -- form post has nothing stable to key on - in which case idempotency falls
  -- back to the dedupe the lead write already does on phone/email.
  external_id text,

  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,

  outcome    text NOT NULL CHECK (outcome IN
               ('created', 'updated', 'duplicate', 'rejected', 'error')),
  -- Why, in words a tenant can act on: "no phone or email in the payload",
  -- "honeypot filled", "signature mismatch". The console renders it verbatim.
  reason     text,

  lead_id    uuid REFERENCES leads(id)    ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id    uuid REFERENCES deals(id)    ON DELETE SET NULL,

  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

-- The idempotency claim. Partial, because most channels have no external id
-- and NULLs must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS lead_intake_events_external
  ON lead_intake_events (source_id, external_id)
  WHERE external_id IS NOT NULL;

-- "What has this source received lately", the console main query here.
CREATE INDEX IF NOT EXISTS lead_intake_events_source
  ON lead_intake_events (source_id, received_at DESC);
-- "Everything that failed across all sources", the health view.
CREATE INDEX IF NOT EXISTS lead_intake_events_org_outcome
  ON lead_intake_events (org_id, outcome, received_at DESC);

ALTER TABLE lead_intake_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intake_events FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON lead_intake_events
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON lead_intake_events TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON lead_intake_events FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON lead_intake_events FROM PUBLIC;

-- ── linkedin_connections ────────────────────────────────────────────────
--
-- LinkedIn is the one channel here with nothing to receive: the Marketing API
-- has no lead webhook, so leads are PULLED on a sweep, the same shape as
-- meta-mcp-sync. That needs a stored per-org grant, which is what this is.
-- Modelled on connected_accounts (0043) rather than meta_connections, because
-- LinkedIn access tokens expire in 60 days and must be refreshed.
CREATE TABLE IF NOT EXISTS linkedin_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- urn:li:organization:NNNN - the ad account whose lead forms are read.
  account_urn   text NOT NULL,
  account_name  text,

  access_token  text,
  refresh_token text,
  token_expires_at timestamptz,

  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'expired', 'revoked', 'error')),

  -- Where the last sweep got to. A timestamp rather than an opaque cursor: the
  -- lead-form-response API is queried by a submitted-at window, and a timestamp
  -- can be nudged backwards by hand to force a backfill.
  sync_cursor   timestamptz,
  last_synced_at timestamptz,
  sync_failures int NOT NULL DEFAULT 0,
  last_error    text,

  -- Which lead_sources row the pulled leads are attributed to, so LinkedIn
  -- gets the same per-source project/owner/campaign defaults every other
  -- channel has instead of a second, parallel way to configure the same thing.
  lead_source_id uuid REFERENCES lead_sources(id) ON DELETE SET NULL,

  connected_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One org per ad account, platform-wide, for the same reason
-- meta_connections_page exists: the same account reconnected by a second org
-- would silently divert the first one leads.
CREATE UNIQUE INDEX IF NOT EXISTS linkedin_connections_account
  ON linkedin_connections (account_urn) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS linkedin_connections_org ON linkedin_connections (org_id);

ALTER TABLE linkedin_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE linkedin_connections FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON linkedin_connections
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE ON linkedin_connections TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON linkedin_connections FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON linkedin_connections FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER linkedin_connections_set_updated_at BEFORE UPDATE ON linkedin_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── provenance on the record the console renders ────────────────────────
--
-- The whole engine is pointless if the board still cannot say where a card
-- came from. `source_channel` carries the closed vocabulary; `lead_source_id`
-- points at the specific configured source when there was one.
--
-- 'call', 'import' and 'manual' are in this CHECK but not in lead_sources.kind:
-- they are how a lead arrives WITHOUT a configured source, and a lead created
-- by the handset pipeline must still be able to say so.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source_channel text
    CHECK (source_channel IN (
      'call', 'web_form', 'email', 'telephony', 'meta_ads', 'linkedin_ads',
      'api', 'import', 'manual'));

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS lead_source_id uuid
    REFERENCES lead_sources(id) ON DELETE SET NULL;

-- contacts and deals already carry marketing_source_id (0057); leads did not,
-- and leads is the table the board reads. Same SET NULL reasoning as 0057:
-- retiring a campaign must never orphan the leads it produced.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS marketing_source_id uuid
    REFERENCES marketing_sources(id) ON DELETE SET NULL;

-- Contacts and deals get the channel too, so the CRM half of the product can
-- answer the same question after the A6 cutover retires `leads`.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS source_channel text
    CHECK (source_channel IN (
      'call', 'web_form', 'email', 'telephony', 'meta_ads', 'linkedin_ads',
      'api', 'import', 'manual'));
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS source_channel text
    CHECK (source_channel IN (
      'call', 'web_form', 'email', 'telephony', 'meta_ads', 'linkedin_ads',
      'api', 'import', 'manual'));

-- "This channel pipeline, newest first" - the board filtered by source.
-- Partial and carrying last_activity_at, mirroring leads_org_project (0073).
CREATE INDEX IF NOT EXISTS leads_org_source_channel
  ON leads (org_id, source_channel, last_activity_at DESC)
  WHERE source_channel IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_org_lead_source
  ON leads (org_id, lead_source_id)
  WHERE lead_source_id IS NOT NULL;

-- ── backfill ────────────────────────────────────────────────────────────
--
-- Every lead that exists today came from one of two places, and one of them is
-- knowable from a column already on the row: a first_call_id means the handset
-- pipeline produced it, and nothing else in this codebase has ever set one.
-- Everything else predates any channel that could have stamped itself, so it is
-- left NULL rather than guessed at - a wrong provenance is worse than none,
-- because a report would quietly count it.
UPDATE leads SET source_channel = 'call'
 WHERE source_channel IS NULL AND first_call_id IS NOT NULL;

UPDATE contacts SET source_channel = 'call'
 WHERE source_channel IS NULL AND first_call_id IS NOT NULL;
