-- 0063_meta_lead_ads.sql — Kailash gap Milestone 4, part 1: inbound Facebook/
-- Instagram Lead Ads capture. Targets contacts/deals directly, NOT the legacy
-- `leads` table — `leads` is structurally call-centric (FKs to calls/devices/
-- agents, telecaller attribution), and a Meta lead has none of that.
-- contacts/deals already support a NULL source_lead_id/first_call_id for
-- exactly this "created by an inbound integration, not a call" case.

CREATE TABLE IF NOT EXISTS meta_connections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  page_id             text NOT NULL,
  page_name           text,
  access_token        text,
  connected_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'revoked')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- A Page can only ever belong to one org's connection at a time — the same
-- Page reconnected by a different org would otherwise silently steal its leads.
CREATE UNIQUE INDEX IF NOT EXISTS meta_connections_page ON meta_connections (page_id) WHERE status = 'connected';
CREATE INDEX IF NOT EXISTS meta_connections_org ON meta_connections (org_id);

ALTER TABLE meta_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_connections FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON meta_connections
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE ON meta_connections TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON meta_connections FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON meta_connections FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER meta_connections_set_updated_at BEFORE UPDATE ON meta_connections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotent claim ledger. UNLIKE payment_webhook_events (0060), this one IS
-- org-scoped and RLS'd: the webhook only uses the admin pool for the single
-- lookup that RESOLVES org_id from page_id (untrusted, in the payload,
-- exactly like messaging-webhook.controller.ts resolves a channel's org
-- before anything else runs) — the actual claim-and-insert then happens
-- inside that org's own RLS context, same as every other CRM write.
CREATE TABLE IF NOT EXISTS meta_leadgen_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  leadgen_id   text NOT NULL,
  page_id      text NOT NULL,
  form_id      text,
  raw          jsonb NOT NULL,
  contact_id   uuid REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id      uuid REFERENCES deals(id) ON DELETE SET NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS meta_leadgen_events_unique ON meta_leadgen_events (leadgen_id);

ALTER TABLE meta_leadgen_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_leadgen_events FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON meta_leadgen_events
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT ON meta_leadgen_events TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON meta_leadgen_events FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON meta_leadgen_events FROM PUBLIC;
