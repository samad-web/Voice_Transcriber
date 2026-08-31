-- 0018_owner_roles.sql - the owner console's persona model: Owner / Manager /
-- Telecaller (design doc §9, Build-Order Step 1).
--
-- Deliberately a NEW column, not a reuse of memberships.role. That column
-- already drives a different concern: /v1/members (members.controller.ts)
-- lets an OPERATOR assign org_admin|workspace_admin|workspace_member|viewer
-- as tenant self-service (design doc §3.4), and its PATCH :userId updates
-- `role` by user_id alone, with no scope_type/scope_id filter - so it can
-- touch the very row that backs a live owner-console login. Reusing `role`
-- for the owner persona too would let an operator's unrelated team-management
-- edit silently regrade what that same person can do inside their own owner
-- console. Keeping them independent means that can never happen.
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS owner_role text;

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_owner_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_owner_role_check
  CHECK (owner_role IS NULL OR owner_role IN ('owner', 'manager', 'telecaller'));

COMMENT ON COLUMN memberships.owner_role IS
  'Owner console persona (design doc §9) - Owner/Manager/Telecaller. Independent '
  'of `role`, which is the OPERATOR-side tenant role (members.controller.ts) and '
  'must stay that way: reusing one column for both would let an operator''s '
  'unrelated team-management edit silently regrade owner-console access.';

-- Every membership OwnersController has ever created is role = 'org_admin'
-- (see OWNER_ROLE in owners.controller.ts), and nothing else writes that
-- value - an exact, lossless mapping. Nobody who can sign into /owner today
-- loses access.
UPDATE memberships SET owner_role = 'owner'
 WHERE role = 'org_admin' AND owner_role IS NULL;
