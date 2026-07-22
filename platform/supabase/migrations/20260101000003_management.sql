-- 0003_management.sql — management + metering surfaces (checklist §2).
-- API keys (hashed, prefix-displayed) + per-call notes. Runs as the admin/owner
-- role; the app connects as `aura_app` so ENABLE + FORCE ROW LEVEL SECURITY
-- actually bind it. Mirrors 0001's tenancy pattern exactly.

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

-- Programmatic access keys. Only the sha256 hash is ever stored; `prefix` is a
-- 12-char display fragment so the UI can show which key is which. The raw key
-- is returned exactly once at creation, never retrievable again.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         text,
  key_hash     text NOT NULL,
  prefix       text NOT NULL,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_org ON api_keys (org_id, created_at DESC);

-- Free-text notes attached to a call by a reviewer.
CREATE TABLE call_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id    uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  body       text NOT NULL,
  author     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_notes_call ON call_notes (call_id, created_at DESC);

------------------------------------------------------------------------------
-- Row-Level Security — org isolation on the new tenant tables (§2), identical
-- to 0001. current_setting('app.org_id', true) is NULL when unset → default deny.
------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys', 'call_notes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I
         USING (org_id = current_setting(''app.org_id'', true)::uuid)
         WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
  END LOOP;
END $$;

------------------------------------------------------------------------------
-- Grants for the app role
------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys, call_notes TO aura_app;
