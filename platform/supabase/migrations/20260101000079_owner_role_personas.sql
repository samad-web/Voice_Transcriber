-- 0079_owner_role_personas.sql - two more owner-console personas, Sales and
-- Marketing, and the assignment path that makes the whole persona model
-- usable for the first time.
--
-- WHY THIS IS MOSTLY ONE `CHECK`. 0018 built the persona column, the guards
-- read it (owner-role.guard.ts) and the sidebar filters on it (nav.ts) - but
-- `13_ROUTE_AND_GUARD_INVENTORY.md` finding 7 recorded the thing that made
-- all of it inert: "No route on the platform writes `owner_role` to anything
-- other than 'owner'." OwnersController hard-codes it at creation and nothing
-- has ever updated it, so every console login in every tenant has been an
-- owner regardless of what the person actually does. The schema change here is
-- small because the schema was never the gap; the API (owner-team.controller)
-- and the console's Team page are the rest of this change.
--
-- ── DEPLOY ORDER: CODE FIRST, THEN ASSIGN ─────────────────────────────────
--
-- `resolveOwnerRole` (packages/shared/src/roles.ts) is fail-OPEN by a
-- deliberate, documented design decision that predates this migration: a value
-- it does not recognise resolves to `owner`, the MOST permissive persona. A
-- build that predates this migration therefore reads owner_role='sales' as
-- 'owner' and hands that person the whole console.
--
-- That is only reachable when new DATA meets OLD CODE, which is exactly the
-- window a rolling deploy opens. So:
--
--   1. Deploy the API and web tiers carrying this release.
--   2. THEN assign 'sales'/'marketing' to anybody (Team page, or by hand).
--
-- Running this migration alone is safe in either order - it only widens what
-- the column will ACCEPT and changes no existing row. The hazard is writing a
-- new persona value while an old pod is still serving. Nothing here can
-- enforce that ordering, which is why it is written down.

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_owner_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_owner_role_check
  CHECK (owner_role IS NULL OR owner_role IN
    ('owner', 'manager', 'telecaller', 'sales', 'marketing'));

COMMENT ON COLUMN memberships.owner_role IS
  'Owner console persona (design doc §9) - Owner/Manager/Telecaller/Sales/Marketing. '
  'Independent of `role`, which is the OPERATOR-side tenant role (members.controller.ts) '
  'and must stay that way: reusing one column for both would let an operator''s '
  'unrelated team-management edit silently regrade owner-console access. '
  'Personas with a scope of ''own'' (telecaller, sales - see packages/shared/src/roles.ts) '
  'read only records reachable from their `telecallers` row; see owner-scope.ts.';

-- ── The self-scoping join, made cheap ─────────────────────────────────────
--
-- A persona scoped to `own` resolves its identity on EVERY request:
--   memberships.user_id -> telecallers.user_id -> leads/deals.assigned_telecaller_id
--
-- 0017 already created `telecallers_org_user` (UNIQUE, partial on user_id IS
-- NOT NULL) for precisely this lookup and called it "the future self-scoping
-- join" - that half needs nothing. The second hop is the one that had no
-- index for the direction this query runs it: 0075 indexed leads/deals on
-- (org_id, assigned_telecaller_id), which serves it, so what is left is the
-- call log, which 0068 indexed on (org_id, telecaller_id) - also fine.
--
-- What is genuinely missing is `tasks`: an own-scoped persona's dashboard
-- leads with "my tasks due today", filtered by assignee and due date together,
-- and that has only ever had single-column indexes.
-- `status = 'open'` rather than `<> 'done'`: 0041's CHECK has three values and
-- a cancelled task is not work either, so the negative form would keep every
-- abandoned row in the index for no reader.
CREATE INDEX IF NOT EXISTS tasks_org_assignee_due
  ON tasks (org_id, assignee_user_id, due_on)
  WHERE status = 'open';

-- ── Personas are NOT back-filled ──────────────────────────────────────────
--
-- Every existing membership stays exactly what it is (owner, or NULL which
-- resolves to owner). Guessing a persona from `role`, from device bindings, or
-- from who has been making calls would silently REMOVE access from live logins
-- on a deploy, which is the one thing 0018's header rules out. Personas are
-- assigned deliberately, by a human, on the Team page.
