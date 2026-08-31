-- 0075_boards.sql — a BOARD as a thing the tenant owns and can reshape.
--
-- Today a board column is an element in a jsonb array: organizations.lead_stages
-- for /owner/board, deal_pipelines.stages for /owner/deals. Neither has a stable
-- identity, a position, a probability, or a soft delete — and there is no writer
-- of organizations.lead_stages anywhere in apps/ or packages/, so the lead
-- board's columns are frozen configuration that nobody, including the owner,
-- can change. This migration makes a column a ROW.
--
-- ── THE ONE INVARIANT THAT KEEPS THIS FROM BEING A THIRD SOURCE OF TRUTH ──
--
-- The board layer NEVER stores a stage. Which column a card is IN is derived at
-- read time through board_column_stages; the only board-owned per-card datum is
-- `position`, an ordering hint. A drop writes leads.stage / deals.stage through
-- the record tables, exactly as today. Drop every table in this file and the
-- boards still render, in last_activity_at order, one column per stage — which
-- is both the rollback story and a test (boards/board-drop.spec.ts).
--
-- ── TWO MAPPINGS, NOT ONE ─────────────────────────────────────────────────
--
-- B2 Consultants' own documented bug is that its lead write-through
-- (PipelineStage.legacyStage) is NULLABLE and populated only on the single
-- seeded pipeline, so a second pipeline's moves are invisible to anything
-- reading Lead.stage. Aura is about to add one board per project on top of a
-- codebase that already has that lead/deal split, so the answer has to be
-- structural rather than a convention.
--
-- FORWARD  (column -> lifecycle stage): board_columns.lead_stage_key, NOT NULL,
--   MANY-to-one. A project board's "site_visit", "quote_sent" and "negotiating"
--   may all map to lead stage "qualified". Every column on every board, default
--   or not, can therefore always write through. The nullability that IS B2's
--   bug cannot be expressed here.
--
-- REVERSE  (lifecycle stage -> column): board_column_stages, PK
--   (board_id, model, stage_key). Exactly one landing column per stage per
--   board, enforced by the primary key rather than by a code review.
--
-- The consequence worth stating out loud: a fine-grained project board can be
-- as detailed as the tenant likes WITHOUT inventing lifecycle stages, so
-- organizations.lead_stages stays a short shared six-entry vocabulary and the
-- funnel keeps meaning the same thing across every project.
--
-- ── PURELY ADDITIVE, AND THAT IS LOAD-BEARING ─────────────────────────────
--
-- Nothing in apps/ reads any table in this file. board_cards is left EMPTY by
-- the backfill, so every card keeps sorting by last_activity_at DESC exactly as
-- today until a human drags one. stage_write_guard() is CREATED here and
-- ATTACHED by 0076, once applyColumnMove is the only writer.
--
-- In particular this migration does NOT create a board for each existing
-- crm_project. It is tempting — "a project without a board cannot exist" — but
-- the board resolver keys a lead's board off leads.project_id, so seeding
-- project boards here would silently move every project-labelled lead off the
-- default board the moment reads switch on. That is precisely the invisible
-- relocation this design refuses elsewhere (a project detected after the fact
-- never re-homes a card). Project boards are opt-in, created explicitly through
-- POST /v1/projects/:id/board.

-- ── boards ────────────────────────────────────────────────────────────────
--
-- Deliberately NOT deal_pipelines. That table's object_type is
-- CHECK (object_type = 'deal') (0034), so it can never describe a board that
-- renders leads too — and a board renders both models by design, because that
-- is the only way /owner/board and /owner/deals stop being able to disagree.

CREATE TABLE IF NOT EXISTS boards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name         text NOT NULL CHECK (length(btrim(name)) > 0),
  -- Stable machine identifier, same reasoning as crm_projects.key (0073): the
  -- name is the tenant's to rename without breaking a saved filter or a URL.
  key          text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9_-]*$'),

  -- NULL = the org's default board. CASCADE rather than SET NULL: a board that
  -- exists FOR a project has no meaning once the project is gone, and the cards
  -- are unaffected either way because the board stores no stage.
  project_id   uuid REFERENCES crm_projects(id) ON DELETE CASCADE,

  -- The deal half this board is bound to. RESTRICT for the same reason
  -- deals.pipeline_id is (0036): a pipeline with a live board must be archived,
  -- not deleted out from under it.
  pipeline_id  uuid NOT NULL REFERENCES deal_pipelines(id) ON DELETE RESTRICT,

  is_default   boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),

  -- Which anchor a bare link opens. NOT an object_type: the board renders both.
  render_default text NOT NULL DEFAULT 'lead'
    CHECK (render_default IN ('lead', 'deal')),

  -- The shape a human last BLESSED, and the target of "Restore the columns".
  -- Never written by a reshape — only by POST /v1/boards/:id/template. A
  -- restore target that silently tracks the current shape is not a safety net,
  -- it is a snapshot of the mess.
  template     jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS boards_org_key_unique
  ON boards (org_id, key);
-- One board per project. A real constraint where deal_pipelines' "exactly one
-- default" is only app-enforced (pipelines.controller.ts) — one fewer invariant
-- living in TypeScript.
CREATE UNIQUE INDEX IF NOT EXISTS boards_org_project_unique
  ON boards (org_id, project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS boards_org_default_unique
  ON boards (org_id) WHERE is_default;

-- ── board_columns ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS board_columns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  board_id       uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,

  -- The machine key, carried by automation rule configs, saved filters and the
  -- Android client. IMMUTABLE after creation, enforced by the trigger below
  -- rather than by app code alone — the app is not the only thing with a psql
  -- prompt. Same regex as LeadStage.key (packages/shared/src/leads.ts).
  key            text NOT NULL
                   CHECK (key ~ '^[a-z][a-z0-9_]*$' AND length(key) <= 40),
  -- The only free-text field, and the only thing a rename touches.
  label          text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  position       integer NOT NULL,
  terminal       text CHECK (terminal IN ('won', 'lost')),

  -- What reports.service.ts says out loud is missing. NULL by default and
  -- opt-in: the day a tenant sets one, every forecast number moves.
  probability    numeric(4,3) CHECK (probability BETWEEN 0 AND 1),
  wip_limit      integer CHECK (wip_limit > 0),
  -- A design-token key, not a hex value. Same call tags.color (0057) and
  -- crm_projects.color (0073) make.
  color          text,

  -- The one column every unmapped card lands in, so a stage the board does not
  -- know about is VISIBLE and counted rather than silently absent (which is
  -- what deals.controller.ts's `orphaned` counter reports today without showing
  -- anyone the cards). A drop INTO it is refused. Cannot be archived (trigger).
  is_fallback    boolean NOT NULL DEFAULT false,

  -- THE BRIDGE, forward direction. Both NOT NULL on every column of every
  -- board. Many columns may share a lead_stage_key; that is the point.
  lead_stage_key text NOT NULL CHECK (lead_stage_key ~ '^[a-z][a-z0-9_]*$'),
  deal_stage_key text NOT NULL CHECK (deal_stage_key ~ '^[a-z][a-z0-9_]*$'),

  -- The template slot this column occupies. Survives a rename AND a soft
  -- delete, which is what lets "Restore the columns" put back a column the
  -- tenant renamed three months ago rather than creating a duplicate beside it.
  seed_key       text,

  -- Soft delete. There is no hard DELETE route for a column in this design.
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Uniqueness spans ARCHIVED rows deliberately: a key is never recycled into a
-- different meaning, and re-adding a key un-archives the original column so the
-- cards filed under it come back rather than colliding.
CREATE UNIQUE INDEX IF NOT EXISTS board_columns_board_key_unique
  ON board_columns (board_id, key);
CREATE UNIQUE INDEX IF NOT EXISTS board_columns_board_seed_unique
  ON board_columns (board_id, seed_key)
  WHERE archived_at IS NULL AND seed_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS board_columns_one_fallback
  ON board_columns (board_id) WHERE is_fallback AND archived_at IS NULL;
-- `position` is deliberately NOT unique: a partial unique index cannot be
-- DEFERRABLE, so a reorder would need a two-phase shuffle. Order is
-- (position, key), which is total and stable — the same argument
-- crm_projects.sort_order already makes.
CREATE INDEX IF NOT EXISTS board_columns_board_pos
  ON board_columns (board_id, position, key) WHERE archived_at IS NULL;

-- ── board_column_stages — boardColumnFor(stage), the REVERSE map ──────────
--
-- Several lifecycle stages may file into one column; the primary key is what
-- makes "a stage mapped to two columns" fail in the database rather than in a
-- code review.

CREATE TABLE IF NOT EXISTS board_column_stages (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id  uuid NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  model      text NOT NULL CHECK (model IN ('lead', 'deal')),
  stage_key  text NOT NULL,
  PRIMARY KEY (board_id, model, stage_key)
);

CREATE INDEX IF NOT EXISTS board_column_stages_col
  ON board_column_stages (column_id);

-- ── board_cards — position, and nothing else ──────────────────────────────
--
-- No stage, no status, no column_id. A column_id here would be a cached
-- derivation that can go stale, and the instant this table can hold a placement
-- the record disagrees with, it is a third source of truth and the whole
-- approach loses its justification. The join is cheap and always right.

CREATE TABLE IF NOT EXISTS board_cards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  board_id    uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (record_type IN ('lead', 'deal')),
  record_id   uuid NOT NULL,
  -- Gapped, seeded at n*1000, so a single-card insert between two neighbours is
  -- a midpoint write rather than a renumber of the whole column.
  position    integer NOT NULL,
  -- console | device | automation | refile
  placed_by   text,
  placed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS board_cards_unique
  ON board_cards (board_id, record_type, record_id);
CREATE INDEX IF NOT EXISTS board_cards_order
  ON board_cards (board_id, position);

-- ── lead_stage_transitions — the ledger leads have never had ──────────────
--
-- deals have had one since 0046; leads carry only stage_changed_at, so "how did
-- this lead get here" is unanswerable. Same shape, same reasons, deliberately
-- not merged into deal_stage_transitions (whose deal_id is NOT NULL and FKs to
-- deals).

CREATE TABLE IF NOT EXISTS lead_stage_transitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_stage   text,
  to_stage     text NOT NULL,
  from_status  text,
  to_status    text NOT NULL,
  changed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label  text,
  -- console | device | automation | reshape | backfill | pipeline.
  -- `device` ranks with `console`, NOT with `automation`: a telecaller on a
  -- phone is a human, and treating their move as machine output would invert
  -- the human-outranks-the-machine rule.
  source       text NOT NULL DEFAULT 'console',
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_stage_transitions_lead
  ON lead_stage_transitions (lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS lead_stage_transitions_org_time
  ON lead_stage_transitions (org_id, occurred_at DESC);

-- ── crm_bridge_failures — divergence written down ─────────────────────────
--
-- The replacement for owner/leads.controller.ts's propagateStageToDeal, which
-- ends in `catch (err) { console.error(... "non-blocking") }` and returns 200:
-- the lead moves, the deal does not, and the user is told nothing. After this,
-- a card move is either written through to the other model or recorded HERE and
-- shown on the card. There is no third outcome.

CREATE TABLE IF NOT EXISTS crm_bridge_failures (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  direction   text NOT NULL
                CHECK (direction IN ('lead_to_deal', 'deal_to_lead', 'backfill')),
  lead_id     uuid REFERENCES leads(id) ON DELETE CASCADE,
  deal_id     uuid REFERENCES deals(id) ON DELETE CASCADE,
  board_id    uuid REFERENCES boards(id) ON DELETE SET NULL,
  from_stage  text,
  to_stage    text,
  -- no_counterpart | stage_absent | write_failed | orphan_backfilled |
  -- fallback_column
  reason      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS crm_bridge_failures_open
  ON crm_bridge_failures (org_id, created_at DESC) WHERE resolved_at IS NULL;

-- ── lead_projects — one person, several things they are buying ────────────
--
-- 0073 gave a CALL many projects (call_projects) but gave a LEAD exactly one
-- (leads.project_id), on the reasoning that a card carries one project because
-- that is what a person reads at a glance. That reasoning holds while one
-- person means one sale. It does not hold on a floor where two telecallers work
-- the same person on different offerings:
--
--   upsertLead dedups on (workspace_id, contact_number_hash) — the counterparty
--   number, not the telecaller and not the project — so both calls land on ONE
--   lead. detectCallProjects then overwrites leads.project_id with the newest
--   call's strongest hit. The first project is not merely demoted, it stops
--   being visible anywhere on the record, and the card silently leaves one
--   project's board for another's. Because the pipeline is queue-driven, the
--   winner is not even the later call — it is whichever finished last.
--
-- The evidence was never lost: call_projects has always kept every hit. What
-- was missing is the roll-up. This table is to leads what call_projects is to
-- calls, and leads.project_id becomes the derived PRIMARY — the display
-- summary, not the record. Same four-value `source` vocabulary, so the
-- human-owns-it rule reads identically at both levels.
--
-- Additive only: nothing reads this yet, and leads.project_id keeps its current
-- meaning and its current writers untouched by this migration.

CREATE TABLE IF NOT EXISTS lead_projects (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id    uuid NOT NULL REFERENCES leads(id)        ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES crm_projects(id) ON DELETE CASCADE,

  confidence numeric(4, 3) NOT NULL DEFAULT 0
    CHECK (confidence >= 0 AND confidence <= 1),
  source     text NOT NULL DEFAULT 'extraction'
    CHECK (source IN ('extraction', 'human', 'automation', 'import')),

  -- Mirrors leads.project_id. A partial unique index rather than a trigger, so
  -- "two primaries" is unrepresentable rather than merely discouraged.
  is_primary boolean NOT NULL DEFAULT false,

  -- Which conversation first put this project on this lead — the provenance a
  -- telecaller needs when they ask "who said we were doing LexDraft?".
  first_call_id uuid REFERENCES calls(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, project_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_projects_one_primary
  ON lead_projects (lead_id) WHERE is_primary;
-- "Every lead touching this project" — the query the project detail view is,
-- and the one a per-project board needs.
CREATE INDEX IF NOT EXISTS lead_projects_project
  ON lead_projects (org_id, project_id);

-- ── ASSIGNMENT, which the CRM has never had ───────────────────────────────
--
-- deals.telecaller_id and leads.telecaller_id are WRITE-ONCE ATTRIBUTION
-- snapshots — 0036 says so in as many words, and 0017 explains why: reassigning
-- a handset must not silently move who gets credit for a deal already in
-- flight. Nothing in the repo can update either column, and nothing should.
--
-- A phone board keyed on attribution would show a telecaller the deals they
-- happened to source, never the deals they are meant to work, and would make
-- every CSV-imported / Meta-webhook / hand-created deal permanently invisible
-- on every handset. So assignment gets its own column, freely re-assignable,
-- backfilled from attribution so day one looks exactly like today.

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS assigned_telecaller_id uuid
    REFERENCES telecallers(id) ON DELETE SET NULL;
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS assigned_telecaller_id uuid
    REFERENCES telecallers(id) ON DELETE SET NULL;

UPDATE deals SET assigned_telecaller_id = telecaller_id
  WHERE assigned_telecaller_id IS NULL AND telecaller_id IS NOT NULL;
UPDATE leads SET assigned_telecaller_id = telecaller_id
  WHERE assigned_telecaller_id IS NULL AND telecaller_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS deals_org_assigned
  ON deals (org_id, assigned_telecaller_id)
  WHERE assigned_telecaller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_org_assigned
  ON leads (org_id, assigned_telecaller_id)
  WHERE assigned_telecaller_id IS NOT NULL;

-- ── Per-device CRM opt-in ─────────────────────────────────────────────────
--
-- Binding a handset to a telecaller exists fleet-wide already, for attribution.
-- If the CRM board rode on that binding, the day the feature flag flips every
-- bound phone in every tenant would gain CRM read and write with no admin
-- action — authorization by side effect, outside the role model in
-- packages/shared/src/permissions.ts. So it is its own explicit, revocable,
-- default-off grant.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS crm_board_enabled boolean NOT NULL DEFAULT false;

-- ── Triggers: identity and the fallback are not editable ──────────────────

CREATE OR REPLACE FUNCTION board_columns_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.key IS DISTINCT FROM OLD.key THEN
    RAISE EXCEPTION 'board_columns.key is immutable (column %): rename the label instead', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.is_fallback AND NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'the fallback column of board % cannot be archived', OLD.board_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

DO $$ BEGIN
  CREATE TRIGGER board_columns_guard_trg BEFORE UPDATE ON board_columns
    FOR EACH ROW EXECUTE FUNCTION board_columns_guard();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── The stage-write guard, created but NOT attached ───────────────────────
--
-- Attached by 0076, once apply-column-move.ts is the only writer. Created here
-- so 0075 stays purely additive and changes no behaviour at all.
--
-- Why a trigger and not a grant: a column-level REVOKE has NO EFFECT while the
-- role holds the privilege at table level, and aura_app holds table-level
-- UPDATE on both tables from 0001_init.sql and again from 0007's re-assert.
-- Verified on PG16:
--   GRANT UPDATE ON t TO r; REVOKE UPDATE (c) ON t FROM r;
--   SELECT has_column_privilege(r, t, c, 'UPDATE');  -->  t
-- A trigger that RAISEs is enforcement. It also cannot silently no-op the way
-- a SECURITY DEFINER write under FORCE ROW LEVEL SECURITY can.

CREATE OR REPLACE FUNCTION stage_write_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage
     AND COALESCE(current_setting('app.stage_writer', true), '') <> 'board' THEN
    RAISE EXCEPTION
      'stage on %.% may only be written through applyColumnMove (set app.stage_writer)',
      TG_TABLE_NAME, NEW.id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $fn$;

-- ── RLS, house style, on all seven new tables ─────────────────────────────

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['boards', 'board_columns', 'board_column_stages',
                           'board_cards', 'lead_stage_transitions',
                           'crm_bridge_failures', 'lead_projects'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL; END;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);

    -- 0007 revoked Supabase's default privileges only for the role that ran it;
    -- re-assert, or a table created under a different owner stays reachable
    -- with the public anon key. A GRANT-only migration narrows nothing.
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;

DO $$ BEGIN
  CREATE TRIGGER boards_set_updated_at BEFORE UPDATE ON boards
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER board_columns_set_updated_at BEFORE UPDATE ON board_columns
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── seed_default_board — the ONE implementation of "a board exists" ───────
--
-- Called twice, and that is the entire point of it being a function:
--   * by this migration's backfill, once per existing org;
--   * by the admin dashboard's tenant provisioning
--     (apps/api/src/modules/admin/admin.controller.ts, seedBoardDefaults),
--     so a CRM created tomorrow comes up with exactly the same board as one
--     created before this migration ran.
--
-- A TypeScript copy of this SQL would drift from the migration the first time
-- either was edited, and the failure mode is a tenant whose board silently
-- differs from every other tenant's. One function, no drift, by construction.
--
-- NOT SECURITY DEFINER: it runs with the caller's own privileges, so the RLS
-- policies above still apply. The admin pool bypasses RLS because tenant
-- provisioning legitimately spans orgs; a caller inside withOrg gets policy
-- enforcement, which is the correct behaviour in both cases.
--
-- Idempotent: an org that already has a default board gets that board's id back
-- and nothing is written. Safe to call on every provisioning path, and safe to
-- call again on an org someone enabled CRM for a second time.

CREATE OR REPLACE FUNCTION seed_default_board(p_org_id uuid) RETURNS uuid
LANGUAGE plpgsql AS $fn$
DECLARE
  v_board_id    uuid;
  v_pipeline_id uuid;
  v_stages      jsonb;
BEGIN
  SELECT b.id INTO v_board_id
    FROM boards b WHERE b.org_id = p_org_id AND b.is_default;
  IF v_board_id IS NOT NULL THEN
    RETURN v_board_id;
  END IF;

  -- ONE stage vocabulary for both halves. The pipeline and the board columns
  -- are derived from the same list in the same statement, so "the deal stages
  -- and the board columns disagree" is not a state this can produce — which is
  -- the invariant the forward bridge (board_columns.deal_stage_key NOT NULL)
  -- depends on.
  SELECT COALESCE(NULLIF(o.lead_stages, '[]'::jsonb), '[
    {"key":"new","label":"New"},{"key":"contacted","label":"Contacted"},
    {"key":"qualified","label":"Qualified"},{"key":"negotiation","label":"Negotiation"},
    {"key":"won","label":"Won","terminal":"won"},
    {"key":"lost","label":"Lost","terminal":"lost"}]'::jsonb)
    INTO v_stages
    FROM organizations o WHERE o.id = p_org_id;
  IF v_stages IS NULL THEN
    RAISE EXCEPTION 'seed_default_board: no such organization %', p_org_id;
  END IF;

  -- FIND-or-create. An org with no pipeline at all, or with zero is_default
  -- pipelines (UpdatePipelineBody accepts isDefault:false with no replacement,
  -- so this is reachable today), would otherwise violate pipeline_id NOT NULL.
  -- Finding rather than always inserting is what stops a second 'Sales
  -- Pipeline' with is_default = true appearing when someone enables the CRM
  -- module on a tenant this function has already touched.
  SELECT p.id INTO v_pipeline_id
    FROM deal_pipelines p
   WHERE p.org_id = p_org_id AND p.status = 'active'
   ORDER BY p.is_default DESC, p.created_at ASC LIMIT 1;

  IF v_pipeline_id IS NULL THEN
    INSERT INTO deal_pipelines (org_id, name, stages, is_default)
    VALUES (p_org_id, 'Sales Pipeline', v_stages, true)
    RETURNING id INTO v_pipeline_id;
  END IF;

  INSERT INTO boards (org_id, name, key, project_id, pipeline_id, is_default,
                      render_default)
  VALUES (p_org_id, 'Sales Board', 'default', NULL, v_pipeline_id, true, 'lead')
  RETURNING id INTO v_board_id;

  -- Columns, in array order. seed_key = key on a fresh board, so "Restore the
  -- columns" can put a renamed column back into the slot it came from.
  INSERT INTO board_columns (org_id, board_id, key, label, position, terminal,
                             lead_stage_key, deal_stage_key, seed_key)
  SELECT p_org_id, v_board_id, s->>'key', s->>'label', ((ord - 1) * 1000)::int,
         NULLIF(s->>'terminal', ''),
         s->>'key', s->>'key', s->>'key'
    FROM jsonb_array_elements(v_stages) WITH ORDINALITY AS t(s, ord);

  -- The reverse map, both models.
  INSERT INTO board_column_stages (org_id, board_id, column_id, model, stage_key)
  SELECT c.org_id, c.board_id, c.id, m.model, c.key
    FROM board_columns c
    CROSS JOIN (VALUES ('lead'), ('deal')) AS m(model)
   WHERE c.board_id = v_board_id AND c.archived_at IS NULL
  ON CONFLICT (board_id, model, stage_key) DO NOTHING;

  -- The fallback, last and unmapped: it is where COALESCE lands, not where a
  -- stage maps, so it gets no board_column_stages row.
  INSERT INTO board_columns (org_id, board_id, key, label, position, is_fallback,
                             lead_stage_key, deal_stage_key)
  SELECT p_org_id, v_board_id, 'unmapped', 'Unmapped', 999000, true,
         c.lead_stage_key, c.deal_stage_key
    FROM board_columns c
   WHERE c.board_id = v_board_id
   ORDER BY c.position, c.key LIMIT 1;

  -- Bless the shape just written, so "Restore the columns" works on day one
  -- with no code constant to keep in step.
  UPDATE boards b SET template = COALESCE((
    SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'key', c.key, 'label', c.label, 'position', c.position,
             'terminal', c.terminal, 'leadStageKey', c.lead_stage_key,
             'dealStageKey', c.deal_stage_key, 'seedKey', c.seed_key,
             'isFallback', NULLIF(c.is_fallback, false)))
             ORDER BY c.position, c.key)
      FROM board_columns c
     WHERE c.board_id = v_board_id AND c.archived_at IS NULL), '[]'::jsonb)
   WHERE b.id = v_board_id;

  RETURN v_board_id;
END $fn$;

-- ══ BACKFILL ══════════════════════════════════════════════════════════════
--
-- Deterministic, append-only, and it leaves board_cards EMPTY. Every card keeps
-- sorting by last_activity_at DESC, exactly as today, until a human drags one.

-- (1) One default board per existing org, through the same function every
--     future tenant will be provisioned with.
SELECT seed_default_board(o.id) FROM organizations o ORDER BY o.created_at;

-- (2) ORPHAN RESCUE — nothing is migrated with cards stranded.
--     A deal whose stage is not in its pipeline is counted and HIDDEN today
--     (deals.controller.ts's `orphaned`, and the lead board's equivalent). Here
--     those ghosts become real, visible, appended columns, each with a
--     crm_bridge_failures row so the tenant knows why they appeared. This is
--     B2's "nothing is deleted with cards in it", applied to the migration.
--
--     One statement with a CTE rather than an INSERT matched afterwards by a
--     label LIKE, so the ledger rows describe exactly the columns just created
--     and nothing a tenant later happens to name "Recovered: …".
WITH recovered AS (
  INSERT INTO board_columns (org_id, board_id, key, label, position,
                             lead_stage_key, deal_stage_key)
  SELECT DISTINCT ON (b.id, d.stage)
         b.org_id, b.id, d.stage, 'Recovered: ' || d.stage, 900000,
         (SELECT c2.lead_stage_key FROM board_columns c2
           WHERE c2.board_id = b.id ORDER BY c2.position, c2.key LIMIT 1),
         d.stage
    FROM deals d
    JOIN boards b ON b.org_id = d.org_id AND b.is_default
   WHERE d.stage ~ '^[a-z][a-z0-9_]*$'
     AND NOT EXISTS (SELECT 1 FROM board_columns c
                      WHERE c.board_id = b.id AND c.deal_stage_key = d.stage)
   ORDER BY b.id, d.stage
  RETURNING id, org_id, board_id, deal_stage_key
), mapped AS (
  INSERT INTO board_column_stages (org_id, board_id, column_id, model, stage_key)
  SELECT r.org_id, r.board_id, r.id, 'deal', r.deal_stage_key FROM recovered r
  ON CONFLICT (board_id, model, stage_key) DO NOTHING
  RETURNING 1
)
INSERT INTO crm_bridge_failures (org_id, direction, deal_id, board_id,
                                 to_stage, reason, detail)
SELECT d.org_id, 'backfill', d.id, r.board_id, d.stage, 'orphan_backfilled',
       jsonb_build_object('note', 'stage was absent from the pipeline; '
                                  'a Recovered column was created for it')
  FROM recovered r
  JOIN deals d ON d.org_id = r.org_id AND d.stage = r.deal_stage_key;

-- (3) lead_projects, from the two places the truth already lives.
--     First the current summary, which is by definition the primary.
INSERT INTO lead_projects (org_id, lead_id, project_id, source, is_primary, confidence)
SELECT l.org_id, l.id, l.project_id, COALESCE(l.project_source, 'extraction'), true, 1
  FROM leads l
 WHERE l.project_id IS NOT NULL
ON CONFLICT (lead_id, project_id) DO NOTHING;

--     Then every OTHER project any of this lead's calls was about — the hits
--     detectCallProjects recorded on call_projects and then discarded when it
--     collapsed them to a single winner. This is the recovery of the second
--     telecaller's conversation: it was never lost, only unreachable. The join
--     is upsertLead's own dedup key, so it matches exactly the calls that
--     produced (or would have produced) this lead.
INSERT INTO lead_projects (org_id, lead_id, project_id, source, is_primary,
                           confidence, first_call_id)
SELECT DISTINCT ON (l.id, cp.project_id)
       l.org_id, l.id, cp.project_id, cp.source, false, cp.confidence, cp.call_id
  FROM leads l
  JOIN calls c          ON c.workspace_id = l.workspace_id
                       AND c.remote_number_hash = l.contact_number_hash
  JOIN call_projects cp ON cp.call_id = c.id
 WHERE l.contact_number_hash IS NOT NULL
 ORDER BY l.id, cp.project_id, cp.confidence DESC, c.started_at ASC
ON CONFLICT (lead_id, project_id) DO NOTHING;

-- (4) Refuse rather than ship a half-built board.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM boards b
   WHERE NOT EXISTS (SELECT 1 FROM board_columns c
                      WHERE c.board_id = b.id AND c.is_fallback
                        AND c.archived_at IS NULL);
  IF bad > 0 THEN
    RAISE EXCEPTION '0075: % board(s) have no fallback column', bad;
  END IF;

  SELECT count(*) INTO bad FROM boards b
   WHERE NOT EXISTS (SELECT 1 FROM board_column_stages m
                      WHERE m.board_id = b.id AND m.model = 'lead');
  IF bad > 0 THEN
    RAISE EXCEPTION '0075: % board(s) have no lead stage mapping', bad;
  END IF;

  SELECT count(*) INTO bad FROM board_cards;
  IF bad > 0 THEN
    RAISE EXCEPTION '0075: backfill must leave board_cards empty, found %', bad;
  END IF;
END $$;
