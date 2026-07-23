-- 0010_leads_and_owners.sql — the owner console: a lead pipeline the customer
-- works in, and per-telecaller attribution for the performance view.
--
-- Until now an extraction was a fire-and-forget push: call_facts were rendered
-- into a CRM payload and posted out (0008/0009). Nothing in this platform held
-- "a prospect" — so there was no count to show an owner, no board to drag, and
-- a customer without a CRM had nowhere for the extraction to land.
--
-- Three additions:
--
--   1. leads — one row per qualified prospect, deduped on the counterparty
--      number so a second call updates the prospect instead of forking it.
--      Fed by the worker (see apps/worker/src/pipeline/leads.ts); the CRM
--      dispatch path is untouched and still fires independently.
--
--   2. organizations.lead_stages — the board's columns are tenant data, not an
--      enum. A brick supplier and an insurance desk do not share a pipeline,
--      and adding a column must not be a migration. `leads.stage` is therefore
--      validated by the API against this list rather than by a CHECK.
--
--   3. devices.telecaller_name — calls are attributed to a handset; this is the
--      human name the owner puts against it, so the dashboard can rank people
--      rather than device UUIDs.

-- ── 1. Tenant-defined pipeline stages ─────────────────────────────────
-- Terminal stages carry "terminal": won|lost — that is what flips leads.status,
-- so "closed" columns work no matter what the tenant renames them to.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS lead_stages jsonb NOT NULL DEFAULT '[
    {"key": "new",         "label": "New"},
    {"key": "contacted",   "label": "Contacted"},
    {"key": "qualified",   "label": "Qualified"},
    {"key": "negotiation", "label": "Negotiation"},
    {"key": "won",         "label": "Won",  "terminal": "won"},
    {"key": "lost",        "label": "Lost", "terminal": "lost"}
  ]'::jsonb;

-- ── 2. What makes a call a lead ───────────────────────────────────────
-- Lives on the agent because the agent owns the field schema these keys refer
-- to, and agents are versioned-immutable: tightening the rule creates a new
-- version instead of silently re-qualifying history.
--
--   {"requiredFields": ["customer_name"],   -- all must be non-empty
--    "anyFields":      ["quantity","budget"], -- at least one non-empty
--    "minFilled":       1,                   -- non-empty fact count floor
--    "titleField":     "customer_name",      -- card heading
--    "valueField":     "total_budget",       -- card value
--    "allowFailedValidation": false}
--
-- {} means the default rule: extraction did not fail validation AND at least
-- one field came back filled. A wrong number extracts nothing and so is never
-- a lead; a real enquiry always fills something.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS lead_rules jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── 3. Who made the call ──────────────────────────────────────────────
-- devices.label is the handset ("Nokia G21 #2"); this is the person holding it.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS telecaller_name text;

-- ── 4. The pipeline ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Identity. The full number is never stored anywhere in this schema (0006):
  -- the hash is the dedup key, prefix + last3 are all the console can show.
  contact_name          text,
  contact_number_hash   text,
  contact_number_prefix text,
  contact_number_last3  text,

  -- Board heading. Denormalised from the agent's titleField so the list and
  -- board render without touching call_facts.
  title      text NOT NULL,
  stage      text NOT NULL DEFAULT 'new',
  -- Derived from the stage's "terminal" marker; kept as its own column so
  -- "open leads" is an index scan and survives a stage being renamed.
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  -- The extraction's confidence heuristic (0..1) at the time of qualification.
  score      numeric,
  -- The agent's valueField, when it named a numeric one — deal size.
  value_num  numeric,
  summary    text,
  next_action text,
  notes      text,
  -- Snapshot of the qualifying extraction, merged (never blanked) by later
  -- calls: a follow-up that only mentions quantity must not erase the budget.
  facts      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Attribution + provenance. Calls are reaped on the org's retention clock
  -- (see reaper.ts); SET NULL keeps the lead, minus a dead link.
  telecaller_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  first_call_id        uuid REFERENCES calls(id)   ON DELETE SET NULL,
  last_call_id         uuid REFERENCES calls(id)   ON DELETE SET NULL,
  agent_id             uuid,
  agent_version        int,
  call_count           int NOT NULL DEFAULT 1,

  last_activity_at timestamptz NOT NULL DEFAULT now(),
  stage_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Dedup key. Scoped to the workspace, not the org, so two sales desks sharing a
-- tenant each keep their own view of a prospect. Partial because a call with no
-- number (the phone lacked call-log permission) still deserves a lead — it just
-- cannot be matched to a future one.
CREATE UNIQUE INDEX IF NOT EXISTS leads_workspace_contact
  ON leads (workspace_id, contact_number_hash)
  WHERE contact_number_hash IS NOT NULL;

-- A lead's call history is "every call from this number in this workspace",
-- which is also how call_count is recomputed on each upsert — deriving it
-- rather than incrementing keeps a reprocessed call from inflating the total.
CREATE INDEX IF NOT EXISTS calls_workspace_number_hash
  ON calls (workspace_id, remote_number_hash)
  WHERE remote_number_hash IS NOT NULL;

-- The board (one query per column) and the list (most recent first).
CREATE INDEX IF NOT EXISTS leads_org_stage    ON leads (org_id, stage, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS leads_org_activity ON leads (org_id, last_activity_at DESC);
-- The dashboard's per-telecaller rollup.
CREATE INDEX IF NOT EXISTS leads_org_telecaller ON leads (org_id, telecaller_device_id);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON leads
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO aura_app;

-- 0007 revoked Supabase's default privileges for future tables, but only for the
-- role that ran it. Re-assert here so a table created under a different owner
-- can never be reachable with the public anon key.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON leads FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON leads FROM PUBLIC;

-- 0001's trigger loop only saw the tables that existed then.
DO $$ BEGIN
  CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
