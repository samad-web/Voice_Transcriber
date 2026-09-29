-- 0145 - Inviting a superadmin, accepted with Google (doc 34 Part C).
--
-- WHY NOT org_invites. The 0137 invite machinery is tenant-scoped in its bones:
-- `org_invites.org_id` is `uuid NOT NULL REFERENCES organizations(id)`, and every
-- read in InvitesService goes through `db.withOrg(orgId, ...)` to set the RLS
-- context. A superadmin belongs to no organization, so there is no org to point
-- the column at and none to set a context with.
--
-- Making that column nullable was the alternative and is worse: it would put a
-- row granting PLATFORM-WIDE authority into a table whose every policy assumes a
-- non-null tenant, and one mistaken policy away from a customer reading it.
--
-- WHAT THIS REPLACES. Onboarding a superadmin was: the root appoints an address
-- (platform_operators, 0089), then presses "create login", and the API returns a
-- generated password shown exactly once for the root to pass on by hand. The
-- operators page said so in as many words - "sign-in is email and password, with
-- no magic link and no forgotten-password mail". Google sign-in has worked for a
-- while and `isOperator` never cared how a session was created; only the
-- invitation was missing.
--
-- The password path STAYS (POST :email/login, :email/password). Google may be
-- unreachable, `googleSignInEnabled()` may be false on a deployment, and those
-- two endpoints are this console's only recovery.

CREATE TABLE IF NOT EXISTS platform_operator_invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Lowercased by CHECK, exactly as platform_operators.email is, and for the
  -- same reason: acceptance compares against the address GoTrue reports, and a
  -- case mismatch would present as a valid invite being refused with nothing in
  -- any log to say why.
  email            text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  -- Carried onto the platform_operators row on acceptance, so the standing
  -- privilege records why it was granted rather than only that it was.
  note             text,
  -- The token is never stored. Only its hash, so a database read cannot be
  -- turned into a working invite link.
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  -- Free text, not a FK: the granter is the root operator, identified by an
  -- email, and platform staff have no row anywhere to point at. Same reasoning
  -- as platform_operators.added_by.
  invited_by       text NOT NULL,
  -- When the platform mailed it. NULL = the root copied the link instead, which
  -- is the only option when SMTP is unconfigured.
  emailed_at       timestamptz,
  -- The GoTrue user the invite page pre-created, so a deployment with sign-ups
  -- switched off can still let this one person in. Revoking an unaccepted invite
  -- deletes it again.
  prepared_subject uuid,
  accepted_at      timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE platform_operator_invites IS
  'Pending superadmin invitations (doc 34 Part C). Accepting one inserts into platform_operators; this table is not itself an authorization.';

-- One LIVE invite per address. Partial, so a spent or revoked invite does not
-- block inviting the same person again later - which is the ordinary case after
-- somebody leaves and returns, or after a link expires unused.
CREATE UNIQUE INDEX IF NOT EXISTS platform_operator_invites_live
  ON platform_operator_invites (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Looking an invite up by its token is the hot path on the public accept route.
CREATE INDEX IF NOT EXISTS platform_operator_invites_token
  ON platform_operator_invites (token_hash);

-- REVOKE first, GRANT second. A GRANT-only migration in a database the Supabase
-- API roles can already reach narrows nothing - see 0075, 0081 and 0089 on the
-- same trap. `anon` is the public web key, and a row here is one acceptance away
-- from administering every tenant on the platform, so it belongs with
-- platform_operators as among the last tables those roles should see.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON platform_operator_invites FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON platform_operator_invites FROM PUBLIC;

-- `aura_app` is the application's RLS-bound login and has no business here:
-- every read and write goes through the admin pool, exactly as platform_operators
-- does, because this table has no tenant context to be scoped by.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
    EXECUTE 'REVOKE ALL ON platform_operator_invites FROM aura_app';
  END IF;
END $$;
