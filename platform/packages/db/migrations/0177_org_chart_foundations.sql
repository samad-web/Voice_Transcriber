------------------------------------------------------------------------------
-- 0177_org_chart_foundations.sql - who is who in the business, as a tree of
-- SEATS (Build docs/org-chart-build-plan.md §4, M1).
--
-- ── THE ONE DECISION EVERYTHING ELSE FOLLOWS FROM ───────────────────────────
--
-- §1.1: positions are modelled separately from people. A `positions` row is a
-- SEAT - "Head of Sales, South" - with a purpose, responsibilities and a
-- spending authority. A `position_assignments` row is a person sitting in it
-- for a date range. The tree is made of seats.
--
-- This platform already knows who works here, three times over, and none of
-- the three is a hierarchy:
--
--   · `memberships`  - a user's tier (`role`) and console persona
--                      (`owner_role`). Three personas, flat. It answers "what
--                      may Priya open", never "who does Priya report to".
--   · `telecallers`  - the identity a CALL and a LEAD are attributed to, which
--                      may have no `users` row at all (0017 made `user_id`
--                      nullable so a name that never logged in still owns its
--                      calls).
--   · `roles` + `role_permissions` (0039) - what a role may DO with a record.
--
-- So the reporting line genuinely did not exist anywhere before this file, and
-- the three things above are deliberately NOT extended to carry it. A
-- `memberships.manager_user_id` would have been the small change, and it would
-- have been wrong in the way §1.1 exists to prevent: it dies with the person.
-- When a manager resigns, their reports' `manager_user_id` points at a
-- disabled user and the business has no record of the seat that is now empty -
-- which is precisely the Tuesday this module is for.
--
-- ── WHAT THE SPEC ASKED FOR AND DID NOT GET, WITH REASONS ───────────────────
--
-- 1. `org_id` ON EVERY TABLE, including the four §4.2 leaves it
--    (position_responsibility, position_authority, position_skill,
--    contract_document) without one. Not tidiness: `packages/db/verify-rls.js`
--    fails the build for any public table that is neither org-scoped nor on a
--    hand-reviewed allowlist, and it is right to. A child table reachable only
--    through its parent is still a table an `aura_app` session can SELECT
--    directly, and RLS has no concept of "only via a join".
--
-- 2. MONEY IS `numeric`, NOT `BIGINT` minor units. §4.2 says `limit_minor
--    BIGINT`. Every money column this platform has - `invoices.total`,
--    `payments.amount`, `products.price` - is `numeric`, and
--    `packages/shared/src/money.ts` already owns the integer arithmetic for
--    the JavaScript side. A BIGINT-paise authority limit sitting beside a
--    numeric invoice total would put `round(total * 100)` in the middle of
--    every approval comparison. Same call the finance module made; see
--    ORG_CHART_DECISIONS.md §3.
--
-- 3. NO CYCLES IS A TRIGGER, not only an application check. §16 requires the
--    integrity rules to hold "under every write path", and an application
--    check does not hold for a psql session, a backfill script or the next
--    controller somebody writes. See `org_chart_assert_acyclic` below.
--
-- 4. "EXACTLY ONE SOLID MANAGER AT ANY DATE" is enforced as "at most one OPEN
--    solid line", by a partial unique index. The full statement needs an
--    exclusion constraint over a daterange, which needs btree_gist, which
--    0042 records this platform cannot assume `CREATE EXTENSION` for on a
--    hosted Postgres. The historical half is checked in the API and reported
--    by `integrityProblems` on read - which is also the only place it can be
--    REPAIRED from. Same shape for one-primary-holder.
--
-- ── WHAT IS NOT IN THIS FILE ────────────────────────────────────────────────
--
-- Contracts, their documents and the document access log are 0178 - M7 is a
-- separate milestone with a separate permission object, and the restricted
-- half of this module should be reviewable on its own.
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- Departments and teams
--
-- Both OPTIONAL on a position, and that is the whole design: §13's M4
-- acceptance is "an owner can build a 3-level org from scratch", and demanding
-- a department first would put a taxonomy decision between somebody and their
-- first position. A 9-person business has no departments and should never be
-- asked to invent them.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS departments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  -- One of the kit's `--color-label-*` pairs, by name ('violet'|'plum'|
  -- 'teal'|'steel'), never a hex literal. §3 forbids colour literals, and a
  -- '#8b5cf6' in this column would be a token the dark-mode stylesheet cannot
  -- override. NULL means "derive one from the name", which `avatarToneFor`
  -- does deterministically.
  color_tag            text,
  -- Self-referencing, for §4.2's nested departments. ON DELETE SET NULL
  -- rather than CASCADE: deleting "Commercial" must not silently delete
  -- "Sales" and every position in it.
  parent_department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive, because "Sales" and "sales" are one department and the
-- person who creates the second one will not be the person who notices.
CREATE UNIQUE INDEX IF NOT EXISTS departments_org_name
  ON departments (org_id, lower(name));
CREATE INDEX IF NOT EXISTS departments_org_parent
  ON departments (org_id, parent_department_id);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON departments
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON departments TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON departments FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON departments FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER departments_set_updated_at BEFORE UPDATE ON departments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- Positions - the seats
--
-- `teams` is created after this and `positions.team_id` is added as a
-- constraint afterwards, because the two tables reference each other:
-- §4.2 gives a team a `lead_position_id` and a position a `team_id`. Neither
-- can be created second without a forward reference, so both columns are
-- declared bare and both foreign keys are added at the end of this section.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS positions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title          text NOT NULL,
  department_id  uuid REFERENCES departments(id) ON DELETE SET NULL,
  -- FK added below, after `teams` exists.
  team_id        uuid,
  -- §4.1's "level". Advisory and nullable: the DEPTH of a seat is derived from
  -- the reporting lines (`depthMapOf`) and is always correct, whereas a stored
  -- level is a label a business uses for grade or band ("L4", "M2") and goes
  -- stale the moment somebody is moved. Two numbers that both look like depth,
  -- one of them wrong, is worse than one.
  level          int CHECK (level IS NULL OR (level >= 0 AND level <= 50)),
  purpose        text,
  -- ── WHY ONLY `frozen` IS REALLY STORED HERE ──────────────────────────────
  --
  -- `filled` and `vacant` are DERIVED from whether a primary assignment covers
  -- the date being viewed (`derivePositionStatus`), and the API recomputes them
  -- on every read rather than trusting this column. Storing `filled` and then
  -- letting an assignment lapse without rewriting it is exactly how a chart
  -- ends up showing somebody who left in March.
  --
  -- The column exists for `frozen`, which is the only one of the three that is
  -- a DECISION rather than an observation: headcount withdrawn, hiring paused.
  -- A frozen seat must not appear as a vacancy to fill or raise §10's
  -- "vacant for more than N days" alert, and no amount of looking at
  -- assignments can tell you that.
  status         text NOT NULL DEFAULT 'filled'
                   CHECK (status IN ('filled', 'vacant', 'frozen')),
  sort_order     int NOT NULL DEFAULT 0,
  color_tag      text,
  -- §4.3's effective dating. A position that does not exist yet (a seat
  -- approved for next quarter) and one that was abolished are both real
  -- states, and both have to be invisible on an as-of view before/after them.
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT positions_dates_ordered
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS positions_org_dept    ON positions (org_id, department_id);
CREATE INDEX IF NOT EXISTS positions_org_team    ON positions (org_id, team_id);
CREATE INDEX IF NOT EXISTS positions_org_status  ON positions (org_id, status);
-- The chart's own read: every live seat for an org, in render order.
CREATE INDEX IF NOT EXISTS positions_org_live
  ON positions (org_id, effective_from, sort_order);

ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON positions
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON positions TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON positions FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON positions FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER positions_set_updated_at BEFORE UPDATE ON positions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- Teams
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS teams (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department_id    uuid REFERENCES departments(id) ON DELETE SET NULL,
  name             text NOT NULL,
  -- The SEAT that leads the team, not the person. Same §1.1 argument: a team
  -- whose lead resigned still has a lead seat, now vacant.
  lead_position_id uuid REFERENCES positions(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS teams_org_name ON teams (org_id, lower(name));
CREATE INDEX IF NOT EXISTS teams_org_dept ON teams (org_id, department_id);

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON teams
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON teams TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON teams FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON teams FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER teams_set_updated_at BEFORE UPDATE ON teams
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The forward reference, now that both tables exist.
DO $$ BEGIN
  ALTER TABLE positions
    ADD CONSTRAINT positions_team_id_fkey
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- Reporting lines - the edges
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reporting_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id         uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  -- ── CASCADE ON ONE END, RESTRICT ON THE OTHER ────────────────────────────
  --
  -- Deleting a seat deletes the line BY WHICH IT REPORTED (cascade above):
  -- that line describes the deleted seat and means nothing without it.
  --
  -- Deleting a seat that others report TO is REFUSED here, and that refusal is
  -- the backstop for §4.3's "deleting a position with reports is blocked until
  -- reports are reassigned". The API checks it first and gives a usable error;
  -- this constraint is what holds when something bypasses the API. A CASCADE
  -- here would silently detach a whole branch from the tree - the single most
  -- destructive thing a mis-click in this module could do.
  manager_position_id uuid NOT NULL REFERENCES positions(id) ON DELETE RESTRICT,
  type                text NOT NULL DEFAULT 'solid' CHECK (type IN ('solid', 'dotted')),
  effective_from      date NOT NULL DEFAULT CURRENT_DATE,
  effective_to        date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- A seat cannot report to itself. The ONE cycle a CHECK can see; the general
  -- case is the trigger below.
  CONSTRAINT reporting_lines_not_self CHECK (position_id <> manager_position_id),
  CONSTRAINT reporting_lines_dates_ordered
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- §4.2's minimum index list, plus the one the chart actually reads.
CREATE INDEX IF NOT EXISTS reporting_lines_org_manager
  ON reporting_lines (org_id, manager_position_id);
CREATE INDEX IF NOT EXISTS reporting_lines_org_position_from
  ON reporting_lines (org_id, position_id, effective_from);

-- ── "EXACTLY ONE SOLID MANAGER", as far as an index can say it ─────────────
--
-- At most one OPEN solid line per seat. The date-ranged statement needs an
-- exclusion constraint over a daterange and therefore btree_gist, which 0042
-- records cannot be assumed available to the migration role here.
--
-- This is the half that matters in practice: every live chart read resolves
-- the line with no `effective_to`, and a second open line is the state that
-- makes `parentMapAsOf` pick one arbitrarily. Historical overlaps are checked
-- in the API before a write and reported by `integrityProblems` on read.
CREATE UNIQUE INDEX IF NOT EXISTS reporting_lines_one_open_solid
  ON reporting_lines (org_id, position_id)
  WHERE type = 'solid' AND effective_to IS NULL;

ALTER TABLE reporting_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting_lines FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON reporting_lines
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting_lines TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON reporting_lines FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON reporting_lines FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER reporting_lines_set_updated_at BEFORE UPDATE ON reporting_lines
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- §4.3's first MUST: no cycles, under EVERY write path
--
-- ── WHY A TRIGGER AND NOT ONLY THE APPLICATION CHECK ────────────────────────
--
-- §16's definition of done: "Integrity rules (no cycles, one manager, one
-- primary holder) hold under every write path." `wouldCycle` in
-- org-chart-tree.ts runs in the move endpoint and gives the person a usable
-- message. It does not run for a psql session, a backfill script, a restored
-- dump, or the second controller somebody adds in six months - and a cycle is
-- not a cosmetic fault. A ring has no root, `rootsOf` returns nothing for it,
-- and the chart renders EMPTY. The whole page goes dark for every user in the
-- tenant until somebody finds the two rows.
--
-- So the rule lives where no write can get around it.
--
-- ── WHY IT WALKS UP RATHER THAN DOWN ───────────────────────────────────────
--
-- A recursive CTE from the new manager upward touches the ancestors - at most
-- the depth of the tree, a handful of rows - and asks whether the reporting
-- seat is among them. Walking DOWN from the reporting seat would touch its
-- whole subtree, which for a root is the entire organization on every edit.
--
-- `effective_to IS NULL` only: this checks the LIVE shape. A historical line
-- cannot create a live cycle, and including closed lines would refuse a
-- perfectly legal move whose old line happens to still be in the table - which
-- is every move, since §4.3 forbids overwriting history.
--
-- Dotted lines are exempt. §4.1 makes them secondary and unlimited, and a
-- dotted line to one's own manager is a normal matrix arrangement rather than
-- a fault. Only the solid chain has to be a tree.
------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION org_chart_assert_acyclic() RETURNS trigger AS $$
DECLARE
  offending uuid;
BEGIN
  IF NEW.type <> 'solid' OR NEW.effective_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  WITH RECURSIVE up(position_id, depth) AS (
    SELECT NEW.manager_position_id, 0
    UNION ALL
    SELECT rl.manager_position_id, up.depth + 1
      FROM reporting_lines rl
      JOIN up ON up.position_id = rl.position_id
     WHERE rl.org_id = NEW.org_id
       AND rl.type = 'solid'
       AND rl.effective_to IS NULL
       -- The depth bound is a guard, not a limit: if a ring somehow already
       -- exists, the recursion must terminate so the INSERT reports it rather
       -- than hanging the connection that is trying to fix it. 60 is well
       -- past any real hierarchy (`integrityProblems` reports the ring).
       AND up.depth < 60
  )
  SELECT position_id INTO offending FROM up WHERE position_id = NEW.position_id LIMIT 1;

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION
      'reporting line would make position % its own manager', NEW.position_id
      USING ERRCODE = 'check_violation',
            HINT = 'A position cannot report to one of its own reports.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER reporting_lines_acyclic
    BEFORE INSERT OR UPDATE OF position_id, manager_position_id, type, effective_to
    ON reporting_lines
    FOR EACH ROW EXECUTE FUNCTION org_chart_assert_acyclic();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- Assignments - a person in a seat, for a while
--
-- `position_assignments`, not `assignments`. Three tables here already end in
-- `_assignments` (`lead_routing_assignments`, `telecaller_shift_assignments`),
-- and a bare `assignments` in a schema with 200 tables is a name that tells
-- the next reader nothing about what is assigned to what.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS position_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id     uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  -- ── `users`, NOT `telecallers` ────────────────────────────────────────────
  --
  -- A seat is held by a person who can log in, be invited, own a deal and
  -- appear in `sales_targets`. `telecallers` is the identity a CALL is
  -- attributed to and may have no `users` row at all (0017).
  --
  -- The cost of that choice is stated rather than hidden: a telecaller with no
  -- `users` row cannot be put in a seat, so the chart cannot show them. That
  -- is the same nullable bridge the analytics rebuild is limited by, it is
  -- visible on the assign screen ("this person has no login yet"), and the fix
  -- is to invite them - not to make a seat holdable by an identity that cannot
  -- read its own responsibilities.
  --
  -- ON DELETE CASCADE: a deleted user's assignment history goes with them,
  -- which is what a data-erasure request means. The seat survives, vacant,
  -- and `org_change_log` keeps the fact that it was once held.
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_type text NOT NULL DEFAULT 'primary'
                    CHECK (assignment_type IN ('primary', 'acting')),
  start_date      date NOT NULL DEFAULT CURRENT_DATE,
  end_date        date,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT position_assignments_dates_ordered
    CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS position_assignments_org_position_start
  ON position_assignments (org_id, position_id, start_date);
CREATE INDEX IF NOT EXISTS position_assignments_org_user
  ON position_assignments (org_id, user_id);

-- §4.3's "one primary holder per position at any date", in the same reduced
-- form as the solid-line index above and for the same btree_gist reason: at
-- most one OPEN primary assignment. Acting holders are deliberately outside
-- the index - §4.1 makes them additional, and an acting cover that could not
-- overlap the primary would be useless.
CREATE UNIQUE INDEX IF NOT EXISTS position_assignments_one_open_primary
  ON position_assignments (org_id, position_id)
  WHERE assignment_type = 'primary' AND end_date IS NULL;

ALTER TABLE position_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_assignments FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON position_assignments
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON position_assignments TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON position_assignments FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON position_assignments FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER position_assignments_set_updated_at BEFORE UPDATE ON position_assignments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- What the seat is FOR - §6.2
--
-- Three child tables, all replaced wholesale by a PUT (§8). `sort_order` is
-- the array index: §6.2 calls responsibilities an "editable ordered list", the
-- order IS the data, and reordering four items through per-row PATCHes is four
-- requests that can half-apply.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS position_responsibilities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  text        text NOT NULL,
  category    text,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS position_responsibilities_position
  ON position_responsibilities (org_id, position_id, sort_order);

ALTER TABLE position_responsibilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_responsibilities FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON position_responsibilities
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON position_responsibilities TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON position_responsibilities FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON position_responsibilities FROM PUBLIC;

CREATE TABLE IF NOT EXISTS position_authorities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  -- An open slug set, like `sales_targets.metric`. §4.2 gives three examples,
  -- and a CHECK built from three examples is a migration every time a business
  -- discovers a fourth thing it approves. The SHAPE is enforced in
  -- `AuthorityActionKey` because this key is what §9's finance lookup finds an
  -- approval BY - and a missed lookup means an approval that needs nobody.
  action      text NOT NULL,
  -- `numeric`, not BIGINT minor units. See this file's header, point 2.
  limit_num   numeric CHECK (limit_num IS NULL OR limit_num >= 0),
  limit_percent numeric CHECK (limit_percent IS NULL
                               OR (limit_percent >= 0 AND limit_percent <= 100)),
  currency    char(3),
  -- Who must approve beyond the limit. A SEAT, so it survives the approver
  -- leaving. ON DELETE SET NULL: with no nominated approver the API falls back
  -- to the solid line, which is a working answer - a dangling id is not.
  requires_approval_from_position_id uuid REFERENCES positions(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- An amount limit with no currency cannot be compared to anything. Mirrors
  -- the same refinement in `AuthorityInput`, so the API's message and the
  -- database's agree.
  CONSTRAINT position_authorities_amount_has_currency
    CHECK (limit_num IS NULL OR currency IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS position_authorities_position
  ON position_authorities (org_id, position_id);
-- One row per (seat, action): two limits for the same action is a question
-- with two answers, and `authorityVerdict` would take whichever came back
-- first.
CREATE UNIQUE INDEX IF NOT EXISTS position_authorities_position_action
  ON position_authorities (org_id, position_id, action);

ALTER TABLE position_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_authorities FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON position_authorities
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON position_authorities TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON position_authorities FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON position_authorities FROM PUBLIC;

CREATE TABLE IF NOT EXISTS position_skills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  skill       text NOT NULL,
  required    bool NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS position_skills_position
  ON position_skills (org_id, position_id);
CREATE UNIQUE INDEX IF NOT EXISTS position_skills_position_skill
  ON position_skills (org_id, position_id, lower(skill));

ALTER TABLE position_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_skills FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON position_skills
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON position_skills TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON position_skills FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON position_skills FROM PUBLIC;

------------------------------------------------------------------------------
-- §9's KPI seam: default targets a seat carries
--
-- "A position can carry default KPI templates; assigning a person to the
-- position prefills their KPI set and targets."
--
-- `sales_targets` (0050) is this platform's target record - `(owner_user_id,
-- period_start, period_end, metric, target_value)` - so a "KPI template" here
-- is a metric and a value with NO period, and assigning somebody stamps it
-- into `sales_targets` for the current period. No second targets system, which
-- is the whole point: a KPI that exists in two tables is a number the
-- scorecard and the chart disagree about.
--
-- Doc 41 records that this platform has no KPI CATALOGUE yet (no composite
-- score, no per-metric definition table). When one lands, this table's
-- `metric` column is the join to it. Until then `metric` is validated against
-- `TargetMetric` in the API, exactly as `sales_targets.metric` is.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS position_kpi_defaults (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  position_id  uuid NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  metric       text NOT NULL,
  target_value numeric NOT NULL CHECK (target_value > 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS position_kpi_defaults_position_metric
  ON position_kpi_defaults (org_id, position_id, metric);

ALTER TABLE position_kpi_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_kpi_defaults FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON position_kpi_defaults
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON position_kpi_defaults TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON position_kpi_defaults FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON position_kpi_defaults FROM PUBLIC;

------------------------------------------------------------------------------
-- §14's per-org knobs
--
-- Every column NULLable with NO DEFAULT, deliberately. The defaults live in
-- `ORG_CHART_DEFAULTS` (packages/shared/src/org-chart.ts) and the API
-- coalesces to them. A `DEFAULT 14` here would be a second copy of §14's
-- table, and the column would quietly win - so a change to the shared default
-- would reach new orgs only, which is the hardest kind of inconsistency to
-- notice. Same reasoning as `finance_settings` (0172).
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_chart_settings (
  org_id                uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  collapse_beyond_level int  CHECK (collapse_beyond_level IS NULL OR collapse_beyond_level >= 1),
  vacancy_alert_days    int  CHECK (vacancy_alert_days IS NULL OR vacancy_alert_days >= 1),
  span_of_control_max   int  CHECK (span_of_control_max IS NULL OR span_of_control_max >= 1),
  span_of_control_min   int  CHECK (span_of_control_min IS NULL OR span_of_control_min >= 0),
  -- §14: "Manager edit rights: can edit responsibilities of direct reports -
  -- off by default".
  manager_edits_reports bool,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE org_chart_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_chart_settings FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON org_chart_settings
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON org_chart_settings TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON org_chart_settings FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON org_chart_settings FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER org_chart_settings_set_updated_at BEFORE UPDATE ON org_chart_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- §4.2's change log - and why it is not `audit_log`
--
-- `audit_log` (0001) already records who did what: `(actor_type, actor_id,
-- action, target_type, target_id, meta)`. Every write in this module writes
-- there too, like every other module.
--
-- This table is a different thing wearing a similar shape, and §6.5 is the
-- reason. The History tab is a TIMELINE A CUSTOMER READS - "moved from
-- Operations to Sales, effective 1 April, because the region was split" - and
-- it needs two columns `audit_log` has no concept of:
--
--   · `effective_date`, which is NOT `at`. A reorganization decided on 12
--     March and effective 1 April has two dates, and the timeline has to show
--     the second while the audit trail records the first. Collapsing them
--     makes §8's as-of view irreproducible from history, which is §16's
--     acceptance criterion.
--   · `before`/`after` as structured JSONB, so the tab can render "Head of
--     Sales -> Head of Revenue" rather than a sentence somebody wrote at the
--     call site.
--
-- Putting those on `audit_log` would mean two nullable columns on the busiest
-- table in the schema, meaningful for one module. §6.5's timeline reads this;
-- security review reads `audit_log`. Both are written, in one transaction.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_change_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- `audit_log`'s own vocabulary, for the reason `auditActor` exists: a
  -- platform operator acting on a tenant has no `users` row, and recording
  -- them as a user called "admin-key" makes the one actor a customer most
  -- needs to name in their own history the one it cannot.
  actor_type     text NOT NULL CHECK (actor_type IN ('user', 'operator', 'system')),
  actor_id       text NOT NULL,
  entity         text NOT NULL CHECK (entity IN
                   ('position', 'reporting_line', 'assignment', 'responsibility',
                    'authority', 'skill', 'contract', 'document', 'department', 'team')),
  -- text, not uuid: §6.5 must survive the row it describes being deleted, and
  -- a FK would either refuse the delete or cascade the history away with it.
  entity_id      text NOT NULL,
  action         text NOT NULL CHECK (action IN
                   ('create', 'update', 'move', 'assign', 'unassign', 'delete')),
  before         jsonb,
  after          jsonb,
  reason         text,
  -- When the change TAKES EFFECT, in the org's own reckoning of the day.
  -- Nullable: a responsibility edit takes effect immediately and has no
  -- effective date to invent.
  effective_date date,
  at             timestamptz NOT NULL DEFAULT now()
);

-- The History tab: one entity's story, newest first.
CREATE INDEX IF NOT EXISTS org_change_log_entity
  ON org_change_log (org_id, entity, entity_id, at DESC);
-- The whole org's recent activity.
CREATE INDEX IF NOT EXISTS org_change_log_org_at
  ON org_change_log (org_id, at DESC);

ALTER TABLE org_change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_change_log FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON org_change_log
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- ── NO UPDATE, NO DELETE — AND A GRANT ALONE DOES NOT ACHIEVE THAT ─────────
--
-- §2: "Audit: append-only change log", so a bug or an injected statement must
-- not be able to rewrite the record of a reorganization.
--
-- A narrower `GRANT SELECT, INSERT` DOES NOT DO IT, and this was verified
-- against a real database rather than assumed. 0001_init.sql ends with
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aura_app;
--
-- so every table created in this schema arrives with all four verbs already
-- granted. A GRANT of a subset is a no-op on top of something wider, and the
-- file reads as though it worked - the same trap 0053 records for the
-- `marketing` schema's public web role, in a schema nobody expects it in.
--
-- The REVOKE is the mechanism. 0001 does exactly this for `audit_log` and
-- `usage_events`, which are the only two genuinely append-only tables in the
-- schema today; `has_table_privilege('aura_app','org_change_log','UPDATE')`
-- is the one-line check that proves it.
GRANT SELECT, INSERT ON org_change_log TO aura_app;
REVOKE UPDATE, DELETE ON org_change_log FROM aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON org_change_log FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON org_change_log FROM PUBLIC;

------------------------------------------------------------------------------
-- §10's notification kinds
--
-- ── WHY ALL FOUR ARE LISTED HERE, INCLUDING 0178'S TWO ──────────────────────
--
-- `notifications.kind`'s CHECK and `NotificationKind` in
-- packages/shared/src/notifications.ts drift silently and then throw 23514 at
-- runtime - 0100's header records exactly that happening in production, and
-- `notification-kinds.test.ts` now pins them together by reading the LAST
-- CHECK in apply order.
--
-- Which is why this is the only place the list is rewritten. If 0178 added its
-- two kinds in a second CHECK, that file would have to restate all thirty-one
-- values, and the two files would be two chances to drop one. Listing
-- `contract_expiring` and `probation_ending` ahead of the tables that raise
-- them costs nothing - an unused value in a CHECK is inert - and it means a
-- rolling deploy never has a writer whose kind the constraint refuses.
------------------------------------------------------------------------------

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'task_due', 'deal_stage_changed', 'deal_idle',
                  'automation', 'report_ready', 'lead_assigned',
                  'opt_out_requested', 'channel_needs_attention',
                  'sla_breach', 'review_pending',
                  'call_access_requested',
                  'storage_quota',
                  'missed_call',
                  'task_response',
                  -- 0140: attendance (doc 33).
                  'attendance_request',
                  'attendance_break_overrun',
                  'attendance_away',
                  'attendance_review',
                  -- 0143: never started the shift.
                  'attendance_absent',
                  -- 0147: we answered a problem you reported (doc 36).
                  'call_issue_update',
                  -- 0148: the data export engine (doc 35).
                  'export_ready',
                  'export_failed',
                  'export_created',
                  -- 0151: call escalations (doc 38).
                  'call_escalated',
                  'call_escalation_update',
                  -- 0152: an invitation was taken up.
                  'invite_accepted',
                  -- 0177/0178: the org chart (§10). A seat empty too long with
                  -- reports waiting; your own reporting line or seat changed;
                  -- a contract or a probation period is running out.
                  'position_vacant',
                  'reporting_change',
                  'contract_expiring',
                  'probation_ending'));

------------------------------------------------------------------------------
-- Permission grants for `position`
--
-- `CrmPermissionsGuard` DENIES whatever it finds no grant for. Widening
-- `PermissionObjectType` without seeding here LOCKS EVERY USER OUT of the new
-- object the moment the API container restarts - 0041 records this about
-- `task`, 0059/0060 about `product`/`quotation`/`invoice`, 0103 about `lead`,
-- 0158 about `dnc` and 0165 about `resource`. One per object, learned once per
-- object, because the enum is the easy half and the seeding is the half that
-- is forgotten.
--
-- Scope is always `all`: `position` is in `ALL_SCOPE_ONLY_OBJECTS` and its
-- `OWNER_COLUMN` is null. A seat is not owned by the person sitting in it -
-- "my own position" would have to mean "the one I hold", and a chart narrowed
-- to one node is not a chart. §7's manager-sees-their-branch is a SUBTREE,
-- which the all/owned grid cannot express; it is enforced in the controller
-- against the reporting tree instead, and ORG_CHART_DECISIONS.md §4 records
-- why that is not folded in here.
--
-- CUSTOM roles are deliberately untouched - 0041's choice. Nobody has ever
-- held `position`, so there is nothing to preserve, and widening a hand-built
-- role would be a decision rather than a restoration.
------------------------------------------------------------------------------

-- `position:view` to EVERY system role including `viewer`.
--
-- §7 is explicit that a telecaller "sees the chart, names, titles,
-- departments, responsibilities and authority". That is the module's reason to
-- exist: a new joiner finding out who to ask. Nothing in `positions`,
-- `position_responsibilities` or `position_authorities` is personal - no
-- salary, no contract, no phone number - and all three of those live in 0178
-- behind their own object. Withholding `view` would leave the chart visible to
-- four people in the business, which is the opposite of the ask.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'position', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin',
                 'workspace_member', 'viewer')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `position:create`, `position:edit`, `position:delete` to the three admin
-- roles ONLY.
--
-- §14: "Who can drag-and-drop: owner/admin only". Reshaping the organization
-- is the most consequential write in this module - a move carries a whole
-- subtree with it, and §9 routes real escalations up the lines it changes. A
-- telecaller who could re-parent a seat could silently redirect every alert
-- that was meant for their manager.
--
-- `workspace_member` is deliberately absent from all three, which is a
-- narrowing of 0041's pattern and the same judgement 0136 made for
-- `lead_board` and 0165 for `resource:create`. An owner can grant any of them
-- from Team & permissions if they want a chief of staff.
--
-- `position:edit` covers the responsibilities and authority editors too, and
-- §14's "manager edit rights: off by default" is a SEPARATE axis
-- (`org_chart_settings.manager_edits_reports`) rather than a grant - because
-- it is not "may this role edit responsibilities" but "may this role edit the
-- responsibilities OF ITS OWN REPORTS", which is a row filter the grid cannot
-- express.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'position', a.action, 'all'
  FROM roles r
 CROSS JOIN (VALUES ('create'), ('edit'), ('delete')) AS a(action)
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

------------------------------------------------------------------------------
-- Prove it, rather than assume it
--
-- Every active membership must resolve to a `position:view` grant through the
-- same join the guard uses, including its `role_id IS NULL` fallback against
-- the legacy `memberships.role` string.
--
-- NOT scoped to a module, unlike 0165's equivalent: `PERMISSION_OBJECT_MODULE`
-- files `position` under `aura`, which every tenant has. So a stranded
-- membership here is a real finding rather than an expected one.
--
-- A WARNING and not an exception, for 0103's reason: this runs inside the
-- deploy's migrate job, and aborting would leave the schema half-applied and
-- the deploy dead in order to report a condition that is visible and
-- repairable from the console afterwards. A membership on a CUSTOM role is the
-- expected finding.
------------------------------------------------------------------------------

DO $do$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
    FROM memberships m
   WHERE m.status = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM roles r
         JOIN role_permissions rp
           ON rp.role_id = r.id AND rp.object_type = 'position' AND rp.action = 'view'
        WHERE r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
     );

  IF stranded > 0 THEN
    RAISE WARNING '0177: % membership(s) resolve to no position:view grant (custom roles are not seeded) - grant it on Team & permissions', stranded;
  ELSE
    RAISE NOTICE '0177: every active membership resolves to a position:view grant';
  END IF;
END $do$;

------------------------------------------------------------------------------
-- The SECOND RLS axis: the partner wall
--
-- ── WHY EVERY TABLE ABOVE NEEDS A POLICY IT DOES NOT MENTION ────────────────
--
-- `org_isolation` keys on `app.org_id` and answers "which tenant". It does not
-- answer "which KIND of principal", and this platform has a second kind: a
-- channel partner, signed in to the partner portal, whose session runs with
-- `app.partner_id` set AND a legitimate `app.org_id` for the tenant they
-- submit leads to. Against `org_isolation` alone, such a session reads every
-- row in this file.
--
-- 0163 walled every org-scoped table that existed WHEN IT RAN. It cannot wall
-- these - its enumeration can only ask the catalog about the past, and its own
-- closing assertion ("not three, not five") passed honestly. So each migration
-- that creates a tenant table carries its own wall, which is what 0165 and
-- 0166 do, and `verify-rls.js` fails the deploy for any org-scoped table that
-- has none. This block exists because that check caught these fourteen tables.
--
-- What it would otherwise expose is the whole point of the module: a partner
-- would read the tenant's entire management structure - every seat, every
-- holder, every reporting line and every spending limit. `position_authorities`
-- is the worst of them, because knowing exactly who may approve a discount and
-- up to what amount is commercially useful to the counterparty negotiating it.
--
-- RESTRICTIVE, not permissive. A permissive policy is OR-ed with
-- `org_isolation` and would WIDEN access rather than narrowing it - the one
-- failure mode here that changes nothing visible and removes the wall
-- entirely. `verify-rls.js` asserts the modifier separately.
------------------------------------------------------------------------------

DO $do$
DECLARE t text; walled int := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'departments', 'teams', 'positions', 'reporting_lines', 'position_assignments',
    'position_responsibilities', 'position_authorities', 'position_skills',
    'position_kpi_defaults', 'org_chart_settings', 'org_change_log'
  ] LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
      walled := walled + 1;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;

  -- Non-vacuity, the lesson 0163's own closing block records: a loop that
  -- walls nothing succeeds silently, and every check in this file would still
  -- report fine while the portal read the whole org chart. Eleven tables are
  -- created above; anything less means the array and the schema disagree.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'partner_wall'
         AND tablename = ANY (ARRAY['departments', 'teams', 'positions', 'reporting_lines',
                                    'position_assignments', 'position_responsibilities',
                                    'position_authorities', 'position_skills',
                                    'position_kpi_defaults', 'org_chart_settings',
                                    'org_change_log'])) < 11 THEN
    RAISE EXCEPTION '0177: only % of 11 org-chart tables are walled - refusing to leave the partner portal reading the management structure', walled;
  END IF;
  RAISE NOTICE '0177: partner_wall present on all 11 org-chart tables';
END $do$;
