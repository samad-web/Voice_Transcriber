-- 0137_org_invites.sql - invite a colleague by link; they finish by signing in
-- with Google.
--
-- ── WHY A TABLE AND NOT A SUPABASE INVITE ──────────────────────────────────
--
-- GoTrue has its own `/invite`, but it mails a magic link from GoTrue's SMTP
-- (not configured here), it has no idea which workspace or persona the person
-- was invited AS, and it signs them straight in on click - so the tenant
-- binding would have to be guessed afterwards. This row IS that binding,
-- decided by the owner at invite time and applied only when the person comes
-- back through Google holding the token.
--
-- ── THE TOKEN IS NEVER STORED ──────────────────────────────────────────────
--
-- `token_hash` is SHA-256 of a 256-bit random token (invite-token.ts). The raw
-- token exists in exactly two places: the link shown to the owner once, and
-- the invitee's inbox. A read of this table - a backup, a support query, an
-- injection - yields nothing that opens an invite. SHA-256 rather than a slow
-- hash because the input is 256 bits of randomness, not a password: there is
-- no dictionary to slow down.
--
-- ── WHAT MAKES ONE UNUSABLE ────────────────────────────────────────────────
--
-- Any of: `expires_at` in the past, `accepted_at` set (single use),
-- `revoked_at` set (the owner withdrew it, or re-sent it - a resend revokes the
-- old row and writes a new one, so an old link stops working the moment a new
-- one exists). The partial unique index keeps it to one live invite per
-- address per workspace, so there is never a question of which one counts.
--
-- ── BOUND TO THE ADDRESS ───────────────────────────────────────────────────
--
-- Acceptance requires the Google account's verified email to equal `email`.
-- A forwarded or leaked link therefore lets nobody in but the person it was
-- addressed to. Stored lower-cased (CHECK below) so that comparison is exact.

CREATE TABLE IF NOT EXISTS org_invites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email             text NOT NULL,
  name              text,
  -- The console persona and the tenant role, exactly as `createLogin` takes
  -- them. No CHECK on owner_role: memberships_owner_role_check (0079) already
  -- refuses a bad value at acceptance, and a second copy of that list here is
  -- one more thing to drift.
  owner_role        text NOT NULL,
  tenant_role       text NOT NULL,
  telecaller_id     uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  recordings_listen boolean NOT NULL DEFAULT false,
  recordings_export boolean NOT NULL DEFAULT false,
  phone             text,
  whatsapp_number   text,
  token_hash        text NOT NULL UNIQUE,
  expires_at        timestamptz NOT NULL,
  invited_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  -- When the platform mailed it (null = the owner copied the link instead).
  emailed_at        timestamptz,
  -- The GoTrue user the invite page pre-created so a deployment with sign-ups
  -- switched off can still let this one person in. Revoking an invite nobody
  -- accepted deletes it again (invites.service.ts).
  prepared_subject  text,
  accepted_at       timestamptz,
  accepted_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT org_invites_email_lower CHECK (email = lower(email)),
  CONSTRAINT org_invites_expiry_after_create CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS org_invites_one_live
  ON org_invites (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS org_invites_org_created
  ON org_invites (org_id, created_at DESC);

ALTER TABLE org_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_invites FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON org_invites
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON org_invites TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON org_invites FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON org_invites FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER org_invites_set_updated_at BEFORE UPDATE ON org_invites
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
