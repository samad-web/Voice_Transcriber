-- 0009_crm_connectors.sql - turn the webhook dispatcher into a CRM connector engine.
--
-- 0008 made the request configurable: endpoint, auth scheme, headers, field
-- map. That is enough for a webhook, and not enough for a CRM. Real targets
-- need three more things:
--
--   1. A URL that depends on the tenant. Salesforce posts to the org's own
--      My Domain host, Zoho to whichever data centre the account lives in,
--      Pipedrive to <company>.pipedrive.com. `config` holds those values and
--      `endpoint` becomes a template that interpolates them.
--
--   2. A body that isn't the flat map. HubSpot wants {properties:{…}}, Zoho
--      {data:[{…}]}, LeadSquared an array of Attribute/Value pairs, monday a
--      GraphQL document. `body_template` describes that shape once per target
--      instead of once per code branch.
--
--   3. Credentials that aren't a bearer token. Zoho signs with
--      "Zoho-oauthtoken <t>", Freshsales with "Token token=<k>", Close with
--      HTTP Basic, Pipedrive with a query parameter. auth_type widens and
--      auth_prefix carries the literal.
--
-- Plus `id_path`, so the id the CRM assigns to the record it just created is
-- captured into crm_sync_log.external_id rather than thrown away - without it
-- there is no way to answer "which lead did this call become?".

-- ── 1. Connector configuration ────────────────────────────────────────
ALTER TABLE crm_integrations
  -- Operator-facing name. Two HubSpot integrations on one workspace (one for
  -- contacts, one for call logging) are otherwise indistinguishable in a list.
  ADD COLUMN IF NOT EXISTS label text,
  -- Which object of the provider this writes: 'lead', 'contact', 'activity'.
  ADD COLUMN IF NOT EXISTS target text,
  ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'POST',
  -- Non-secret per-tenant values interpolated into endpoint/headers/body.
  -- Shown in the console; anything sensitive belongs in auth_secret instead.
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- NULL = send the mapped object flat, which is what a plain webhook wants.
  ADD COLUMN IF NOT EXISTS body_template jsonb,
  -- Dotted path to the created record's id in the response, array indices
  -- allowed: Zoho answers data.0.details.id.
  ADD COLUMN IF NOT EXISTS id_path text,
  -- Key names when body_template uses "$fieldsPairs" (LeadSquared).
  ADD COLUMN IF NOT EXISTS pair_keys text[],
  -- Literal prefix for auth_type = 'header_prefix'.
  ADD COLUMN IF NOT EXISTS auth_prefix text NOT NULL DEFAULT '',
  -- Health, so the console can show state without scanning the outbox.
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

-- Widened from (none, bearer, header). basic and query are how Close and
-- Pipedrive authenticate; header_prefix covers Zoho and Freshsales.
ALTER TABLE crm_integrations DROP CONSTRAINT IF EXISTS crm_integrations_auth_type_check;
ALTER TABLE crm_integrations
  ADD CONSTRAINT crm_integrations_auth_type_check
  CHECK (auth_type IN ('none', 'bearer', 'header', 'header_prefix', 'basic', 'query'));

DO $$ BEGIN
  ALTER TABLE crm_integrations
    ADD CONSTRAINT crm_integrations_method_check
    CHECK (method IN ('POST', 'PUT', 'PATCH'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Existing rows are all generic webhooks: flat body, POST, no target object.
UPDATE crm_integrations
   SET target = COALESCE(target, 'post'),
       label  = COALESCE(label, initcap(replace(provider, '_', ' ')))
 WHERE target IS NULL OR label IS NULL;

-- The drain joins on this; a workspace with many integrations shouldn't scan.
CREATE INDEX IF NOT EXISTS crm_integrations_workspace_status
  ON crm_integrations (workspace_id, status);

-- ── 2. Delivery log ───────────────────────────────────────────────────
-- Which target produced this delivery. An integration can be re-pointed from
-- Leads to Contacts, and old rows must keep describing what actually happened.
ALTER TABLE crm_sync_log
  ADD COLUMN IF NOT EXISTS target text,
  -- Endpoint actually called, after template interpolation. The single most
  -- useful field when a delivery 404s and the config looks fine.
  ADD COLUMN IF NOT EXISTS request_url text;

-- Console queries the log per integration, newest first.
CREATE INDEX IF NOT EXISTS crm_sync_log_integration_recent
  ON crm_sync_log (integration_id, updated_at DESC);

-- ── 3. Credentials at rest (§2.5) ─────────────────────────────────────
-- auth_secret now holds "v1.gcm:<iv>:<tag>:<ciphertext>" when CRM_SECRET_KEY
-- is configured. The column stays text and the prefix is self-describing, so
-- rows written before this migration decrypt as themselves and are sealed the
-- next time they are saved - no backfill, no downtime.
COMMENT ON COLUMN crm_integrations.auth_secret IS
  'AES-256-GCM sealed credential (v1.gcm:iv:tag:ct) when CRM_SECRET_KEY is set; '
  'plaintext for rows written before 0009. Never returned by the API.';

COMMENT ON COLUMN crm_integrations.config IS
  'Non-secret per-tenant values interpolated into endpoint/headers/body. '
  'Readable by the console - do not put credentials here.';
