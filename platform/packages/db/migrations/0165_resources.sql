------------------------------------------------------------------------------
-- 0165_resources.sql - the first vertical primitive (Build docs/39 §23-§24).
--
-- ── THE DELIBERATE GAP AT 0164 ──────────────────────────────────────────────
--
-- 0159-0163 are the dialer, sticky ownership, the form builder and the portal;
-- 0164 is RESERVED for the service desk (§20) and is being built in a later
-- wave. This file is 0165 rather than the next free number so the ledger keeps
-- doc 39's own numbering, which every other file in that plan refers to by
-- number. A renumber later is worse than a hole now: the plan, the rollbacks
-- and the supabase mirrors would all have to move together.
--
-- ── WHY A PRIMITIVE AND NOT A VERTICAL ──────────────────────────────────────
--
-- RSoft ships ten industry CRMs. §23 refuses that: every bespoke vertical is a
-- code path somebody maintains forever, and the eleventh customer is always in
-- the eleventh industry. A flat, a vehicle, a chair, a seat in a batch and a
-- departure date are all the same thing - something enumerated, finite and
-- holdable - so they are one table.
--
-- ── CAPACITY, NOT A BOOLEAN ─────────────────────────────────────────────────
--
-- A unique item is capacity 1. A NEET morning batch is capacity 40 and a Bali
-- departure is 18. Modelling "is it taken" as a boolean would have forced a
-- second table the first time a tenant sold a seat rather than an object, and
-- `booked_count <= capacity` is the one invariant both shapes share.
--
-- `booked_count` is maintained by the BOOKING PATH and never by a trigger. A
-- trigger on `appointments` would also fire on the reaper's cascade deletes and
-- on an org deletion, silently decrementing counts on rows that are themselves
-- about to disappear - and it would make "why is this flat free" a question
-- about trigger order rather than about a statement somebody can read.
--
-- ── resource_type IS OPEN TEXT, AND THAT IS THE WHOLE POINT ─────────────────
--
-- No CHECK. A CHECK here would be the enum of industries this part of the plan
-- exists to avoid, and the eighth tenant would need a migration to sell a thing
-- the list had not imagined. The tenant's own list is derived - the distinct
-- types already in use for the org, unioned with the suggestions their stage
-- pack carries (packages/shared/src/resources.ts) - so the console offers a
-- list without the database enforcing one.
--
-- Shape is still constrained: a snake_case identifier, because the type is a
-- key the console groups and filters on, not a label. The LABEL is the pack's
-- business, and a tenant renaming "unit" to "flat" must not re-key their stock.
--
-- ── HIERARCHY BY SELF-REFERENCE ─────────────────────────────────────────────
--
-- project -> tower -> floor -> unit, course -> batch, branch -> chair. One
-- column, because the DEPTH differs per TENANT and not merely per vertical: two
-- builders on the same plan will model four levels and two. A fixed set of
-- parent columns would be wrong for both of them.
--
-- ── CUSTOM FIELDS: §24 IS HALF RIGHT, AND THE OTHER HALF IS HERE ────────────
--
-- §24 says widening `CustomFieldObjectType` is all that is needed because
-- `custom_field_definitions.object_type` is already open text (0037). The
-- DEFINITION half is indeed free. The VALUE half is not: 0037 deliberately
-- built three parallel typed-EAV tables rather than one polymorphic one, and
-- `valueTableForObjectType()` in @aura/shared resolves to
-- `<object>_custom_field_values` - so widening the enum alone would have the
-- custom-field-values controller build SQL against a table that does not
-- exist, and the failure is a 42P01 on the first tenant who defines a field on
-- a resource. 0037's own comment anticipated this ("adding a fourth later is a
-- one-line change to the array"); the fourth table is created below, with
-- 0045's provenance columns present from the start rather than bolted on.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resources (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- See the header. Open text, snake_case, no CHECK on the VALUE.
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]*$'),

  -- Hierarchy. CASCADE: deleting a tower deletes its floors and its units,
  -- which is what a person deleting a tower means. The cycle guard below stops
  -- the trivial self-parent; deeper cycles are refused by the API, which walks
  -- the ancestors before it writes (a recursive CHECK is not expressible here).
  parent_id  uuid REFERENCES resources(id)    ON DELETE CASCADE,
  -- SET NULL, not CASCADE: retiring a project must not destroy the inventory
  -- that was sold under it. Same reasoning 0073 gives for call_projects.
  project_id uuid REFERENCES crm_projects(id) ON DELETE SET NULL,

  code      text NOT NULL CHECK (length(btrim(code)) > 0),  -- "A-1203", "MH12AB8821", "BATCH-7"
  name      text NOT NULL CHECK (length(btrim(name)) > 0),

  capacity     int NOT NULL DEFAULT 1 CHECK (capacity > 0),
  booked_count int NOT NULL DEFAULT 0 CHECK (booked_count >= 0),

  status    text NOT NULL DEFAULT 'available' CHECK (status IN
              ('available','held','booked','sold','unavailable','retired')),

  price_num numeric,
  currency  text NOT NULL DEFAULT 'INR',

  -- Everything vertical-specific that is NOT a typed field: carpet area and
  -- facing, engine number and colour, batch timing and faculty. Anything a
  -- tenant wants to filter, validate or report on goes through
  -- custom_field_definitions with object_type 'resource' instead; this holds
  -- the long tail that is only ever displayed.
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The hold. SET NULL on both, because erasing a lead or disabling a user must
  -- not delete a unit out of the inventory - it must leave the unit standing
  -- with the holder detached, the same move 0023 makes for a booked slot whose
  -- enquirer was erased. A detached hold still expires on schedule.
  held_for_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  held_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  held_until       timestamptz,

  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT resources_not_oversold CHECK (booked_count <= capacity),
  -- Both directions, deliberately. A 'held' row with no expiry is a hold
  -- nothing will ever release - the exact failure the sweep exists to prevent -
  -- and a non-held row carrying an expiry is a hold the UI will render on
  -- something that is actually free. Same shape as 0023's
  -- booking_slots_booked_has_booker.
  CONSTRAINT resources_held_has_expiry CHECK ((status = 'held') = (held_until IS NOT NULL)),
  CONSTRAINT resources_no_self_parent  CHECK (parent_id IS NULL OR parent_id <> id)
);

-- One code per type per tenant, case-insensitively: "a-1203" and "A-1203" are
-- the same flat, and two rows for it is how a unit gets sold twice. Partial on
-- `status <> 'retired'` so retiring a mis-keyed row frees the code for re-use -
-- which is exactly what somebody does after creating one by mistake.
CREATE UNIQUE INDEX IF NOT EXISTS resources_org_type_code
  ON resources (org_id, resource_type, lower(code)) WHERE status <> 'retired';

-- The sweep's only query: holds whose time is up. Partial, so it is the size of
-- the live holds rather than of the inventory.
CREATE INDEX IF NOT EXISTS resources_hold_sweep
  ON resources (held_until) WHERE status = 'held';

-- The console's list, and the two FK cascades. An un-indexed FK with ON DELETE
-- CASCADE makes deleting one parent a sequential scan of the whole table.
CREATE INDEX IF NOT EXISTS resources_org_type   ON resources (org_id, resource_type, status);
CREATE INDEX IF NOT EXISTS resources_parent     ON resources (parent_id)  WHERE parent_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS resources_project    ON resources (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS resources_held_lead  ON resources (held_for_lead_id) WHERE held_for_lead_id IS NOT NULL;

COMMENT ON TABLE resources IS
  'Something enumerated, finite and holdable (doc 39 §24): a flat, a vehicle, a chair, a seat '
  'in a batch, a departure. One table for every vertical - capacity 1 is a unique item. '
  'booked_count is maintained by the booking path, never by a trigger.';
COMMENT ON COLUMN resources.resource_type IS
  'Open text by design - a CHECK here would be the enum of industries doc 39 §23 exists to '
  'avoid. The tenant''s own list is derived from the types in use plus their stage pack''s '
  'suggestions (packages/shared/src/resources.ts).';
COMMENT ON COLUMN resources.booked_count IS
  'Maintained by the booking routes under FOR UPDATE on this row. Never by a trigger: a trigger '
  'would also fire on the reaper''s cascade deletes.';

DO $$ BEGIN
  CREATE TRIGGER resources_set_updated_at BEFORE UPDATE ON resources
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- The fourth typed-field value table (see the header on why §24 is half right)
--
-- Byte-for-byte the shape 0037 gave the other three, plus 0045's provenance
-- columns, which exist here from the start rather than as a later ALTER. The
-- default for `source` is 'human' and NOT 0045's 'extraction': 0045 chose
-- 'extraction' because every row that already existed had been written by the
-- worker, and defaulting to 'human' would have frozen the extraction out of its
-- own data. There are no rows here and nothing extracts a resource field from a
-- call - somebody types the carpet area in - so the safe backfill answer and
-- the honest default are different values, and this table wants the honest one.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS resource_custom_field_values (
  org_id      uuid NOT NULL REFERENCES organizations(id)          ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resources(id)              ON DELETE CASCADE,
  field_id    uuid NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  value_text  text,
  value_num   numeric,
  value_bool  bool,
  value_date  date,
  value_json  jsonb,
  source      text NOT NULL DEFAULT 'human'
              CHECK (source IN ('extraction', 'human', 'automation', 'import')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (resource_id, field_id)
);
CREATE INDEX IF NOT EXISTS resource_custom_field_values_kv
  ON resource_custom_field_values (org_id, field_id, value_text);

-- No updated_at TRIGGER, matching 0037/0045: these rows are always replaced
-- wholesale through ON CONFLICT DO UPDATE, which sets the column explicitly.

COMMENT ON TABLE resource_custom_field_values IS
  'The fourth typed-EAV value table (0037''s "adding a fourth later is a one-line change"). '
  'Needed because valueTableForObjectType() resolves object_type ''resource'' to this name - '
  'widening CustomFieldObjectType without it is a 42P01 at runtime.';

------------------------------------------------------------------------------
-- Row-level security and grants - the tenant pattern
--
-- Both tables are org-scoped, so verify-rls.js passes with no allowlist entry.
-- REVOKE BEFORE GRANT: a GRANT-only migration in a database the Supabase API
-- roles can already reach narrows nothing. That trap has cost this codebase a
-- day (see 0053's closing block, and 0075/0081/0089/0145).
------------------------------------------------------------------------------

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['resources', 'resource_custom_field_values'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    -- The partner wall, which 0163 CANNOT add for us: its enumeration runs once,
    -- at 0163, and these two tables did not exist yet. 0163's own closing
    -- assertion ("not three, not five") is correct and still passed, because it
    -- can only ask the catalog about the past.
    --
    -- Without this a partner principal - a broker, an external agent - reads and
    -- writes every resource in the tenant inside `withPartnerContext`, because
    -- `app.org_id` is set there and `org_isolation` alone admits the whole org.
    -- Every org-scoped table added from here on must carry this block;
    -- verify-rls.js now fails the deploy if one does not.
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
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

------------------------------------------------------------------------------
-- Permission grants for `resource`
--
-- `CrmPermissionsGuard` DENIES whatever it finds no grant for. `resource` is
-- already in `PermissionObjectType`, so mounting the controller without seeding
-- these first would 403 every user in every tenant the moment the API container
-- restarted - and the grid is only editable by an admin who would first have to
-- notice. 0041 says this about `task`, 0059/0060 about `product`/`quotation`/
-- `invoice`, 0103 about `lead` and 0158 about `dnc`. One per object, learned
-- once per object, because the enum is the easy half.
--
-- No CHECK to widen: `role_permissions.object_type` is an open string (0039's
-- own decision) and view/create/edit are already in
-- `role_permissions_action_check`. Only rows are needed.
--
-- CUSTOM roles are deliberately not touched - 0041's choice. Nobody has ever
-- held this object, so there is nothing to preserve and widening a hand-built
-- role would be a decision rather than a restoration.
--
-- Scope is always 'all': `resource` is in ALL_SCOPE_ONLY_OBJECTS and its owner
-- column in crm-scope.ts is null. "My own flat" means nothing - a unit of
-- inventory belongs to the business.
--
-- THERE IS NO `delete`. A resource is retired (`status = 'retired'`), which
-- frees its code for re-use and leaves the row that a hold, a booking and an
-- appointment all point at. Deleting one would cascade an appointment's
-- resource_id to NULL and lose what the site visit was OF. A `delete` cell with
-- no route behind it is the thing 0158 refused for `dnc`, for the same reason.

-- `resource:view` - every system role including `viewer`. Inventory is floor
-- information: a telecaller on the phone needs to know which flats are free,
-- and a viewer's whole job is reading how the business is doing. There is
-- nothing personal in the table - no number, no customer - so the
-- `contact_number` asymmetry does not apply here.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'resource', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin',
                 'workspace_member', 'viewer')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `resource:edit` - the three admin roles AND `workspace_member`, because
-- HOLDING a unit is an `edit` and holding is the telecaller's whole job on this
-- table. Withholding it would give the floor a read-only inventory and send
-- every hold through a manager, which is how a unit gets sold twice while
-- somebody waits for a reply.
--
-- The cost of that choice, stated rather than hidden: `edit` also reaches
-- `price_num`. The instrument for narrowing it is 0039's FIELD restrictions
-- (hidden/readonly per role), not a second permission object - adding one would
-- make "why can Priya not hold this flat" a question with two answers.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'resource', 'edit', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin', 'workspace_member')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `resource:create` - the three admin roles ONLY, and this narrows 0041's
-- pattern on purpose. Defining what the business sells is configuration, not
-- floor work: a telecaller inventing "BATCH-7" because they could not find it
-- produces a second row for a batch that already exists under another code, and
-- the unique index cannot catch that. Same judgement 0136 made keeping
-- `workspace_member` away from `lead_board`. An owner can grant it on Team &
-- permissions.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'resource', 'create', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

------------------------------------------------------------------------------
-- Prove it, rather than assume it
--
-- Every active membership in a CRM-enabled org must resolve to a
-- `resource:view` grant through the same join the guard uses, including its
-- `role_id IS NULL` fallback against the legacy `memberships.role` string.
--
-- Scoped to orgs with the `crm` module because `PERMISSION_OBJECT_MODULE` files
-- `resource` under `crm`: a recorder-only tenant is DENIED this object by
-- design, so counting their memberships as stranded would make the warning
-- fire on every deploy and mean nothing.
--
-- A WARNING and not an exception, for 0103's reason: this runs inside the
-- deploy's migrate job, and aborting would leave the schema half-applied and
-- the deploy dead to report a condition that is visible and repairable from the
-- console afterwards. A membership on a CUSTOM role is the expected finding.
------------------------------------------------------------------------------
DO $do$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
    FROM memberships m
    JOIN organizations o ON o.id = m.org_id AND 'crm' = ANY(o.enabled_modules)
   WHERE m.status = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM roles r
         JOIN role_permissions rp
           ON rp.role_id = r.id AND rp.object_type = 'resource' AND rp.action = 'view'
        WHERE r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
     );

  IF stranded > 0 THEN
    RAISE WARNING '0165: % membership(s) resolve to no resource:view grant (custom roles are not seeded) - grant it on Team & permissions', stranded;
  ELSE
    RAISE NOTICE '0165: every active CRM membership resolves to a resource:view grant';
  END IF;
END $do$;
