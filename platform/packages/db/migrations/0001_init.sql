-- 0001_init.sql — full Phase-1 schema (design doc §4) + RLS tenancy (§2).
-- Runs as the admin/owner role. The app connects as `aura_app` (no BYPASSRLS,
-- not the owner) so ENABLE + FORCE ROW LEVEL SECURITY actually bind it.

------------------------------------------------------------------------------
-- Application role (dev password; production roles come from IaC/secrets)
------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
    CREATE ROLE aura_app LOGIN PASSWORD 'aura_app_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

CREATE TABLE organizations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  plan_id             text,
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'churned')),
  billing_customer_id text,
  retention_days      int  NOT NULL DEFAULT 90,
  consent_policy      text NOT NULL DEFAULT 'tone'
                        CHECK (consent_policy IN ('none', 'tone', 'tone_and_tts', 'prohibited')),
  on_consent_failure  text NOT NULL DEFAULT 'do_not_record'
                        CHECK (on_consent_failure IN ('record_and_flag', 'do_not_record')),
  region              text NOT NULL DEFAULT 'ap-south-1',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Platform-level humans; tenancy comes from memberships. No org_id here, so no
-- RLS — access is mediated by the auth module, never exposed raw to tenants.
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  name        text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  sso_subject text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  settings   jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('org', 'workspace')),
  scope_id   uuid NOT NULL,
  role       text NOT NULL CHECK (role IN
               ('platform_admin', 'org_admin', 'workspace_admin', 'workspace_member', 'viewer')),
  -- The two orthogonal privacy-weight permissions (design doc §3.4)
  recordings_listen bool NOT NULL DEFAULT false,
  recordings_export bool NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope_type, scope_id)
);

CREATE TABLE instances (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             text NOT NULL,
  default_agent_id uuid,
  limits           jsonb NOT NULL DEFAULT '{}',
  config_version   int  NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One-time admin/enrollment keys for the device-activation gate: generated in
-- the web app, entered (or QR-scanned) in the Android admin screen. Short TTL,
-- limited uses, only the hash is stored.
CREATE TABLE enrollment_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  max_uses    int NOT NULL DEFAULT 1,
  use_count   int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  instance_id        uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  label              text,
  public_key         text NOT NULL,
  fingerprint        text,
  os_version         text,
  app_version        text,
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'logged_out', 'wiped', 'lost')),
  capture_capability text CHECK (capture_capability IN
                       ('FULL_DUPLEX', 'NEAR_END_ONLY', 'SPEAKER_REQUIRED', 'UNSUPPORTED')),
  last_seen_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_health (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id           uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts                  timestamptz NOT NULL,
  battery_opt_exempt  bool,
  accessibility_enabled bool,
  perms               jsonb NOT NULL DEFAULT '{}',
  battery_level       int,
  pending_uploads     int,
  free_storage_mb     int,
  last_upload_at      timestamptz,
  failure_counts      jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_health_device_ts ON device_health (device_id, ts DESC);

CREATE TABLE calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  device_id          uuid NOT NULL REFERENCES devices(id),
  direction          text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  -- HMAC(per-org key) of the counterparty number; last 3 digits in clear
  remote_number_hash text,
  remote_number_last3 text,
  remote_name        text,
  source_id          text,
  started_at         timestamptz NOT NULL,
  ended_at           timestamptz,
  duration_s         int NOT NULL DEFAULT 0,
  audio_source_used  text,
  status             text NOT NULL DEFAULT 'AWAITING_AUDIO' CHECK (status IN
                       ('AWAITING_AUDIO', 'UPLOADED', 'TRANSCODING', 'TRANSCRIBING',
                        'ANALYZING', 'SYNCING', 'COMPLETE',
                        'FAILED_TRANSCODE', 'FAILED_ASR', 'FAILED_ANALYZE', 'FAILED_CRM')),
  consent_status     text NOT NULL DEFAULT 'pending'
                       CHECK (consent_status IN ('not_required', 'played', 'failed', 'pending')),
  agent_id           uuid,
  agent_version      int,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_ws_started ON calls (org_id, workspace_id, started_at DESC);
CREATE INDEX calls_status ON calls (org_id, status) WHERE status NOT IN ('COMPLETE');

CREATE TABLE recordings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id     uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  s3_key      text NOT NULL,
  bytes       bigint,
  sha256      text,
  codec       text,
  sample_rate int,
  encrypted   bool NOT NULL DEFAULT true,
  uploaded_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transcripts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id    uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  language   text,
  engine     text,           -- e.g. 'gemini-2.5-flash'
  text       text,
  segments   jsonb NOT NULL DEFAULT '[]',
  confidence real,
  diarized   bool NOT NULL DEFAULT false,
  tsv        tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcripts_fts ON transcripts USING GIN (tsv);

CREATE TABLE agents (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,
  version       int  NOT NULL DEFAULT 1,
  system_prompt text NOT NULL DEFAULT '',
  field_schema  jsonb NOT NULL DEFAULT '{"fields": []}',
  labels        jsonb NOT NULL DEFAULT '[]',
  scoring       jsonb NOT NULL DEFAULT '{}',
  crm_mapping   jsonb NOT NULL DEFAULT '{}',
  is_active     bool NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Versioned-immutable: one row per (agent id, version); editing inserts a new version
  PRIMARY KEY (id, version)
);

CREATE TABLE ai_outputs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id           uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL,
  agent_version     int  NOT NULL,
  output            jsonb NOT NULL DEFAULT '{}',
  schema_version    int,
  tokens_in         int,
  tokens_out        int,
  cost_usd          numeric(12, 6),
  provider          text,
  model             text,
  validation_status text NOT NULL DEFAULT 'valid'
                      CHECK (validation_status IN ('valid', 'repaired', 'failed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Projection of tenant-defined extraction fields so filtering/analytics never
-- need JSONB scans (design doc §4 note).
CREATE TABLE call_facts (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id    uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  field_key  text NOT NULL,
  value_text text,
  value_num  numeric,
  value_bool bool,
  PRIMARY KEY (call_id, field_key)
);
CREATE INDEX call_facts_kv ON call_facts (org_id, field_key, value_text);

CREATE TABLE crm_integrations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider     text NOT NULL,      -- 'hubspot' | 'generic_webhook'
  auth         jsonb NOT NULL DEFAULT '{}',   -- encrypted blob, never plaintext tokens
  field_map    jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'disconnected'
                 CHECK (status IN ('connected', 'disconnected', 'error')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm_sync_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id        uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES crm_integrations(id) ON DELETE CASCADE,
  status         text NOT NULL CHECK (status IN ('pending', 'synced', 'failed')),
  external_id    text,
  error          text,
  attempts       int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Durable usage ledger (Redis is the fast path; this is the truth — §10)
CREATE TABLE usage_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid,
  kind         text NOT NULL,   -- calls | minutes | storage_gb | tokens_in | tokens_out | ...
  quantity     numeric NOT NULL,
  unit         text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  ref_id       uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_org_time ON usage_events (org_id, occurred_at DESC);

-- Append-only (UPDATE/DELETE revoked from aura_app below)
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_type  text NOT NULL,   -- user | device | api_key | system
  actor_id    text NOT NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  ip          text,
  meta        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_org_time ON audit_log (org_id, created_at DESC);

------------------------------------------------------------------------------
-- updated_at triggers
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

------------------------------------------------------------------------------
-- Row-Level Security — org isolation on every tenant table (§2).
-- current_setting('app.org_id', true) is NULL when unset → default deny.
------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspaces', 'memberships', 'instances', 'enrollment_tokens', 'devices',
    'device_health', 'calls', 'recordings', 'transcripts', 'agents',
    'ai_outputs', 'call_facts', 'crm_integrations', 'crm_sync_log',
    'usage_events', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I
         USING (org_id = current_setting(''app.org_id'', true)::uuid)
         WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
  END LOOP;
END $$;

-- organizations: a tenant can only see its own row
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_self ON organizations
  USING (id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (id = current_setting('app.org_id', true)::uuid);

------------------------------------------------------------------------------
-- Grants for the app role
------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO aura_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO aura_app;
-- Append-only surfaces
REVOKE UPDATE, DELETE ON audit_log FROM aura_app;
REVOKE UPDATE, DELETE ON usage_events FROM aura_app;
-- Migration bookkeeping stays admin-only
REVOKE ALL ON schema_migrations FROM aura_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aura_app;
