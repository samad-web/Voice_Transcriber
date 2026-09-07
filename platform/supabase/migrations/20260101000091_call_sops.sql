-- 0091_call_sops.sql - the tenant's own call SOP, and how each call scored
-- against it.
--
-- ── WHAT WAS ALREADY THERE, AND WHY IT IS NOT ENOUGH ────────────────────────
--
-- `call_analytics.quality_criteria` (0069) already carries a `scriptAdherence`
-- integer 0-10, written by the same `analyzeConversation` call this migration
-- extends. Three things are wrong with it as a product:
--
--   1. The tenant cannot say what their script IS. A brick factory and a
--      diagnostics clinic are scored against the same implicit notion of a good
--      call, which is the model's, not theirs.
--   2. It is one number. A 7/10 tells a manager nothing they can say to a rep.
--   3. There is no evidence. Nobody can check it, including the rep it is
--      about - and a score somebody cannot contest is one they stop believing.
--
-- So the existing field stays exactly as it is (it is a general quality signal
-- and other things read it), and this adds the tenant-defined, per-step,
-- evidenced version beside it.
--
-- ── WHY call_sops IS VERSIONED-IMMUTABLE ────────────────────────────────────
--
-- Same shape as `agents` (0001): PRIMARY KEY (id, version), and editing an SOP
-- INSERTs a new version rather than updating in place. Not for audit
-- tidiness - because `call_sop_results` stores the version it judged against,
-- and without that an edit silently rewrites history. A manager who tightens a
-- step in March would find February's calls re-described as failing a rule that
-- did not exist when they were made, with nothing anywhere recording that the
-- rule changed. Every past score has to keep pointing at the text it was
-- actually scored against.
--
-- ── WHY THE SCORE IS NOT STORED AS A SINGLE NUMBER ──────────────────────────
--
-- `step_results` is the record; `steps_met` / `steps_total` / `adherence_pct`
-- are derived and stored only so the console can sort and aggregate without
-- unpacking jsonb per row. If they ever disagree with `step_results`, the jsonb
-- is right - it is what the model actually said.

CREATE TABLE IF NOT EXISTS call_sops (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Nullable: an SOP usually belongs to the whole tenant. A workspace-scoped
  -- one is for a floor running a different script from the rest of the org.
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  version      int  NOT NULL DEFAULT 1,
  name         text NOT NULL,

  -- [{ key, label, description, required }] - validated by the SopSteps zod
  -- schema in packages/shared/src/call-sops.ts, which is the authority on the
  -- shape and on the 12-step cap. Deliberately not a CHECK: the constraint is
  -- structural (unique keys, length bounds) and belongs where it can produce a
  -- usable error message, not as a 400 that says "violates check constraint".
  steps        jsonb NOT NULL DEFAULT '[]',

  -- Only one version of one SOP scores a call at a time. Enforced by the
  -- partial unique index below rather than by application code, because "two
  -- active SOPs" is the state that makes `call_sop_results.UNIQUE (call_id,
  -- sop_id)` insufficient and produces two contradictory scores on one call.
  is_active    bool NOT NULL DEFAULT false,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

-- At most one active SOP per org. Partial, so the archived versions - which is
-- most rows, forever - are not in the index at all.
CREATE UNIQUE INDEX IF NOT EXISTS call_sops_one_active_per_org
  ON call_sops (org_id) WHERE is_active;

-- The worker's read on every enriched call: this org's active SOP.
CREATE INDEX IF NOT EXISTS call_sops_org_active
  ON call_sops (org_id, version DESC) WHERE is_active;

CREATE TABLE IF NOT EXISTS call_sop_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id       uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  -- Denormalised from the call so the per-person aggregate does not join
  -- `calls` for every row. Write-once, like every other telecaller column in
  -- this schema (0068): who spoke on a call is a fact, not an allocation.
  telecaller_id uuid REFERENCES telecallers(id) ON DELETE SET NULL,

  -- No FK: `call_sops` is keyed (id, version) and this names one exact version.
  -- A composite FK would be correct and would also make deleting an obsolete
  -- SOP version impossible without destroying the scores it produced, which is
  -- the wrong trade for an append-only judgement record.
  sop_id        uuid NOT NULL,
  sop_version   int  NOT NULL,

  -- [{ key, met, evidence }] - see SopStepResult. `met` is THREE-valued:
  -- true / false / null, where null is "the transcript did not settle it".
  -- An inconclusive step is excluded from the score rather than counted as a
  -- miss, so a call that cut off early does not read as a rep who skipped
  -- their script.
  step_results  jsonb NOT NULL DEFAULT '[]',

  -- Derived from step_results over REQUIRED steps only, and only over the ones
  -- the call actually settled. Nullable because a call that settled nothing has
  -- no percentage - and 0 would read as total failure, which is the exact
  -- confident-wrong-number failure the talk metrics gate exists to prevent.
  steps_met     int,
  steps_total   int,
  adherence_pct int CHECK (adherence_pct IS NULL OR adherence_pct BETWEEN 0 AND 100),

  -- WHEN THE CALL HAPPENED, denormalised from `calls.started_at`.
  --
  -- Not `created_at`, which is when the SCORE was written. Those are minutes
  -- apart in normal running and months apart after a backlog reprocess - and a
  -- range filter on created_at would then drop three months of adherence onto
  -- the day somebody re-ran the pipeline, which is exactly the shape of wrong
  -- number a coaching page must never show. Copied rather than joined for the
  -- same reason telecaller_id is: the per-person aggregate should not have to
  -- touch `calls` at all.
  call_started_at timestamptz,

  model         text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- One score per call per SOP. Reprocessing a call updates in place rather
  -- than appending a second, contradictory verdict.
  UNIQUE (call_id, sop_id)
);

CREATE INDEX IF NOT EXISTS call_sop_results_org_created
  ON call_sop_results (org_id, created_at DESC);

-- The per-person aggregate on the productivity page.
-- Ordered on the CALL's own clock, because that is what every range filter
-- over this table asks about.
CREATE INDEX IF NOT EXISTS call_sop_results_telecaller
  ON call_sop_results (org_id, telecaller_id, call_started_at DESC);

COMMENT ON COLUMN call_sop_results.step_results IS
  'Per-step verdicts: [{key, met, evidence}]. `met` is true/false/null - null '
  'means the transcript did not settle it and the step is excluded from the '
  'score, never counted as a miss. `evidence` is a verbatim quote; a step '
  'marked met with no quote is downgraded to null by coerceSopResults, so '
  '"met" always has something behind it a person can check.';

COMMENT ON COLUMN call_sop_results.sop_version IS
  'The exact SOP version this call was judged against. Editing an SOP inserts '
  'a new version, so a past score never silently re-describes itself under a '
  'rule that did not exist when the call was made.';

-- ── Tenancy ─────────────────────────────────────────────────────────────────
-- verify-rls.js fails the deploy by table name on any org_id table missing
-- either of these.
ALTER TABLE call_sops ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_sops FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON call_sops
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE call_sop_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_sop_results FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON call_sop_results
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON call_sops        TO aura_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON call_sop_results TO aura_app;

DO $$
DECLARE api_role text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['call_sops', 'call_sop_results'] LOOP
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;

DO $$ BEGIN
  CREATE TRIGGER call_sops_set_updated_at BEFORE UPDATE ON call_sops
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
