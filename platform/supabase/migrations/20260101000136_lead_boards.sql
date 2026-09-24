-- 0136_lead_boards.sql - more than one lead board, and which channel feeds which.
--
-- ── THE BOARD EVERY ORG ALREADY HAS STAYS WHERE IT IS ───────────────────────
--
-- Until now an org had exactly one lead board, whose columns are
-- `organizations.lead_stages` (0010). About fourteen places read that column:
-- six lead writers across the API and the worker, the board, list and PATCH
-- endpoints, the reports and the lead->deal stage sync.
--
-- So that board is not moved into the new table. It becomes the MAIN board,
-- and `leads.board_id IS NULL` means "on the Main board". Every existing lead is
-- therefore already correct without a backfill, and every writer that has never
-- heard of boards keeps landing leads exactly where it does today. Only the
-- code that has to read a NON-main board's columns learns about this table -
-- through one helper, `leadBoardStages` in @aura/db, not a second copy of the
-- lookup at every call site.
--
-- Not 0075's `boards`/`board_columns`. Those require a deal pipeline
-- (`pipeline_id NOT NULL`, `deal_stage_key NOT NULL`) and allow one board per
-- project: they model a lead board welded to a deal board. These boards are
-- lead-only by decision, and a board a tenant makes for "Website enquiries"
-- has no deal pipeline to name.

CREATE TABLE IF NOT EXISTS lead_boards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  -- The same `{key, label, terminal?}` shape as organizations.lead_stages, so
  -- parseLeadStages reads both. Validated by the API (LeadStages, 1-16 entries).
  stages      jsonb NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Two boards called "Website" is two tabs nobody can tell apart.
CREATE UNIQUE INDEX IF NOT EXISTS lead_boards_org_name
  ON lead_boards (org_id, lower(btrim(name)));

-- The Main board has no row, so its name lives on the org. NULL reads as
-- "Main board".
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS main_lead_board_name text
  CHECK (main_lead_board_name IS NULL OR char_length(btrim(main_lead_board_name)) BETWEEN 1 AND 60);

-- RESTRICT, not SET NULL: a board's stage keys are its own, so a lead dropped
-- onto the Main board by a cascade would carry a stage the Main board cannot
-- render, and the card would vanish from every column. Deleting a board moves
-- its leads first, in the API, with the stages mapped (lead-boards.controller).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS board_id uuid
  REFERENCES lead_boards(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS leads_org_board
  ON leads (org_id, board_id);

-- ── Which channel feeds which board ─────────────────────────────────────────
--
-- One row per routed source. `source_id` is a messaging_channels.id for
-- WhatsApp or a lead_sources.id for a web form; NULL means every source on
-- that channel. Resolution (resolveLeadBoard in @aura/db) is: the row for the
-- exact source, else the row for the whole channel, else the Main board.
--
-- `board_id` NULL is the Main board, stated explicitly. It exists for the
-- exception: "every WhatsApp number to Website, but THIS number stays on the
-- Main board" needs a row that says Main, or the number would inherit the
-- channel's route. A missing row means "inherit"; a NULL board means "Main".
--
-- `source_id` has no foreign key because it points at one of two tables. A
-- route left behind by a deleted source matches nothing and is harmless; the
-- routing screen lists only live sources.
CREATE TABLE IF NOT EXISTS lead_board_routes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel    text NOT NULL CHECK (channel IN ('whatsapp', 'web_form', 'manual')),
  source_id  uuid,
  -- CASCADE: a deleted board's routes go with it, and those sources fall back
  -- to the Main board rather than to a board that no longer exists.
  board_id   uuid REFERENCES lead_boards(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- "Added manually" has no sources to pick between.
  CHECK (channel <> 'manual' OR source_id IS NULL)
);

-- Exactly one route per source, and one per whole channel. COALESCE because a
-- plain unique index treats every NULL source_id as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS lead_board_routes_one_per_source
  ON lead_board_routes (org_id, channel, COALESCE(source_id, '00000000-0000-0000-0000-000000000000'::uuid));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_boards', 'lead_board_routes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;

DO $$
DECLARE api_role text; t text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      FOREACH t IN ARRAY ARRAY['lead_boards', 'lead_board_routes'] LOOP
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- ── Permissions ─────────────────────────────────────────────────────────────
--
-- Two new grid cells need grants BEFORE the API mounts guards on them, or
-- CrmPermissionsGuard 403s everyone the moment the container restarts (0103's
-- header has the full story).
--
-- `lead:create` - the console's new "New lead" button. Derived from `lead:edit`
-- at the same scope: until now the only people who could put a card on the
-- board by hand were the ones who could edit one, via the API's own tools.
--
-- `lead_board:create|edit|delete` - making, reshaping, routing and removing
-- boards. Reshaping a board changes the columns under everyone's leads, so
-- this is an administrator's power, not a floor one: the three admin system
-- roles, plus any CUSTOM role that already edits every lead (an owner who
-- built a "Sales lead" role meant it to run the board). `workspace_member`
-- is excluded even though it holds `lead:edit` at `all` - that is the
-- telecaller's role, and deleting a board is not a telecaller's call. An
-- owner can grant it on the Team & permissions screen. Always scope `all`;
-- "own boards" means nothing.
--
-- New orgs get the same split from seedCrmDefaults (admin.controller.ts),
-- so this backfill is for the orgs that exist today.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT rp.org_id, rp.role_id, 'lead', 'create', rp.scope
  FROM role_permissions rp
 WHERE rp.object_type = 'lead' AND rp.action = 'edit'
ON CONFLICT (role_id, object_type, action) DO NOTHING;

INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT rp.org_id, rp.role_id, 'lead_board', a.action, 'all'
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
  CROSS JOIN (VALUES ('create'), ('edit'), ('delete')) AS a(action)
 WHERE rp.object_type = 'lead' AND rp.action = 'edit' AND rp.scope = 'all'
   AND (NOT r.is_system OR r.key IN ('platform_admin', 'org_admin', 'workspace_admin'))
ON CONFLICT (role_id, object_type, action) DO NOTHING;
