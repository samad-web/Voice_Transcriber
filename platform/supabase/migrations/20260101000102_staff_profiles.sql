-- 0102_staff_profiles.sql - a membership becomes a staff record.
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────
--
-- The Team page (a908477) can create a login, set its console persona and
-- remove it. Three things a floor manager needs are absent, and the third is
-- the one that hurts:
--
--   1. An employee code. Every business that runs a phone floor already has
--      one, printed on the roster and used in their payroll; a CRM that
--      cannot record it is a CRM whose staff list has to be reconciled by
--      hand against another list.
--   2. A phone number for the person - as distinct from the handset's, which
--      lives on `devices`. "Who is on shift and how do I reach them" is not
--      answerable from this schema today.
--   3. SUSPENSION. The only way to stop somebody signing in is `DELETE`,
--      which deletes their Supabase login outright. A rep who has resigned,
--      is on notice, or has simply gone on three months' leave should stop
--      being able to open the console WITHOUT their work being detached from
--      them - and today the only button available does the opposite: it
--      revokes access and leaves every lead, call and follow-up they were
--      working attributed to an account that no longer exists.
--
-- ── WHY ON `memberships` AND NOT ON `users` ─────────────────────────────────
--
-- `users` is cross-org: the same row is the same human in every tenant they
-- belong to, which is exactly why `contextFor` can return several memberships
-- for one login. An employee code is not a property of a human, it is a
-- property of their employment BY ONE BUSINESS - and writing it on `users`
-- would leak one tenant's staff numbering into another's console the moment a
-- consultant is added to two of them.
--
-- The same argument settles suspension, and more sharply: suspending somebody
-- from one workspace must not sign them out of another.
--
-- ── WHY SUSPENSION IS NOT A `status` ON `users` EITHER ──────────────────────
--
-- `users.status` already exists and `contextFor` already refuses a non-active
-- one (auth.service.ts). That is the PLATFORM's kill switch - an operator
-- disabling an account across the whole product - and a customer must not be
-- able to reach it: an owner suspending their own colleague would otherwise
-- lock that person out of a different client's workspace.

ALTER TABLE memberships
  -- 'active' | 'suspended'. Not 'archived'/'deleted' - removal is still a
  -- DELETE, and a third state that means "sort of gone" is how a roster ends
  -- up with people nobody can account for.
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',

  -- The business's own identifier for this person. Free text on purpose:
  -- "EMP-0412", "T14", and "priya.s" are all real answers, and a format this
  -- schema invented would be one nobody's payroll agrees with.
  ADD COLUMN IF NOT EXISTS staff_code text,

  -- The person's own number, not the handset's (`devices.phone_number`). No
  -- hashing here, unlike `calls.remote_number_hash`: that column protects a
  -- CUSTOMER's number, which the tenant has no standing consent to store in
  -- clear. This is the tenant's own employee, entered by their own manager.
  ADD COLUMN IF NOT EXISTS phone text,

  -- What they do, in the business's words - "Senior Telecaller", "Branch
  -- Manager". Distinct from both `role` (the API's tenant role) and
  -- `owner_role` (the console persona), and it grants nothing: a job title
  -- that quietly widened access would be the worst possible way to widen it.
  ADD COLUMN IF NOT EXISTS job_title text,

  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- NOT VALID then validated, the shape 0095 and 0099 use. `memberships` is the
-- table every authorization path reads; a constraint that aborted this
-- migration mid-flight would take the console down for every tenant, and the
-- column was just created with a DEFAULT so the only way it can fail is a
-- concurrent write from an old build.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_status_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_status_check
  CHECK (status IN ('active', 'suspended')) NOT VALID;

DO $do$ BEGIN
  ALTER TABLE memberships VALIDATE CONSTRAINT memberships_status_check;
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'memberships: % row(s) carry an unexpected status; constraint left NOT VALID',
    (SELECT count(*) FROM memberships WHERE status NOT IN ('active', 'suspended'));
END $do$;

-- One code per org, and only where one was given. Partial, because most rows
-- will never have one and a UNIQUE over NULLs would permit duplicates anyway -
-- being explicit says which behaviour was intended.
CREATE UNIQUE INDEX IF NOT EXISTS memberships_org_staff_code
  ON memberships (org_id, staff_code) WHERE staff_code IS NOT NULL;

-- `contextFor` reads memberships by user on every navigation and now filters
-- on status. It matches by user_id first, so this index is for the OTHER
-- direction: the staff roster, which lists one org's people and wants the
-- suspended ones separated without a sequential scan on a large tenant.
CREATE INDEX IF NOT EXISTS memberships_org_status
  ON memberships (org_id, status);

COMMENT ON COLUMN memberships.status IS
  'active | suspended. A suspended membership is refused by contextFor (the '
  'console cannot resolve an org for it) and by ownerRoleFor (every '
  '@RequireOwnerRole route denies). Every row the person owns - leads, calls, '
  'tasks, deals - is left exactly where it is: this stops a person signing '
  'in, it does not un-assign their work.';

COMMENT ON COLUMN memberships.suspended_at IS
  'When access was suspended. Cleared on reinstatement rather than kept as a '
  'history: the audit_log holds the sequence, and a stale timestamp beside an '
  'active membership reads as though the person were still locked out.';

-- ── Assigning a permission role, at last ────────────────────────────────────
--
-- No schema change is needed for this and that is worth saying out loud,
-- because 0039 deferred the feature and its header reads as though the table
-- were the obstacle. It was not. `memberships.role_id` has existed since 0039
-- and `CrmPermissionsGuard` has joined on it since; what was missing was a
-- WRITE PATH, which is now `PUT /v1/owner/staff/:userId/role`.
--
-- The constraint 0039 was actually protecting is `memberships.role`'s
-- five-value CHECK, which `OrgRoleGuard` reads for API keys, consent policy
-- and erasure. The write path does not touch it. A custom role is assigned by
-- setting `role_id` ALONE, so it redefines what the person may do with CRM
-- records and changes nothing about the tenant-role tier - exactly the split
-- 0039's fallback join (`r.id = m.role_id OR (m.role_id IS NULL AND r.key =
-- m.role)`) was already built to express.
COMMENT ON COLUMN memberships.role_id IS
  'The role whose role_permissions grid applies to this member (0039). '
  'Assigned from the owner console. Independent of `role`, which stays the '
  'five-value tenant tier OrgRoleGuard reads - a custom role narrows or '
  'redefines CRM object grants and confers no API-key, policy or erasure '
  'rights.';
