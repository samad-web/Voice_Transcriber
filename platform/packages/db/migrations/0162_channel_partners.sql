-- 0162_channel_partners.sql - brokers, dealers and referrers who sit INSIDE a
-- tenant and must see almost none of it (Build docs/39, §17-§18).
--
-- ── THE SECOND RLS AXIS, AND WHY IT IS THE RISKIEST THING IN DOC 39 ─────────
--
-- Every table in this schema is isolated on exactly one axis:
-- `org_id = current_setting('app.org_id')`. A channel partner is not a tenant
-- and not a member of one - they are a third party standing inside somebody
-- else's workspace, allowed to put leads IN and to see what became of the ones
-- they put in, and allowed nothing else. One axis cannot say that, so this
-- migration introduces a second, and a second axis is precisely how tenant
-- isolation gets broken.
--
-- ── WHY `partner_isolation` IS *RESTRICTIVE*, AND §17 IS WRONG ──────────────
--
-- Doc 39 §17 writes the new policy as an ordinary (permissive) policy, and as
-- the table's ONLY policy. Both halves of that are wrong, in opposite and
-- individually fatal ways:
--
--   1. As the table's only policy it FAILS THE DEPLOY. `packages/db/
--      verify-rls.js` enumerates every public table carrying an `org_id` from
--      the catalog and requires a policy literally NAMED `org_isolation`,
--      carrying BOTH a USING and a WITH CHECK keyed on `app.org_id`. A table
--      whose only policy is called `partner_isolation` is reported as "no
--      policy named org_isolation" and the check exits non-zero - which is what
--      blocked a deploy on doc 34.
--
--   2. Added as a SECOND PERMISSIVE policy it silently does NOTHING. Postgres
--      ORs permissive policies together. `org_isolation` alone already admits
--      every row in the org, so a permissive `partner_isolation` beside it
--      would widen nothing and narrow nothing: a partner would read the whole
--      tenant's submissions and every assertion about it would still be green,
--      because the policy exists, is named right, and is never the deciding
--      clause.
--
-- The composition that actually expresses "inside this org AND, if a partner is
-- asking, only their own rows" is a RESTRICTIVE policy, which Postgres ANDs
-- with the permissive ones. So each table below carries exactly two:
--
--      org_isolation      PERMISSIVE   org_id  = app.org_id      (verify-rls)
--      partner_isolation  RESTRICTIVE  partner = app.partner_id  (doc 39 §17)
--
-- ── WHY `NULLIF(..., '')` AND NOT `IS NULL` ────────────────────────────────
--
-- §17's draft tests `current_setting('app.partner_id', true) IS NULL`. That is
-- true only on a connection where the setting has NEVER been assigned. The
-- portal sets it transaction-locally, so on COMMIT it does not disappear - it
-- reverts to the GUC's reset value, which for a custom placeholder is the EMPTY
-- STRING. The very next tenant request to reuse that pooled connection would
-- therefore read '' rather than NULL, fail the `IS NULL` arm, and evaluate
-- `partner_id = ''::uuid` - which raises 22P02, not a denial. Every staff read
-- of these three tables would start erroring the moment one partner had ever
-- been served on that backend, intermittently, and only under pool reuse.
--
-- `NULLIF(current_setting('app.partner_id', true), '')` folds "never set" and
-- "set and reverted" into the same NULL, which is the only reading of this
-- predicate that survives a connection pool.
--
-- ── WHO SETS IT ────────────────────────────────────────────────────────────
--
-- `withPartnerContext` in apps/api/src/modules/partners/partner-context.ts, and
-- nothing else. `withOrgContext` (packages/db/src/index.ts) does not know this
-- setting exists and must never learn: two helpers, two call sites, no shared
-- setter (§17 rule 1). A partner request that somehow ran under withOrgContext
-- would see `app.partner_id` unset and read the whole org - which is why the
-- API side makes that structurally impossible rather than merely discouraged
-- (see partner-context.ts).

-- ── 1. partners ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS partners (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name     text NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('broker', 'dealer', 'referrer', 'reseller')),
  -- Their referral code: what a partner quotes, what a form carries, and what
  -- the tenant reconciles a commission against. Unique per org on lower(code)
  -- so 'ARJ-01' and 'arj-01' cannot be two partners.
  code     text NOT NULL,
  -- A partner is SUSPENDED or TERMINATED, never deleted. Deleting one would
  -- orphan every submission they ever made and with it the tenant's own record
  -- of where those leads came from - the same reasoning 0158 gives for
  -- disabling a DNC list rather than removing it, and the reason there is no
  -- `partner:delete` grant seeded below and no DELETE route.
  status   text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'active', 'suspended', 'terminated')),
  -- §18: commission reuses commission_plans (0071). No parallel payout engine,
  -- and no rate column here - a rate stored in two places is a rate that
  -- disagrees with itself.
  commission_plan_id uuid REFERENCES commission_plans(id) ON DELETE SET NULL,
  -- A VAULT REFERENCE, not a number: `sha256(phoneMatchDigits(n))`, the same
  -- key 0157's contact_numbers is keyed on, 0133's call log matches on and
  -- 0146's lead inheritance joins by. 0006 removed counterparty numbers from
  -- this schema on purpose and a partner roster is not the place to put them
  -- back; the digits live in contact_numbers behind `contact_number:view` and
  -- an auth_events row per reveal.
  phone_number_key text,
  email    text,
  onboarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS partners_org_code ON partners (org_id, lower(code));
-- The console's roster: active partners for an org, newest first.
CREATE INDEX IF NOT EXISTS partners_org_status ON partners (org_id, status, created_at DESC);

COMMENT ON TABLE partners IS
  'A channel partner - broker, dealer, referrer or reseller - who may submit leads into this '
  'tenant through the portal (doc 39 §18). Not a member of the org: a partner has no '
  'memberships row, by a constraint 0163 enforces.';
COMMENT ON COLUMN partners.phone_number_key IS
  'sha256(phoneMatchDigits(n)) - a contact_numbers reference, never an E.164.';

-- ── 2. partner_users ────────────────────────────────────────────────────────
--
-- The people who sign in to one partner's portal. These ARE `users` rows -
-- Supabase auth, Google sign-in and the invite machinery are reused rather than
-- reimplemented - and the one thing that distinguishes them from staff is that
-- they hold NO `memberships` row in the org. 0163 turns that from a convention
-- into a database constraint, because the whole partner principal resolution
-- rests on it.

CREATE TABLE IF NOT EXISTS partner_users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Redundant against partner_id and required twice over, exactly as
  -- dnc_entries carries it: verify-rls.js's closure check wants every public
  -- table org-scoped, and RLS needs a column on THIS table to filter on.
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'owner' is the partner's own principal, who may invite their colleagues
  -- later; 'member' submits and reads. Deliberately NOT the tenant's role
  -- vocabulary - a partner's internal hierarchy has nothing to do with the
  -- tenant's permission grid and must never be confused with it.
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_users_unique ON partner_users (partner_id, user_id);
-- PartnerScopeGuard's one query: "which partner is this signed-in person?",
-- reached from `users.sso_subject`. One round trip, because the database is in
-- Seoul and the API in Mumbai (doc 39 Part K §13).
CREATE INDEX IF NOT EXISTS partner_users_user ON partner_users (user_id) WHERE status = 'active';

COMMENT ON TABLE partner_users IS
  'A person who signs in to a partner portal. A users row with NO memberships row in the same '
  'org - that pair is what makes a principal a PARTNER principal, and 0163 constrains it.';

-- ── 3. partner_submissions ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS partner_submissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- Which PERSON at the partner submitted it. Null once that person is removed;
  -- the submission belongs to the partner, not to an individual.
  submitted_by uuid REFERENCES partner_users(id) ON DELETE SET NULL,
  lead_id    uuid REFERENCES leads(id) ON DELETE SET NULL,
  -- Denormalised from the lead at submission time, and the ONLY customer
  -- details a partner ever reads back. The partner typed these, so showing them
  -- back discloses nothing; reading them off `leads` would mean the portal
  -- holding a handle into the tenant's pipeline, which is exactly what §18
  -- refuses. They also survive the lead being merged, archived or deleted, so
  -- "what did I send you in March" keeps an answer.
  lead_name  text,
  lead_phone text,
  lead_email text,
  note       text,
  --
  -- ── WHY `outcome` IS COARSE, AND MUST STAY COARSE ────────────────────────
  --
  -- The temptation is to show the partner the real lead stage, because it is
  -- right there and it is what they keep asking for. Do not. A broker who can
  -- watch every prospect's stage and budget move holds the tenant's pipeline:
  -- they know which deals are stalling, which are about to close and what they
  -- are worth, for a customer list they did not buy. The first tenant to work
  -- that out is the last tenant to use the portal.
  --
  -- Four states, and each is a statement the TENANT chose to make to the
  -- partner rather than a fact leaking out of the CRM:
  --   submitted  we have it
  --   accepted   it is a real prospect and we are working it
  --   rejected   we are not (reject_reason says why, in the tenant's words)
  --   converted  it became business, which is what a commission hangs off
  --
  -- There is deliberately no mapping from `leads.stage` to this column. A
  -- trigger or a view that derived one would reintroduce the whole problem
  -- while looking like a convenience.
  outcome    text NOT NULL DEFAULT 'submitted' CHECK (outcome IN
               ('submitted', 'accepted', 'rejected', 'converted')),
  reject_reason text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  -- Who in the TENANT decided. Never shown in the portal: the partner is told
  -- the verdict, not which of the tenant's people reached it.
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL
);

-- The portal's only list: my submissions, newest first.
CREATE INDEX IF NOT EXISTS partner_submissions_partner
  ON partner_submissions (partner_id, submitted_at DESC);
-- The tenant's queue: what is waiting on a decision, across every partner.
CREATE INDEX IF NOT EXISTS partner_submissions_org_outcome
  ON partner_submissions (org_id, outcome, submitted_at DESC);
-- "Which submission produced this lead", for the lead card's attribution.
CREATE INDEX IF NOT EXISTS partner_submissions_lead
  ON partner_submissions (lead_id) WHERE lead_id IS NOT NULL;

COMMENT ON COLUMN partner_submissions.outcome IS
  'submitted|accepted|rejected|converted. DELIBERATELY COARSE and NEVER derived from '
  'leads.stage - doc 39 §18: a partner who can see the tenant''s pipeline holds the '
  'tenant''s pipeline.';

-- ── 4. commission_plans gains a payee kind ──────────────────────────────────
--
-- §18: commission for a partner reuses the plan table a tenant already
-- configures for its own people. The alternative - a `partner_commission_plans`
-- table beside it - would be the parallel payout engine 0071's header already
-- refused once, and would split "what rate applies" across two places that
-- would disagree inside a quarter.
--
-- `payee_kind` says which population a plan is written for, because the two are
-- not interchangeable: a telecaller's plan is usually a percentage of won value
-- measured over a window, a broker's is usually a flat amount per converted
-- referral, and offering either list the other's plans is how somebody gets
-- paid twice. Nothing about 0071's "a rate, not payroll" boundary moves: there
-- is still no accrual, no claw-back and no approval trail here.
--
-- DEFAULT 'user' and NOT NULL, so every existing row keeps meaning exactly what
-- it meant before this ran.
ALTER TABLE commission_plans
  ADD COLUMN IF NOT EXISTS payee_kind text NOT NULL DEFAULT 'user';

DO $do$ BEGIN
  ALTER TABLE commission_plans ADD CONSTRAINT commission_plans_payee_kind_check
    CHECK (payee_kind IN ('user', 'partner'));
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

COMMENT ON COLUMN commission_plans.payee_kind IS
  'user|partner (doc 39 §18). Which population this standing rate is written for; '
  'partners.commission_plan_id may only point at a ''partner'' plan.';

-- partners.commission_plan_id may only name a plan written for partners, and
-- only one in the same org. Two separate hazards, one guard:
--
--   * A plan from ANOTHER ORG. Foreign keys do not see RLS (doc 23 A2), so the
--     reference alone would happily cross tenants - the same trap
--     `assertInOrg` exists for on the API side, restated here because this one
--     decides what somebody is paid.
--   * A plan written for staff. Attaching a telecaller's percentage-of-won-value
--     plan to a broker is not a typo anybody notices until a payout is wrong.
CREATE OR REPLACE FUNCTION partner_commission_plan_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.commission_plan_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM commission_plans p
     WHERE p.id = NEW.commission_plan_id
       AND p.org_id = NEW.org_id
       AND p.payee_kind = 'partner'
  ) THEN
    RAISE EXCEPTION 'a partner''s commission plan must belong to the same organisation and have payee_kind = ''partner'''
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;

DO $do$ BEGIN
  CREATE TRIGGER partners_commission_plan_guard
    BEFORE INSERT OR UPDATE OF commission_plan_id, org_id ON partners
    FOR EACH ROW EXECUTE FUNCTION partner_commission_plan_guard();
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

DO $do$ BEGIN
  CREATE TRIGGER partners_set_updated_at BEFORE UPDATE ON partners
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

-- ── 5. Row-level security - the tenant pattern, PLUS the second axis ────────
--
-- The first half is 0158's block verbatim: enable, FORCE, one PERMISSIVE policy
-- named `org_isolation` with both a USING and a WITH CHECK on `app.org_id`, then
-- REVOKE before GRANT. That is what verify-rls.js reads, and it is what makes
-- these three ordinary tenant tables to every existing code path.
--
-- The second half is the new axis. See this file's header for why it is
-- RESTRICTIVE and why the setting is read through NULLIF.

DO $do$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partners', 'partner_users', 'partner_submissions'] LOOP
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
END $do$;

-- `partners` and `partner_users` key the second axis on their own identity
-- rather than on a `partner_id` column: a partner reads THEIR partner row and
-- THEIR colleagues, nobody else's. `partner_submissions` keys on `partner_id`.
-- Written out one statement at a time rather than looped, because the column
-- differs per table and a loop that got that mapping wrong would be a silent
-- cross-partner read.

DO $do$ BEGIN
  CREATE POLICY partner_isolation ON partners AS RESTRICTIVE
    USING (
      NULLIF(current_setting('app.partner_id', true), '') IS NULL   -- staff: whole org
      OR id = NULLIF(current_setting('app.partner_id', true), '')::uuid
    )
    WITH CHECK (
      NULLIF(current_setting('app.partner_id', true), '') IS NULL
      OR id = NULLIF(current_setting('app.partner_id', true), '')::uuid
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

DO $do$ BEGIN
  CREATE POLICY partner_isolation ON partner_users AS RESTRICTIVE
    USING (
      NULLIF(current_setting('app.partner_id', true), '') IS NULL
      OR partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid
    )
    WITH CHECK (
      NULLIF(current_setting('app.partner_id', true), '') IS NULL
      OR partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

DO $do$ BEGIN
  CREATE POLICY partner_isolation ON partner_submissions AS RESTRICTIVE
    USING (
      NULLIF(current_setting('app.partner_id', true), '') IS NULL
      OR partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid
    )
    WITH CHECK (
      NULLIF(current_setting('app.partner_id', true), '') IS NULL
      OR partner_id = NULLIF(current_setting('app.partner_id', true), '')::uuid
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

-- ── 6. Permission grants for the `partner` object type ──────────────────────
--
-- `CrmPermissionsGuard` DENIES whatever it finds no grant for. Widening
-- `PermissionObjectType` without seeding these would 403 every user in every
-- tenant the moment the API container restarted, and the grid that could fix it
-- is only editable by an admin who would first have to work out why. 0041 says
-- this about `task`, 0103 about `lead`, 0158 about `dnc`; this block is the one
-- thing in this file that exists purely to prevent a deploy-day lockout.
--
-- No CHECK to widen: `role_permissions.object_type` is an open string
-- (0039's decision, app-validated by a zod enum) and view/create/edit are
-- already in `role_permissions_action_check`. Only rows are needed.
--
-- CUSTOM roles are deliberately untouched, 0041's choice: somebody defined those
-- by hand, nobody has ever held `partner`, so there is nothing to preserve and
-- widening them would be a decision rather than a restoration.
--
-- Scope is always `all`. `partner` is in ALL_SCOPE_ONLY_OBJECTS with
-- OWNER_COLUMN null - a partner roster has no owner, so "my own partners"
-- names nothing.

-- `partner:view` - the roster, and the attribution on a lead that came from
-- one. Every console role including `viewer`, and deliberately so: a telecaller
-- ringing a lead needs to know a broker sent it (it changes what they say in
-- the first ten seconds), and the row discloses a business name, a kind and a
-- referral code. No customer is in it and no number is: `phone_number_key` is a
-- digest, for exactly the reason 0158 let `viewer` read `dnc` while refusing it
-- `contact_number`.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'partner', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin',
                 'workspace_member', 'viewer')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `partner:create` and `partner:edit` - the three admin roles ONLY, and this is
-- a deliberate narrowing of 0041's pattern rather than an oversight.
--
-- `create` signs a channel partner up and mints a referral code; `edit` sets
-- `status` (activating a terminated broker re-opens the portal to them) and
-- attaches `commission_plan_id`, which is literally the rate somebody is paid.
-- That is the same judgement 0136 made excluding `workspace_member` from
-- `lead_board`, 0141 made for `task:assign_up` and 0158 made for `dnc:create` -
-- deciding who gets paid is not a telecaller's call. An owner can grant it on
-- Team & permissions in one click.
--
-- There is NO `partner:delete`: a partner is suspended or terminated, never
-- deleted (see the `status` column), so the cell would gate a route that does
-- not exist - which is exactly what ENFORCED_PERMISSIONS is there to prevent.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'partner', a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('create'), ('edit')) AS a(action)
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- ── 7. Prove it, rather than assume it ──────────────────────────────────────
--
-- Every active membership that can reach the console must resolve to a
-- `partner:view` grant through the same join the guard uses - including its
-- `role_id IS NULL` fallback, which matches `roles.key` against the legacy
-- `memberships.role` string.
--
-- A WARNING and not an exception, for 0103's and 0158's reason: this runs inside
-- the deploy's migrate job, and aborting would leave the schema half-applied and
-- the deploy dead in order to report a data condition that is visible and
-- repairable from the console afterwards. A membership on a CUSTOM role is the
-- expected finding, since custom roles are not seeded above.
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
           ON rp.role_id = r.id AND rp.object_type = 'partner' AND rp.action = 'view'
        WHERE r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
     );

  IF stranded > 0 THEN
    RAISE WARNING '0162: % membership(s) resolve to no partner:view grant (custom roles are not seeded) - grant it on Team & permissions', stranded;
  ELSE
    RAISE NOTICE '0162: every active membership resolves to a partner:view grant';
  END IF;
END $do$;

-- And prove the second axis is actually wired, because a RESTRICTIVE policy
-- that was created as PERMISSIVE is the one failure in this file that changes
-- nothing visible and removes the whole boundary. `pg_policies.permissive`
-- reads 'PERMISSIVE' or 'RESTRICTIVE'; this refuses to leave the migration in
-- the state where a partner reads the tenant's roster.
DO $do$
DECLARE wrong text;
BEGIN
  SELECT string_agg(tablename, ', ') INTO wrong
    FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname = 'partner_isolation'
     AND permissive <> 'RESTRICTIVE';
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION '0162: partner_isolation is PERMISSIVE on %, which ORs with org_isolation and isolates nothing', wrong;
  END IF;

  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'partner_isolation') <> 3 THEN
    RAISE EXCEPTION '0162: expected partner_isolation on all three partner tables';
  END IF;
  RAISE NOTICE '0162: partner_isolation is RESTRICTIVE on all three partner tables';
END $do$;
