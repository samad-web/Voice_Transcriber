-- 0158_call_suppression_and_dnc.sql - "do not ring this person", in the two
-- shapes it actually arrives in (Build docs/39, §4).
--
-- ── WHY CALLING IS A CHANNEL AND NOT A NEW CONCEPT ──────────────────────────
--
-- `messaging_opt_outs` (0111) already models "this person asked to be left
-- alone": `level IN ('certain','probable')` where only `certain` silences
-- anybody, a `source_message_id` for provenance, a release path that is an
-- UPDATE rather than a DELETE, and a review column from 0119. Every one of those
-- properties is wanted for a call opt-out, so this widens `channel` instead of
-- building a parallel table that would reacquire all four by hand.
--
-- For a call opt-out, `peer_address` holds the NUMBER KEY - the same
-- sha256(phoneMatchDigits(n)) that 0157's vault is keyed on - and never an
-- E.164. The vault owns the only copy of the number; a suppression list that
-- stores numbers defeats the vault and puts dialable numbers in a table with
-- different grants.
--
-- ── THE CHECK/ZOD DRIFT TRAP, WHICH THIS CODEBASE HAS ALREADY PAID ─────────
--
-- The widened constraint below has a twin in `packages/shared/src/opt-out.ts`.
-- Widening one and not the other throws 23514 at runtime and reads like a bug in
-- the caller. That has already happened here with `notifications.kind`, in both
-- directions at once. Both move in the same commit, and `opt-out.test.ts` is
-- extended to assert the two sets are EQUAL rather than merely overlapping.
--
-- ── AND WHY BULK LISTS DO NOT GO IN THAT TABLE ──────────────────────────────
--
-- A tenant uploading the national DNC registry, or their own 40,000-row sheet,
-- must not write 40,000 `messaging_opt_outs` rows. That table is for INDIVIDUAL
-- requests WITH PROVENANCE - every row there can answer "who asked, when, and in
-- which message" - and filling it with a bought list destroys exactly that
-- property, along with the review queue 0119 built on top of it.
--
-- So bulk suppression is its own pair of tables: a list with a status, and keys.

-- ── 1. messaging_opt_outs gains the call channel ────────────────────────────
--
-- 0111 declared this CHECK INLINE, so the name is Postgres's rather than ours:
-- a single-column inline CHECK is auto-named `<table>_<column>_check`, which is
-- `messaging_opt_outs_channel_check`. Dropped by that name and re-added as an
-- explicitly NAMED constraint, which is what lets the NEXT widening drop it by
-- name with no searching at all - the same move 0151 made for
-- `handset_alerts.kind`.
--
-- `opt-out.test.ts` transcribes the two statements below by hand and asserts the
-- zod enum in packages/shared/src/opt-out.ts holds the same four values. Change
-- one and you change all three, or a "stop calling me" throws 23514 on the
-- ingest path and reads like a bug in the caller. That is not hypothetical: it
-- happened to `notifications.kind`, in both directions at once, and it broke
-- lead routing while every type-check and lint stayed green.

ALTER TABLE messaging_opt_outs DROP CONSTRAINT IF EXISTS messaging_opt_outs_channel_check;

-- And the belt to that braces. If the auto-name had ever collided, 0111's
-- constraint would be sitting there as `..._check1`, the DROP above would have
-- been a silent no-op, the ADD below would have SUCCEEDED, and the table would
-- carry two CHECKs - one of which still refuses 'call'. So sweep the catalog for
-- any remaining single-column CHECK on `channel`, whatever it is called.
--
-- Narrowed to single-column CHECKs on that one attribute so it cannot touch
-- `messaging_opt_outs_release_has_actor` (a two-column CHECK) or
-- `messaging_opt_outs_peer_unique` (not a CHECK at all).

DO $do$
DECLARE con text;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
     WHERE t.relname = 'messaging_opt_outs' AND c.contype = 'c' AND a.attname = 'channel'
       AND c.conkey = ARRAY[a.attnum]
  LOOP
    EXECUTE format('ALTER TABLE messaging_opt_outs DROP CONSTRAINT %I', con);
  END LOOP;
END $do$;

-- Four values added, not one, and the extra three need saying out loud.
--
-- 'call' is what this migration exists for. 'instagram' and 'facebook' are the
-- repair of a LIVE BUG that predates it:
--
--   ConversationChannel (packages/shared/src/conversations.ts) is
--   ('whatsapp','sms','email','instagram','facebook'), and `recordOptOut` in
--   conversations.service.ts inserts the inbound message's channel straight
--   into this column with no filtering. So an Instagram or Messenger user
--   typing "unsubscribe" throws 23514 TODAY, and their request to be left alone
--   is not recorded at all.
--
-- That is the worst of the three available behaviours. The request is identical
-- whichever inbox it arrives in, and `peer_address` has always been
-- channel-relative - a number key for a call, an address for email, a
-- page-scoped id here - so there was never a shape problem, only a missing
-- literal. Leaving it while rewriting this exact constraint would have been
-- choosing to keep dropping opt-outs.
--
-- `OptOutChannel` in @aura/shared widens to match in the same commit, and
-- opt-out.test.ts asserts the two sets are equal - which is the §4.1 trap this
-- bug is itself an instance of.
ALTER TABLE messaging_opt_outs ADD CONSTRAINT messaging_opt_outs_channel_check
  CHECK (channel IN ('whatsapp', 'sms', 'email', 'call', 'instagram', 'facebook'));

COMMENT ON COLUMN messaging_opt_outs.channel IS
  'whatsapp|sms|email|call. For ''call'' (doc 39 §4.1) peer_address holds the NUMBER KEY '
  '(sha256 of phoneMatchDigits), never an E.164 - contact_numbers owns the only copy of the '
  'number. Kept in lockstep with packages/shared/src/opt-out.ts (opt-out.test.ts).';

-- ── 2. Bulk suppression lists ───────────────────────────────────────────────
--
-- Ingest reuses apps/api/src/modules/import and packages/shared/src/import-phone
-- .ts, so a sheet mixing '+91…', '0…' and bare ten-digit forms keys correctly
-- against the vault rather than producing three unmatchable digests of one
-- customer - the problem 0133's header documents for the call log.

CREATE TABLE IF NOT EXISTS dnc_lists (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name     text NOT NULL,
  -- 'regulatory' is somebody else's list the tenant is obliged to honour (a
  -- national registry); 'internal' is their own. The distinction is not
  -- cosmetic: it is what lets the console refuse to let a telecaller touch the
  -- first kind, and what a compliance question is answered with.
  kind     text NOT NULL CHECK (kind IN ('regulatory', 'internal')),
  -- A list is DISABLED, never deleted. Deleting one would silently re-open
  -- forty thousand numbers for dialling with nothing left to say that they were
  -- ever closed - the same reasoning 0111 gives for releasing an opt-out by
  -- UPDATE instead of DELETE.
  status   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Denormalised on purpose. The campaign preview reports "211 on a DNC list"
  -- beside counts it gets cheaply, and a count(*) over a 40k-row child table per
  -- list, per preview, at Seoul latency is the kind of query that makes a
  -- supervisor's screen feel broken.
  entry_count int NOT NULL DEFAULT 0,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dnc_entries (
  list_id    uuid NOT NULL REFERENCES dnc_lists(id) ON DELETE CASCADE,
  -- Redundant against list_id and required twice over: verify-rls.js's closure
  -- check wants every public table org-scoped, and the tenant's own reads run
  -- inside withOrg() where RLS needs a column on THIS table to filter on.
  -- `recordings` and `call_issue_events` carry both for the same two reasons.
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The key, not the number. See this file's header.
  number_key text NOT NULL,
  -- No id and no created_at: this is 40,000 rows of nothing but a key, and the
  -- natural key IS the row. The list carries the provenance.
  PRIMARY KEY (list_id, number_key)
);

-- dialability()'s question is "is this key on ANY active list for this org",
-- which leads on org_id because RLS puts it in every predicate anyway.
CREATE INDEX IF NOT EXISTS dnc_entries_org_key ON dnc_entries (org_id, number_key);

COMMENT ON TABLE dnc_lists IS
  'A bulk suppression list - a national registry or the tenant''s own sheet (doc 39 §4.2). '
  'Disabled, never deleted. Individual requests with provenance belong in messaging_opt_outs.';
COMMENT ON TABLE dnc_entries IS
  'Number KEYS on a dnc_lists list. Never E.164 - contact_numbers owns the only copy of a number.';

-- ── Row-level security and grants - the tenant pattern ──────────────────────
--
-- Both tables are org-scoped, so the standard policy applies and verify-rls.js
-- passes WITHOUT an allowlist entry. That is the difference from 0145, whose
-- non-tenant table failed the closure check and would have killed the prod
-- migrate job after applying four migrations.
--
-- REVOKE before GRANT (see 0147 and 0150 on the same trap).

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dnc_lists', 'dnc_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    END IF;
  END LOOP;
END $$;

-- ── 3. Permission grants for the two new object types ───────────────────────
--
-- `CrmPermissionsGuard` DENIES whatever it finds no grant for. Mounting it on
-- the new routes without seeding these first would 403 every user in every
-- tenant the moment the API container restarted - and the permission grid is
-- only editable by an admin who would first have to notice. 0041's header says
-- exactly this about `task` and 0103's says it about `lead`; this block is the
-- one thing in this file that exists purely to prevent a deploy-day lockout.
--
-- No CHECK to widen: `role_permissions.object_type` is an open string
-- (app-validated by a zod enum, 0039's own decision), and `view`/`create`/`edit`
-- are already in `role_permissions_action_check` as 0141 last left it. Only rows
-- are needed here.
--
-- CUSTOM roles are deliberately NOT touched, the choice 0041 made: somebody
-- defined those by hand and silently widening them is not this migration's call.
-- 0103 went the other way, but only because it was preserving access people
-- ALREADY HAD; nobody has ever had these two objects, so there is nothing to
-- preserve and over-granting would be a decision rather than a restoration.
--
-- The TypeScript half - PermissionObjectType, ENFORCED_PERMISSIONS and
-- `seedCrmDefaults` in admin.controller.ts, which is what gives a NEW org its
-- grid - moves in the same commit. This block is for the orgs that exist today.

-- `contact_number:view` - revealing a number in the console (and the grant the
-- handset's queue route is checked against). The three admin roles and
-- `workspace_member`, who is the telecaller that actually has to ring the
-- person.
--
-- `viewer` is DELIBERATELY EXCLUDED, and this is the one place in 0157/0158
-- that departs from 0041's "viewer always gets view" predicate.
--
-- Everything else in this pair of migrations exists to make revealing a number
-- the narrowest act in the subsystem: 0006 removed these digits from the schema
-- on purpose, only two routes in the whole API may serve `e164`, and every
-- reveal writes an `auth_events` row. A `viewer` is a role for somebody who
-- needs to see how the business is doing without acting in it - and turning a
-- stored digest back into a customer's phone number is acting in it. Audit
-- records who did it; it does not stop them.
--
-- The asymmetry is the argument. Granting this later is one deliberate click on
-- Team & permissions by an owner who has decided their observers need it.
-- Withdrawing it after a tenant discovers their read-only auditor exported a
-- customer's phone number is too late - the digits are already gone.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'contact_number', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin',
                 'workspace_member')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `dnc:view` - everybody who can see a queue, `viewer` included. The agent
-- screen renders dialability()'s block reason verbatim so an agent knows WHY a
-- record is greyed out rather than assuming a bug, and "on a DNC list" is one of
-- the seven reasons. Withholding the read would make the dialer look broken to
-- the people using it.
--
-- Keeping `viewer` here while excluding it above is not an inconsistency, and
-- the reason is in the schema: `dnc_entries` stores `number_key`, which is a
-- SHA-256 of the last ten digits, never the digits. Reading a suppression list
-- discloses "this org must not call somebody" and nothing further - there is no
-- number in it to leak. That is the entire difference between the two grants.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'dnc', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin',
                 'workspace_member', 'viewer')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `dnc:create` and `dnc:edit` - the three admin roles ONLY, and this is a
-- deliberate narrowing of 0041's pattern rather than an oversight.
--
-- 0041 gave `workspace_member` view/create/edit of a TASK, which is floor work.
-- A DNC list is not: `edit` includes setting status = 'disabled', which re-opens
-- every number on a regulatory registry for dialling in one click, and `create`
-- lets somebody shadow a registry with an empty list of their own. That is the
-- same judgement 0136 made excluding `workspace_member` from `lead_board` despite
-- its holding `lead:edit` at `all` ("deleting a board is not a telecaller's
-- call"), and the same one 0141 made for `task:assign_up`. An owner can grant it
-- on the Team & permissions screen.
--
-- Scope is always `all`. "Own DNC lists" means nothing; suppression is org-wide
-- or it is not suppression.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'dnc', a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('create'), ('edit')) AS a(action)
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- ── Prove it, rather than assume it ─────────────────────────────────────────
--
-- Every active membership that can reach the console must resolve to a
-- `dnc:view` grant through the same join the guard uses - including its
-- `role_id IS NULL` fallback, which matches `roles.key` against the legacy
-- `memberships.role` string.
--
-- A WARNING and not an exception, for 0103's reason: this runs inside the
-- deploy's migrate job, and aborting would leave the schema half-applied and the
-- deploy dead to report a data condition that is visible and repairable from the
-- console afterwards. A loud count in the deploy log is what somebody can act on.
--
-- A membership on a CUSTOM role is the expected finding here, since custom roles
-- are not seeded above.
DO $do$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
    FROM memberships m
    JOIN organizations o ON o.id = m.org_id AND 'aura' = ANY(o.enabled_modules)
   WHERE m.status = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM roles r
         JOIN role_permissions rp
           ON rp.role_id = r.id AND rp.object_type = 'dnc' AND rp.action = 'view'
        WHERE r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
     );

  IF stranded > 0 THEN
    RAISE WARNING '0158: % membership(s) resolve to no dnc:view grant (custom roles are not seeded) - grant it on Team & permissions', stranded;
  ELSE
    RAISE NOTICE '0158: every active membership resolves to a dnc:view grant';
  END IF;
END $do$;
