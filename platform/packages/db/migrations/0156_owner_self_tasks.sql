-- 0156_owner_self_tasks.sql - whether an owner or a manager may put a task on
-- themselves.
--
-- ── WHY THIS IS OFF BY DEFAULT ──────────────────────────────────────────────
--
-- The owner console's task section is where the floor's work is handed out and
-- watched. An owner opening "New task" was offered their own name in the
-- assignee list alongside everybody else's, and the usual result is an owner
-- quietly accumulating a personal to-do list inside a tool the team reads as
-- "what I have been asked to do" - with an accept/decline prompt (0135) fired
-- at the person who wrote the task.
--
-- The user's words: "for an owner no need for them to create a task for
-- themselves - we should have a button for us to be able to create a task". So
-- the ability is not removed, it is switched off and put behind a switch the
-- owner can find. Off is the default BECAUSE it is the stated intent, including
-- for the tenants already running - this is one of the few migrations that
-- deliberately changes existing behaviour rather than preserving it.
--
-- ── WHAT IT DOES NOT TOUCH ──────────────────────────────────────────────────
--
-- Three things are deliberately outside this switch:
--
--   1. ASSIGN-UP (0141). A telecaller handing a task up to their manager is a
--      different act with its own grant (`task:assign_up`), and an owner who
--      has switched self-tasks off still receives those. "Assigned to me" stays
--      on the task filters for exactly that reason - it is not always empty.
--
--   2. TELECALLERS AND SALES. A rep writing their own follow-up is the normal
--      way the product is used; `assertSelfAssignAllowed` only looks at the
--      owner and manager personas.
--
--   3. TASKS ALREADY ON AN OWNER. Switching this off strands nobody: an
--      existing task stays assigned, stays answerable and stays completable.
--      The switch governs the WRITE, not the rows.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS owner_self_tasks boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.owner_self_tasks IS
  'May an owner or manager assign a task to themselves. false (the default) '
  'leaves them off their own "Assign to" list and the API refuses it. Does not '
  'affect assign-up (0141), other personas, or tasks already assigned.';
