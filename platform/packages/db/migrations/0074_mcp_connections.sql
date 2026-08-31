-- 0074_mcp_connections.sql - an MCP server a tenant has connected, and the
-- leads pulled through it.
--
-- ── WHY A SEPARATE TABLE FROM connected_accounts (0043) ─────────────────
--
-- `connected_accounts` is per-USER and per-mailbox: a rep connects their own
-- Google account, and its `capabilities` are the closed pair email|calendar.
-- An MCP server is none of those things. It is per-ORG (the tenant's Meta ad
-- account, not one rep's), it has no account_email to key on, its capability
-- is "whatever tools it advertises" rather than a fixed enum, and it carries
-- state connected_accounts has nowhere to put: the server's advertised tool
-- list and the sync cursor. Overloading that table would mean four nullable
-- columns and a capability enum that stops meaning anything.
--
-- ── WHY NOT FOLD IT INTO meta_connections (0063) ────────────────────────
--
-- Because it is not Meta-specific. `provider` is free text, validated in the
-- app, exactly like connected_accounts.provider and marketing_sources.channel
-- - so the second MCP server a tenant connects is a row, not a migration.
-- Meta is simply the first one that has a consumer written for it.

CREATE TABLE IF NOT EXISTS mcp_connections (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Which integration this server backs ('meta' today). App-validated, no
  -- CHECK - same call 0043 made for connected_accounts.provider.
  provider     text NOT NULL,
  -- The tenant's own name for it, when they run more than one.
  label        text,

  -- The MCP endpoint. Every outbound request to it goes through
  -- assertPublicHttpUrl first (packages/db/src/ssrf-guard.ts): this column is
  -- tenant-supplied and points the server at a URL of the caller's choosing,
  -- which is the textbook SSRF shape.
  server_url   text NOT NULL,

  -- Sealed with AES-256-GCM by encryptSecret, like every other stored
  -- credential here. Never returned by any read endpoint.
  access_token text,

  status       text NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'error', 'revoked')),
  -- Why it last failed, so the console can say something better than "error".
  last_error   text,

  -- What the server said about itself at `initialize`, and the tools it
  -- advertised at `tools/list`. Cached so the console can show what a
  -- connection can actually do without a round trip on every page load, and
  -- so a server that silently drops a tool is visible as a diff.
  server_info  jsonb NOT NULL DEFAULT '{}'::jsonb,
  tools        jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Sync bookkeeping. `cursor` is opaque and provider-defined - a timestamp
  -- for one server, a page token for another - so it is text, not a typed
  -- column that would only fit whichever provider was written first.
  last_sync_at timestamptz,
  cursor       text,

  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One live connection per provider per org. Partial on status so a revoked
-- connection stays on the table as history without blocking a reconnect.
CREATE UNIQUE INDEX IF NOT EXISTS mcp_connections_org_provider
  ON mcp_connections (org_id, provider) WHERE status <> 'revoked';

ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON mcp_connections
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_connections TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON mcp_connections FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON mcp_connections FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER mcp_connections_set_updated_at BEFORE UPDATE ON mcp_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the lead-ads ledger learns about `leads` and about MCP ──────────────
--
-- `meta_leadgen_events` (0063) already has the unique `leadgen_id` that makes
-- ingestion idempotent, and that property is exactly what a PULL needs too -
-- a sweep that re-reads an overlapping window must not create the lead twice.
-- So the MCP path reuses this table rather than growing a parallel one with
-- the same unique index on it.
--
-- `source` records which path a row arrived by. Without it, a tenant running
-- both the webhook and the MCP sweep has no way to tell whether the pull is
-- actually doing anything, or whether the push was already covering it.
ALTER TABLE meta_leadgen_events
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'webhook'
    CHECK (source IN ('webhook', 'mcp'));

-- THE GAP THIS CLOSES. 0063 created a contact and a deal for every Meta lead
-- and no `leads` row - but the owner console's board and list read `leads`,
-- not deals (the A6 cutover has not happened). So every Meta lead ever
-- captured has been invisible on the two pages an owner actually works in.
-- Recording the lead here lets the ingest path stay idempotent about it.
ALTER TABLE meta_leadgen_events
  ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES leads(id) ON DELETE SET NULL;

-- Which connection pulled it, so a disconnect can be reasoned about.
ALTER TABLE meta_leadgen_events
  ADD COLUMN IF NOT EXISTS mcp_connection_id uuid
    REFERENCES mcp_connections(id) ON DELETE SET NULL;

-- The sweep's own question: "what have I already got for this page?"
CREATE INDEX IF NOT EXISTS meta_leadgen_events_org_processed
  ON meta_leadgen_events (org_id, processed_at DESC);

-- No new GRANT needed: 0063 already gave aura_app UPDATE on this table (the
-- webhook stamps `raw`/`contact_id`/`deal_id` back onto the claimed row after
-- fetching), and the pull path stamps `lead_id` the same way.
