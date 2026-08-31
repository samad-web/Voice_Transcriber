-- 0049_automation.sql - PRD Layer 2: when X happens, do Y.
--
-- Three tables, and the split between them is the whole design:
--
--   automation_rules   what a tenant configured
--   automation_events  a queue of things that happened, not yet considered
--   automation_runs    what the engine actually did about each one
--
-- ── WHY A QUEUE AND NOT AN INLINE CALL ────────────────────────────────────
--
-- The obvious implementation is to run the rules inside the request that
-- caused them - in the deal PATCH, right after the stage moves. That couples
-- a tenant's own configuration to the latency and the failure modes of every
-- console action: a rule with four actions makes dragging a card visibly
-- slower, and a rule that throws turns a successful stage change into a 500
-- the user has to interpret. The API therefore writes ONE row here and
-- returns; the worker drains it. Same shape as the CRM outbox, and the same
-- reasoning that keeps projectLeadToCrm non-blocking.
--
-- ── WHY LOOPS ARE IMPOSSIBLE ──────────────────────────────────────────────
--
-- Rules can move deals, and a moved deal is a stage-change event, which is a
-- trigger. That is a loop unless something stops it, and the something is
-- structural rather than a depth counter: NOTHING THE EXECUTOR WRITES EVER
-- ENQUEUES AN EVENT. Only the API (a person did something) and the sweep (a
-- deadline passed) insert here. A rule can therefore cause another rule's
-- condition to become true, but it cannot cause another rule to run - which
-- is a limitation worth having, and stated in the worker's module header too.

CREATE TABLE IF NOT EXISTS automation_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name         text NOT NULL,
  description  text,
  -- App-validated against AutomationTrigger, like every other open set here.
  trigger      text NOT NULL,
  -- Field comparisons as data, never an expression language - see
  -- packages/shared/src/automation.ts for why.
  conditions   jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions      jsonb NOT NULL DEFAULT '[]'::jsonb,

  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),

  -- Cheap operator answers to "is this thing doing anything?", which is the
  -- first question anybody asks about an automation they cannot see running.
  run_count    bigint NOT NULL DEFAULT 0,
  last_run_at  timestamptz,

  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_rules_org_trigger
  ON automation_rules (org_id, trigger) WHERE status = 'active';


CREATE TABLE IF NOT EXISTS automation_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  trigger      text NOT NULL,

  -- What it happened to. No FK: an event about a deal that is deleted a second
  -- later is still a true statement about the past, and a cascade would make
  -- the queue silently lose work mid-drain.
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  -- The flattened facts (AutomationSubject), captured AT THE MOMENT IT
  -- HAPPENED. Deliberately not re-read at drain time: a rule about "moved out
  -- of Negotiation" must see the stage it moved out of, which the deal row no
  -- longer remembers by the time the worker looks.
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Sweep-produced events only. "This deal has been idle 30 days" stays true
  -- every tick, and without this the sweep would create a task a minute
  -- forever. Event-produced rows leave it null: a person moving a card twice
  -- really did do two things.
  dedupe_key   text,

  attempts     int NOT NULL DEFAULT 0,
  processed_at timestamptz,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_events_dedupe
  ON automation_events (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- The drain's only query: oldest unprocessed first.
CREATE INDEX IF NOT EXISTS automation_events_pending
  ON automation_events (created_at) WHERE processed_at IS NULL;


CREATE TABLE IF NOT EXISTS automation_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id      uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  event_id     uuid REFERENCES automation_events(id) ON DELETE SET NULL,

  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  -- False rows are kept, not discarded. "Why didn't my rule fire?" is the
  -- most common question about any automation system, and a log that only
  -- records successes cannot answer it.
  matched      bool NOT NULL,
  -- What each action did, or why it could not: [{type, ok, detail}].
  outcome      jsonb NOT NULL DEFAULT '[]'::jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automation_runs_rule
  ON automation_runs (rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_subject
  ON automation_runs (subject_id, created_at DESC);


-- RLS + grants, looped over all three, same treatment as 0037's value tables.
DO $$
DECLARE
  t text;
  api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['automation_rules', 'automation_events', 'automation_runs'] LOOP
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
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;

DO $$ BEGIN
  CREATE TRIGGER automation_rules_set_updated_at BEFORE UPDATE ON automation_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
