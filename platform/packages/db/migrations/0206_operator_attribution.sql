-- 0206_operator_attribution.sql
--
-- Who onboarded each client, and therefore which operators may see it.
-- Doc 49 P13b, with one deliberate departure from the plan - see §0.
--
-- ── 0. WHAT THE PLAN ASKED FOR, AND WHY HALF OF IT IS NOT HERE ──────────────
--
-- Doc 49 P13b asks for four things. This migration does two of them, and the
-- omission is a correction rather than a shortfall.
--
-- IT ASKS FOR `platform_operators.role text CHECK (role IN ('root',
-- 'superadmin'))`, observing that `platform_operators` has no role column and
-- that "the root appoints an address" is a convention rather than a mechanism.
-- The first half is true. The second is not: the mechanism exists and is
-- deliberately NOT in this table.
--
-- `isMax()` (apps/web/lib/owner-context.ts) and `OperatorsController.root()`
-- both resolve the root from `PLATFORM_ROOT_OPERATOR_EMAIL` in the
-- environment, and 0089's own header states the argument for that at length:
--
--   "the root is what authorises changes to the table, so a root that lived IN
--    the table could be deleted by anything that reached the table - a stray
--    admin key, a future endpoint with a missing check, a SQL injection - and
--    replaced with an attacker's address. Keeping it out of the database means
--    the worst case is a table full of unwanted operators that the real root
--    can still delete, rather than a platform with a new owner."
--
-- Adding `role = 'root'` to this table would move the platform's ownership
-- into a row that any write path can reach. That is strictly worse than what
-- exists, so the role column is not added, and nothing in the console or the
-- API reads a role from the database. Root is `PLATFORM_ROOT_OPERATOR_EMAIL`,
-- as it already was.
--
-- The plan's related instruction - that `PLATFORM_OPERATOR_EMAILS` become
-- root-only so an env list cannot silently grant root - is also already
-- satisfied: that variable grants OPERATOR, never root, and `isMax` consults a
-- different variable entirely.
--
-- What IS missing, and what this migration adds, is the other half: nothing
-- records who onboarded a client, so "a superadmin sees the clients they
-- onboarded" could not be expressed at all.
--
-- ── 1. THE SNAPSHOT, AND WHY BOTH COLUMNS ──────────────────────────────────
--
-- `onboarded_by_role` is not redundant beside the email. An operator can be
-- promoted or demoted later - today that means being added to or removed from
-- `PLATFORM_ROOT_OPERATOR_EMAIL` - and the visibility of a client they
-- onboarded must not move under them.
--
-- Without the snapshot, demoting a root to superadmin would retroactively
-- reveal every client they ever onboarded to every other superadmin, because
-- the rule "root-onboarded clients are invisible to superadmins" would start
-- reading their old work as superadmin work. The same reasoning 0147 used for
-- `reported_by_role`: a role recorded at the time is a fact, a role looked up
-- later is an opinion that changes.

BEGIN;

ALTER TABLE organizations
  /**
   * The operator who provisioned this client, lower-cased.
   *
   * NOT a foreign key to `platform_operators(email)`, deliberately, and this
   * is the opposite choice from the plan's. Three reasons:
   *
   *   - the ROOT is not a row in that table and never will be (see §0), so an
   *     FK would make it impossible to record the most common onboarder;
   *   - an operator who leaves is deleted from that table, and ON DELETE SET
   *     NULL would erase the attribution of every client they ever onboarded -
   *     which is exactly the history this column exists to keep;
   *   - a self-serve signup has no operator at all.
   *
   * So it is a recorded address, like `call_issue_reports.reported_by_name`:
   * a snapshot of who did something, which stays true after they are gone.
   */
  ADD COLUMN IF NOT EXISTS onboarded_by_operator text,
  /**
   * What that operator WAS when they did it. 'self_serve' for a tenant that
   * bought itself and had no operator.
   */
  ADD COLUMN IF NOT EXISTS onboarded_by_role text,
  /** When, for the operator console's client table. */
  ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_onboarded_by_role_check;
ALTER TABLE organizations ADD CONSTRAINT organizations_onboarded_by_role_check
  CHECK (onboarded_by_role IS NULL
         OR onboarded_by_role IN ('root', 'superadmin', 'self_serve'));

-- An email with no role, or a role with no email, is a half-written record that
-- the scope predicate would have to guess about. 'self_serve' is the one role
-- that legitimately has no email.
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_onboarded_consistent;
ALTER TABLE organizations ADD CONSTRAINT organizations_onboarded_consistent
  CHECK (
    (onboarded_by_operator IS NULL AND onboarded_by_role IS NULL)
    OR (onboarded_by_role = 'self_serve' AND onboarded_by_operator IS NULL)
    OR (onboarded_by_operator IS NOT NULL
        AND onboarded_by_role IN ('root', 'superadmin')
        AND onboarded_by_operator = lower(btrim(onboarded_by_operator))
        AND onboarded_by_operator <> '')
  );

COMMENT ON COLUMN organizations.onboarded_by_operator IS
  'The operator who provisioned this client, lower-cased. NULL for a tenant '
  'that existed before this column and for a self-serve signup. Deliberately '
  'NOT a foreign key: the root is not a row in platform_operators, and an '
  'operator who leaves must not take the attribution of their clients with '
  'them.';

COMMENT ON COLUMN organizations.onboarded_by_role IS
  'What the onboarder WAS at the time - a snapshot, like 0147''s '
  'reported_by_role. Without it, demoting a root to superadmin would '
  'retroactively reveal every client they ever onboarded to every other '
  'superadmin.';

-- The scope predicate's only index. Partial: most reads are the root's, which
-- do not filter at all, so the index exists for the superadmin case.
CREATE INDEX IF NOT EXISTS organizations_onboarded_by_idx
  ON organizations (onboarded_by_operator)
  WHERE onboarded_by_operator IS NOT NULL;

-- ── 2. THE BACKFILL, AND WHY IT IS CONSERVATIVE ────────────────────────────
--
-- Every existing tenant predates this column and has no attributable creator.
-- The plan's instruction is to set them to the root, which means superadmins
-- see none of them - conservative, and consistent with the rule as stated.
--
-- Done as root WITHOUT an email, which needs a word of explanation: the root's
-- address lives in the environment and a migration cannot read it. Writing a
-- guessed address would be a fabricated audit record, which is worse than an
-- honest absence - so the ROLE is recorded and the email is left NULL.
--
-- The consistency CHECK above would refuse that pair, which is correct of it
-- for a NEW record. So the pre-existing tenants are left entirely unattributed
-- (both columns NULL) and `operatorOrgScope` treats an unattributed client as
-- ROOT-ONLY. That is the same visibility the plan asked for, expressed as
-- "nobody onboarded this on the record" rather than as a half-true row.
--
-- One statement, so the intent is in the migration rather than in a note:
DO $$
DECLARE unattributed int;
BEGIN
  SELECT count(*) INTO unattributed
    FROM organizations WHERE onboarded_by_operator IS NULL AND onboarded_by_role IS NULL;
  RAISE NOTICE
    '0206: % existing organization(s) have no onboarding attribution. They are '
    'visible to the ROOT only, which is the conservative reading of doc 49 '
    'P13b. Attribute them by hand if a superadmin should manage one.',
    unattributed;
END $$;

COMMIT;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--
--   \d+ organizations
--
--   -- a half-written record is refused:
--   UPDATE organizations SET onboarded_by_operator = 'ops@example.com' WHERE id = '...';
--   -- → ERROR: violates organizations_onboarded_consistent  (no role)
--
--   -- an un-normalised address is refused:
--   UPDATE organizations SET onboarded_by_operator = 'Ops@Example.com',
--                            onboarded_by_role = 'superadmin' WHERE id = '...';
--   -- → ERROR: violates organizations_onboarded_consistent  (not lower-cased)
--
--   -- and a self-serve signup carries a role with no email:
--   UPDATE organizations SET onboarded_by_role = 'self_serve',
--                            onboarded_by_operator = NULL WHERE id = '...';
--   -- → OK
