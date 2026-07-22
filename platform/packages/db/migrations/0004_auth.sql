-- 0004_auth.sql — real session auth + RBAC groundwork (checklist §2.2).
-- Dev credential login (password_hash) stands in for the OIDC identity source;
-- swapping to OIDC later only changes how a user is identified at /auth/login,
-- not the session/role/permission model below.

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_token_hash ON sessions (token_hash);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON sessions
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO aura_app;
