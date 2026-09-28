-- 0141_task_assign_up.sql - a role-level toggle for handing a task to an
-- owner or manager persona.
--
-- Task assignment has never checked WHO the assignee is beyond org
-- membership - tasks.controller.ts's `assertMembers` only confirms the
-- chosen person is a member of this org, so a telecaller could always assign
-- a follow-up to the owner. That was a deliberate reading (0135's
-- accept/decline exists precisely so being assigned is a request, not a
-- command - the owner can just decline it), but a tenant asked to be able to
-- turn it off for their own floor. So it becomes an ordinary grid cell
-- (0039) instead of an always-yes nobody could see or change.
--
-- Widening `role_permissions.action`'s CHECK first - the same drift this
-- schema has hit before when a CHECK and its zod enum moved separately
-- (notifications.kind). Both move in this one migration.
ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_action_check;
ALTER TABLE role_permissions
  ADD CONSTRAINT role_permissions_action_check
  CHECK (action IN ('view', 'create', 'edit', 'delete', 'export', 'assign_up'));

-- Seeded the same way 0041 seeded `task` itself: admin roles get it, because
-- there is no rung above platform_admin/org_admin/workspace_admin to gate.
-- workspace_member (telecaller/sales) and viewer do not - matching the
-- telecaller persona's own description, "only the leads, calls and tasks
-- assigned to them": a passive recipient by default, unless an owner turns
-- this on. Only `all` scope is ever written - assign_up is a capability, not
-- a row-level filter (see ALL_SCOPE_ONLY_ACTIONS in packages/shared).
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'task', 'assign_up', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.object_type = 'task' AND rp.action = 'assign_up'
   );
