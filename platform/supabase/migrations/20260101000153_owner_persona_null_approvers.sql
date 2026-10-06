-- 0153_owner_persona_null_approvers.sql - a workspace's actual owner may be a
-- telecaller's approver again.
--
-- `memberships.owner_role` is nullable and `resolveOwnerRole(null)` returns
-- 'owner' (packages/shared/src/roles.ts, fail-open by design). A null persona IS
-- the owner persona. 0140's `telecaller_reports_to_guard()` tests
-- `m.owner_role IN ('owner', 'manager')`, so it REFUSES a reports-to target
-- whose membership carries no persona - raising 23514 on the one person who most
-- obviously qualifies.
--
-- ── WHERE THE NULLS COME FROM ───────────────────────────────────────────────
--
-- Not from age. 0018 backfilled `owner_role = 'owner'` onto every `org_admin`
-- membership that existed when it ran. The live source is
-- `POST /v1/members` (modules/tenancy/members.controller.ts), the operator
-- console's Members screen, whose INSERT never sets the column and whose
-- ON CONFLICT ... DO UPDATE does not touch it either. That omission is
-- deliberate - 0018's header explains that an operator's tenant-role edit must
-- never regrade a live owner-console login - so these rows stay null for good,
-- and the people holding them hold the owner persona.
--
-- ── WHY A MIGRATION AND NOT AN EDIT TO 0140 ─────────────────────────────────
--
-- 0140 has been applied, so its text is history. The function is replaceable, so
-- this restates it whole with the predicate corrected. Nothing else about it
-- changes: same name, same trigger, same error message and SQLSTATE.
--
-- 0151's `telecaller_escalate_to_guard()` already got this right -
-- `COALESCE(m.owner_role, 'owner') IN ('owner', 'manager')`, with the comment
-- "NULL is the pre-persona owner, the resolveOwnerRole rule." This brings 0140's
-- sibling guard into line with it, so the two cannot disagree about who is
-- senior to a telecaller.
--
-- The API-side mirrors of this predicate are corrected in the same change:
-- owner-attendance.controller.ts (the approver list, the reports-to check and
-- the "no WhatsApp number" warning), call-access.controller.ts and
-- setup.controller.ts. Nothing here widens who may do anything: it admits the
-- owner persona the rest of the product already recognises, and a telecaller is
-- still refused.

CREATE OR REPLACE FUNCTION telecaller_reports_to_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.reports_to_membership_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.id = NEW.reports_to_membership_id
       AND m.org_id = NEW.org_id
       -- NULL is the pre-persona owner, the resolveOwnerRole rule.
       AND COALESCE(m.owner_role, 'owner') IN ('owner', 'manager')
  ) THEN
    RAISE EXCEPTION 'a telecaller can only report to an owner or manager of the same workspace'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
