-- 0163_partner_portal_access.sql - how a partner signs in, and the wall that
-- stands between a partner principal and the rest of the tenant
-- (Build docs/39, §17-§19).
--
-- 0162 built the three tables and the second RLS axis over them. This one
-- answers the two questions that axis leaves open:
--
--   1. How does a human BECOME a partner principal, without a second identity
--      system? (`partner_invites`, plus the constraint that makes "has
--      partner_users, no memberships" a database fact rather than a convention.)
--
--   2. What stops that principal reading everything ELSE? (The wall.)
--
-- ── (2) IS THE ONE THAT MATTERS, AND §17 DOES NOT ADDRESS IT ───────────────
--
-- `withPartnerContext` sets `app.org_id` as well as `app.partner_id` - it has
-- to, because `partners`, `partner_users` and `partner_submissions` are all
-- org-scoped and their `org_isolation` policy is what makes them readable at
-- all. But `app.org_id` is the ONLY key every other tenant table is isolated
-- on. So inside a partner's transaction, `leads`, `contacts`, `calls`,
-- `recordings`, `transcripts`, `memberships`, `invoices` and another hundred
-- tables are all wide open to a `SELECT`, and the only thing standing between a
-- broker and the tenant's entire pipeline is that nobody wrote the query.
--
-- "Nobody wrote the query" is not a boundary. It is the state the code happens
-- to be in this afternoon, and the first portal screen that joins one table too
-- many turns it into a breach that no test, no guard and no type check would
-- notice, because every one of those tables answers perfectly legitimately
-- under the org id it was given.
--
-- So the default is inverted. Every public table carrying an `org_id` gets a
-- RESTRICTIVE policy that empties it the instant `app.partner_id` is set, and
-- the exceptions are enumerated here, in four lines, where they can be read:
--
--      partners, partner_users, partner_submissions   0162's own axis
--      commission_plans                               the partner's own rate
--
-- Everything else: nothing, for a partner, forever. A later screen that needs a
-- fifth table has to come back here and say so out loud.
--
-- ── WHY THIS CANNOT BREAK ANYTHING THAT EXISTS ─────────────────────────────
--
-- `app.partner_id` is set by exactly one function in the codebase
-- (`withPartnerContext`), which did not exist before 0162 and is called only
-- from `apps/api/src/modules/partners/`. For every other caller - the console,
-- the handset, the worker, the migrate job, psql - the setting is unset, the
-- restrictive predicate is TRUE, and these policies are a no-op that the
-- planner folds away once per query. The blast radius of this block is exactly
-- the portal, which is the point.
--
-- ── WHAT IS NOT WALLED, AND WHY ────────────────────────────────────────────
--
-- `organizations` and `users` carry no `org_id` and are therefore outside the
-- enumeration below.
--
--   organizations - deliberately left reachable. It already has `org_self`
--     (0001), which limits a partner to the single row of the tenant whose
--     portal they are in, and that row is where the portal's branding and the
--     workspace's name come from (§19: "tenant branding from 0126"). Walling it
--     would make the portal unable to say whose portal it is.
--
--   users - NOT walled, and this is the one gap in this migration. The table has
--     never had RLS at all, so closing it means ENABLE + FORCE + a permissive
--     `USING (true)` to preserve every existing caller + the restrictive wall -
--     turning row security on, for the first time in this schema's life, on the
--     table every authentication path reads, in a phase that cannot be verified
--     against a database (Docker is off here and .env points at production).
--     That is a worse risk than the one it removes. The portal's own queries
--     bind `users.id` to the partner's resolved user and read nothing else;
--     closing this properly belongs in a change that can be run against a real
--     container first.

-- ── 1. partner_invites ──────────────────────────────────────────────────────
--
-- A separate table from `org_invites` (0137), and NOT a `partner_id` column on
-- it. Doc 39 §18 says to reuse the live invite flow, and this does reuse all of
-- it that can be reused - Supabase auth, Google sign-in, the same 43-character
-- token and its sha256, the same `assertInvitePending` / `assertMayAcceptInvite`
-- rules, the same `users` row at the end. What it does not reuse is the TABLE,
-- for a reason that is a security property rather than a preference:
--
--   `AuthInvitesController.accept` (apps/api/src/modules/owner/auth-invites
--   .controller.ts) dispatches on which table holds the token, and the org
--   branch ends in `INSERT INTO memberships`. A partner invite living in
--   `org_invites` would be indistinguishable to that route, so anybody who
--   pasted a partner's token into the staff accept endpoint would be made a
--   MEMBER of the tenant - a broker with a console login - and the request
--   would answer 200.
--
-- Doc 34 reached the same conclusion for the same reason and built
-- `platform_operator_invites` (0145) rather than widening `org_invites` with a
-- nullable org. A token is opaque and says nothing about its own kind; which
-- table holds it is the only honest answer to "what does this grant".
--
-- Unlike 0145's table this one IS org-scoped - a partner belongs to exactly one
-- tenant - so it takes the standard RLS footer and needs no verify-rls
-- allowlist entry.

CREATE TABLE IF NOT EXISTS partner_invites (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id       uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- Lower-cased by CHECK, as org_invites and platform_operators both are, and
  -- for the same reason: acceptance compares against the address GoTrue
  -- reports, and a case mismatch presents as a valid invite being refused with
  -- nothing in any log to say why.
  email            text NOT NULL,
  name             text,
  -- The partner-side role the acceptance grants. Same two values
  -- partner_users.role takes; no CHECK listing them twice, because
  -- partner_users_role_check refuses a bad one at acceptance and a second copy
  -- of that list here is one more thing to drift.
  role             text NOT NULL DEFAULT 'member',
  -- Never the token, only its hash: a database read cannot be turned back into
  -- a working invite link.
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  invited_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- When the platform mailed it (null = whoever invited copied the link).
  emailed_at       timestamptz,
  -- The GoTrue user the invite page pre-created, so a deployment with sign-ups
  -- switched off can still let this one person in. Revoking an unaccepted
  -- invite deletes it again.
  prepared_subject text,
  accepted_at      timestamptz,
  accepted_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_invites_email_lower CHECK (email = lower(btrim(email)) AND email <> ''),
  CONSTRAINT partner_invites_expiry_after_create CHECK (expires_at > created_at)
);

-- One LIVE invite per address per partner. Partial, so a spent or revoked
-- invite does not block inviting the same person again later.
CREATE UNIQUE INDEX IF NOT EXISTS partner_invites_live
  ON partner_invites (partner_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- The accept route's lookup, and the only index that is on a hot path.
CREATE INDEX IF NOT EXISTS partner_invites_token ON partner_invites (token_hash);
CREATE INDEX IF NOT EXISTS partner_invites_org ON partner_invites (org_id, created_at DESC);

COMMENT ON TABLE partner_invites IS
  'Pending channel-partner portal invitations (doc 39 §18). Deliberately NOT org_invites: that '
  'table''s accept path ends in INSERT INTO memberships, which is exactly what a partner must '
  'never get. Accepting one inserts into partner_users.';

-- ── 2. A partner is not a member, and a member is not a partner ────────────
--
-- `contextFor`-style principal resolution turns on exactly one predicate: has a
-- `partner_users` row, has NO `memberships` row in the same org. Everything
-- downstream - which guard admits the request, which context helper runs, which
-- GUC gets set, which half of the RLS model applies - hangs off that one
-- answer, so a person who satisfied both halves at once would be a principal
-- the system has no defined behaviour for. The resolver would have to pick, and
-- whichever way it picked would be wrong for somebody.
--
-- Worse, the two shapes have opposite blast radii. A broker who also holds a
-- membership can sign into /owner and read the pipeline the whole portal design
-- exists to keep from them; a staff member who also holds a `partner_users` row
-- would have their own console narrowed to one broker's submissions. Neither is
-- a state anybody would choose and neither would be noticed quickly.
--
-- So it is refused at the table, in both directions, rather than in the two
-- code paths that happen to write these rows today. Vacuously true on the day
-- it ships - `partner_users` is one migration old and empty - which is the
-- cheapest moment there will ever be to make it an invariant.
--
-- 23514 is the SQLSTATE 0140's `telecaller_reports_to_guard` and 0151's
-- `telecaller_escalate_to_guard` both raise for the same class of refusal.

CREATE OR REPLACE FUNCTION partner_user_not_member_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.user_id = NEW.user_id AND m.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'this person is already a member of the workspace and cannot also be a channel partner'
      USING ERRCODE = '23514';
  END IF;
  -- The partner must belong to the org the membership row names, or the
  -- exclusivity check above is asking about the wrong tenant. Foreign keys do
  -- not see RLS (doc 23 A2), so partner_id alone would happily cross orgs.
  IF NOT EXISTS (
    SELECT 1 FROM partners p WHERE p.id = NEW.partner_id AND p.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'partner_users.org_id must match the partner''s own organisation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

DO $do$ BEGIN
  CREATE TRIGGER partner_users_not_member
    BEFORE INSERT OR UPDATE OF user_id, org_id, partner_id ON partner_users
    FOR EACH ROW EXECUTE FUNCTION partner_user_not_member_guard();
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

CREATE OR REPLACE FUNCTION membership_not_partner_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM partner_users pu
     WHERE pu.user_id = NEW.user_id AND pu.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'this person is a channel partner in this workspace and cannot also be a member'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

DO $do$ BEGIN
  CREATE TRIGGER memberships_not_partner
    BEFORE INSERT OR UPDATE OF user_id, org_id ON memberships
    FOR EACH ROW EXECUTE FUNCTION membership_not_partner_guard();
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

-- ── 3. partner_invites: the standard RLS footer ─────────────────────────────
--
-- No `partner_isolation` policy on this one: the wall in §4 below covers it, and
-- that is the right answer rather than an oversight. An invite row carries a
-- colleague's email address and a token hash, and nothing in the five portal
-- screens reads it - the accept route runs BEFORE any partner principal exists,
-- on the admin pool, which is outside RLS entirely.

ALTER TABLE partner_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_invites FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON partner_invites
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

-- REVOKE before GRANT (0147, 0150, 0158 on the same trap). `anon` is the public
-- web key and a row here is one acceptance away from a portal login.
DO $do$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON partner_invites FROM %I', api_role);
    END IF;
  END LOOP;
END $do$;
REVOKE ALL ON partner_invites FROM PUBLIC;
DO $do$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON partner_invites TO aura_app;
  END IF;
END $do$;

-- ── 4. The wall ─────────────────────────────────────────────────────────────
--
-- Enumerated from the CATALOG rather than from a hand-written list, for the
-- reason verify-rls.js gives for doing the same: a list written out here would
-- be missing a table within a month, and the table it was missing would be the
-- one nobody thought about. The exceptions are the list instead, and there are
-- four of them.
--
-- `AS RESTRICTIVE` is the whole mechanism. Postgres ANDs restrictive policies
-- with the permissive ones, so this does not widen `org_isolation` by a single
-- row - it can only ever subtract. Added as a permissive policy it would be
-- worse than useless: it would OR with `org_isolation`, change nothing, and
-- look exactly like a boundary in `pg_policies`. §7 below refuses to let the
-- migration finish in that state.
--
-- ── THIS COVERS THE TABLES THAT EXIST TODAY ────────────────────────────────
--
-- A table added by 0164 or later does NOT get a wall from this block, because
-- this block runs once. Three options were considered: an event trigger on
-- `ddl_command_end` (fires inside every later migration, needs superuser, and
-- surprises whoever is debugging one at 2am), repeating the loop in every
-- future migration (it will be forgotten), or checking it. Checking it is the
-- answer: verify-rls.js is already the deploy gate that enumerates every
-- org_id table, and the one-line addition that makes this permanent is listed
-- in the handover for this phase. Until that lands, a new tenant table is
-- unwalled - which matters only if a portal query ever touches it, and no
-- portal query touches anything outside the four exceptions.

DO $do$
DECLARE t text; walled int := 0;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'org_id'
       AND tb.table_type  = 'BASE TABLE'
       -- 0162's own three: the second axis is expressed there, per-table, by
       -- `partner_isolation`. Walling them would leave the portal with no
       -- readable table at all.
       AND c.table_name NOT IN ('partners', 'partner_users', 'partner_submissions')
       -- The partner's own rate. Narrowed below rather than walled, because
       -- "My commissions" is one of the five screens and a partner who cannot
       -- see what they are paid has no reason to use a portal.
       AND c.table_name <> 'commission_plans'
     ORDER BY 1
  LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
      walled := walled + 1;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
  RAISE NOTICE '0163: partner_wall added to % tenant table(s)', walled;
  -- Non-vacuity, the lesson verify-rls.js's own rewrite records: if that
  -- enumeration ever returns nothing - a renamed schema, revoked catalog
  -- access, a typo - this block would succeed silently having walled nothing,
  -- and the portal would be able to read the entire tenant while every check in
  -- this file reported fine. 100 is far below the ~130 tables that carry an
  -- org_id today and far above anything a broken query would return.
  IF walled < 100 AND (SELECT count(*) FROM pg_policies
                        WHERE schemaname = 'public' AND policyname = 'partner_wall') < 100 THEN
    RAISE EXCEPTION '0163: only % tables were walled - the enumeration is wrong, refusing to leave the portal open', walled;
  END IF;
END $do$;

-- `commission_plans`, narrowed rather than walled: a partner reads the ONE plan
-- their own `partners` row points at, and no other.
--
-- The subquery runs under RLS itself - `partners` carries 0162's restrictive
-- `partner_isolation`, so even the inner read cannot reach another partner's
-- row. Two independent statements of the same restriction, which is the right
-- number for the one table outside the wall that carries a number somebody is
-- paid.
DO $do$ BEGIN
  CREATE POLICY partner_isolation ON commission_plans AS RESTRICTIVE
    USING (
      NULLIF(current_setting('app.partner_id', true), '') IS NULL
      OR EXISTS (
        SELECT 1 FROM partners p
         WHERE p.id = NULLIF(current_setting('app.partner_id', true), '')::uuid
           AND p.commission_plan_id = commission_plans.id
      )
    )
    -- A partner never writes a commission plan. Not "cannot today" - cannot.
    WITH CHECK (NULLIF(current_setting('app.partner_id', true), '') IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

-- ── 5. Prove the wall is RESTRICTIVE ───────────────────────────────────────
--
-- The one failure mode in this file that changes nothing visible and removes
-- the entire boundary. A `partner_wall` created as PERMISSIVE ORs with
-- `org_isolation`, admits every row it was meant to deny, and reads in
-- `pg_policies` exactly like the thing that was supposed to be there.
--
-- An EXCEPTION, not a WARNING - unlike 0162's grant audit, which reports a data
-- condition somebody can fix from the console afterwards. There is no "fix it
-- afterwards" for a tenant boundary that is not there: the deploy must not
-- finish.
DO $do$
DECLARE wrong text; n int;
BEGIN
  SELECT string_agg(tablename, ', '), count(*) INTO wrong, n
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('partner_wall', 'partner_isolation')
     AND permissive <> 'RESTRICTIVE';
  IF n > 0 THEN
    RAISE EXCEPTION '0163: % partner policy/policies are PERMISSIVE (on %) and isolate nothing', n, wrong;
  END IF;
  RAISE NOTICE '0163: every partner_wall / partner_isolation policy is RESTRICTIVE';
END $do$;

-- ── 6. And prove the four exceptions are the only ones ─────────────────────
--
-- The complement of the loop above, asked of the catalog rather than of the
-- code that just ran. A tenant table with no wall is a table a future portal
-- query can read, and the list of such tables must be exactly the four this
-- file argued for - not three, not five.
DO $do$
DECLARE open_tables text;
BEGIN
  SELECT string_agg(c.table_name, ', ' ORDER BY c.table_name) INTO open_tables
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
   WHERE c.table_schema = 'public'
     AND c.column_name  = 'org_id'
     AND tb.table_type  = 'BASE TABLE'
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.table_name
          AND p.policyname IN ('partner_wall', 'partner_isolation')
     );
  IF open_tables IS NOT NULL THEN
    RAISE EXCEPTION '0163: these org-scoped tables are readable by a partner principal: %', open_tables;
  END IF;
  RAISE NOTICE '0163: every org-scoped table is either walled or carries partner_isolation';
END $do$;
