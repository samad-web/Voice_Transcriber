-- 0046_deal_stage_transitions.sql — what actually happened to a deal.
--
-- Layer 3 shipped a conversion funnel that had to GUESS. CRM_STATUS.md says
-- so plainly: "the funnel is inferred from each deal's *current* stage because
-- there is no transition history, so a skipped stage still counts as passed
-- and a lost deal counts only as having entered. A `deal_stage_transitions`
-- table would remove that guesswork and is the natural next step if these
-- numbers start driving decisions."
--
-- The lost-deal case is the one that stings. A deal that reached Negotiation
-- and then died has its `stage` overwritten with the terminal 'lost', erasing
-- every trace of how far it got — so the funnel could only floor it at the
-- entry stage and pretend it never progressed. That is not a rounding error:
-- losses late in the pipeline and losses on first contact are completely
-- different businesses, and the report could not tell them apart.
--
-- One row per move, never updated. This is a ledger, not state: `deals.stage`
-- remains the answer to "where is it now", and nothing here is derived from
-- anything except the move that was actually made.

CREATE TABLE IF NOT EXISTS deal_stage_transitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id      uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,

  -- NULL on the first row, which records the deal entering the pipeline.
  -- Distinguishing "created here" from "moved here" matters: only the second
  -- is a conversion.
  from_stage   text,
  to_stage     text NOT NULL,
  from_status  text,
  to_status    text NOT NULL,

  -- Who moved it. Same two-column shape as `interactions`, and for the same
  -- reason: not every actor is a platform user. The worker's projection and
  -- the automation engine both move deals and neither is a person.
  changed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label  text,

  -- console | pipeline | automation | backfill. `backfill` is load-bearing
  -- rather than decorative — those rows are RECONSTRUCTED, not observed, and
  -- any report that treats them as ground truth is overstating what it knows.
  source       text NOT NULL DEFAULT 'console',

  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- "Everything that happened to this deal, in order" — the drawer's query and
-- the funnel's.
CREATE INDEX IF NOT EXISTS deal_stage_transitions_deal
  ON deal_stage_transitions (deal_id, occurred_at);
-- "Everything that happened in this window" — the conversion report's.
CREATE INDEX IF NOT EXISTS deal_stage_transitions_org_time
  ON deal_stage_transitions (org_id, occurred_at DESC);

ALTER TABLE deal_stage_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_stage_transitions FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON deal_stage_transitions
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT ON deal_stage_transitions TO aura_app;
-- No UPDATE, no DELETE, deliberately. A ledger that can be edited is not a
-- ledger, and nothing in the application has any reason to rewrite history.
-- (ON DELETE CASCADE from `deals` still works — that is the FK's privilege,
-- not the role's.)
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON deal_stage_transitions FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON deal_stage_transitions FROM PUBLIC;


-- ── Reconstructing what we can of the past ────────────────────────────────
--
-- Every deal that already exists gets the two rows that ARE knowable from the
-- columns it carries, and no more:
--
--   1. It entered the pipeline.        (created_at, at its pipeline's entry stage)
--   2. It arrived where it is now.     (stage_changed_at, at its current stage)
--
-- Deliberately NOT invented: the stages in between. A deal created in
-- Prospecting and now in Negotiation obviously passed through Qualification,
-- but "obviously" is exactly the guessing this table exists to stop, and a
-- fabricated row is indistinguishable from an observed one once written. The
-- funnel handles the gap by counting the FURTHEST stage a deal reached rather
-- than summing individual entries, so a backfilled deal contributes correctly
-- to every stage up to where it got — which is genuinely what its history
-- implies — without this migration having to assert timestamps nobody
-- recorded.
--
-- Row 2 is skipped where the deal has not moved (stage_changed_at is the
-- creation time, or it is still at the entry stage), so an untouched deal
-- gets one row rather than a duplicate pair.

INSERT INTO deal_stage_transitions
  (org_id, deal_id, from_stage, to_stage, from_status, to_status, source, occurred_at)
SELECT d.org_id, d.id, NULL, entry.key, NULL, 'open', 'backfill', d.created_at
  FROM deals d
  JOIN deal_pipelines p ON p.id = d.pipeline_id
  CROSS JOIN LATERAL (
    -- The pipeline's first non-terminal stage — the same definition
    -- `entryStage()` uses in packages/shared/src/pipelines.ts.
    SELECT s->>'key' AS key
      FROM jsonb_array_elements(p.stages) WITH ORDINALITY AS t(s, n)
     WHERE COALESCE(s->>'terminal', '') = ''
     ORDER BY n
     LIMIT 1
  ) entry
 WHERE NOT EXISTS (
   SELECT 1 FROM deal_stage_transitions x WHERE x.deal_id = d.id
 );

INSERT INTO deal_stage_transitions
  (org_id, deal_id, from_stage, to_stage, from_status, to_status, source, occurred_at)
SELECT d.org_id, d.id, NULL, d.stage, NULL, d.status, 'backfill', d.stage_changed_at
  FROM deals d
 WHERE d.stage_changed_at > d.created_at
   AND NOT EXISTS (
     SELECT 1 FROM deal_stage_transitions x
      WHERE x.deal_id = d.id AND x.to_stage = d.stage
   );
