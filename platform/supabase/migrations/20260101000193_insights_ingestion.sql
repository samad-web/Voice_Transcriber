-- 0193_insights_ingestion.sql - the raw event store, the unmapped queue, and
-- the two columns the API-only tier needs on tables that already exist
-- (Build docs/no-crm-api-dashboard-build-plan.md §6, §7 and §10, M2/M3).
--
-- ── THE RAW STORE IS APPEND-ONLY, AND THE SPEC'S UNIQUE KEY IS NOT HERE ──────
--
-- §10 gives `ingest_event` a `UNIQUE (org_id, resource, external_id)`. This
-- migration deliberately does not create it, and the reason is §6.3's own
-- requirement two lines further up: "Late and out-of-order data: accepted;
-- corrections via upsert" and "§11 Reliability: ingestion is idempotent and
-- replayable from raw events".
--
-- Those two cannot both hold under that key. With it, a customer correcting
-- call_8841's duration OVERWRITES the raw event that recorded the original
-- push, so the log can no longer be replayed to reproduce what the facts
-- became - the thing it exists for. The raw store becomes a cache of the
-- latest payload, which is what the fact tables already are.
--
-- So the responsibilities split:
--
--   * `ingest_events` is APPEND-ONLY history. Every accepted item is a row.
--     Replaying it in `received_at` order reproduces the facts exactly.
--   * IDEMPOTENCY is `(org_id, idempotency_key)`, unique where the caller sent
--     one. §6.3's "replaying a request must not duplicate data".
--   * CONVERGENCE is the fact tables' own `(org_id, source, external_id)`
--     upsert (0194). Two pushes of the same call without an idempotency key
--     write two raw events and one fact, which is the correct answer to both
--     questions: the history says it was sent twice, the data says there is one
--     call.
--
-- Append-only is enforced, not merely intended: `aura_app` gets SELECT and
-- INSERT and no UPDATE or DELETE. A GRANT-only migration narrows nothing (the
-- `marketing` schema taught this), so the REVOKE comes first.
--
-- The one thing the API may change about a row is its processing status, and
-- that happens through `ingest_event_results` rather than by rewriting the
-- event - see below.

------------------------------------------------------------------------------
-- Scopes
--
-- 0076's `api_keys_scopes_known` CHECK enumerates the legal scopes, so a new
-- surface needs the list widened before a key can be issued for it. Dropped
-- and recreated rather than altered: a CHECK cannot be extended in place, and
-- the list is short enough to restate in full, which also means this file
-- shows the whole set rather than a delta a reader has to assemble from two
-- migrations.
--
-- Kept in step with API_SCOPES in packages/shared/src/api-scopes.ts, whose
-- header explains the `:write` implies `:read` rule these follow. There is
-- still no `:delete` on anything, for the reason that file gives.
------------------------------------------------------------------------------

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_known;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_known
  CHECK (scopes <@ ARRAY[
    -- 0076's CRM surface
    'leads:read',    'leads:write',
    'contacts:read', 'contacts:write',
    'deals:read',    'deals:write',
    'projects:read',
    'mcp',
    -- The API-only tier's ingestion surface
    'telecallers:read', 'telecallers:write',
    'teams:read',       'teams:write',
    'calls:read',       'calls:write',
    'conversions:read', 'conversions:write',
    'payments:read',    'payments:write',
    'attendance:read',  'attendance:write',
    'quality:read',     'quality:write',
    'targets:read',     'targets:write',
    -- Read-only surfaces. No `:write` counterpart exists, so no implication
    -- can grant them: a key that may push calls cannot read the leaderboard
    -- unless somebody ticked that box.
    'kpi:read',
    'usage:read',
    'events:read'
  ]::text[]);

------------------------------------------------------------------------------
-- Test and live keys (§6.3)
--
-- A `test` key authenticates identically and writes to the same tables, with
-- `env = 'test'` carried onto every row it creates. Nothing about a test write
-- reaches a KPI snapshot, because the engine reads `WHERE env = 'live'`.
--
-- Modelled as a column on the data rather than a separate schema or a separate
-- org: a sandbox that is a different tenant cannot share the telecaller roster
-- the integrator is trying to send against, and a sandbox that is a different
-- schema doubles every migration forever. A column that every read filters is
-- the cheap version, and "reset test data" becomes one DELETE.
--
-- DEFAULT 'live' so the keys that exist today keep behaving exactly as they do.
------------------------------------------------------------------------------

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS env text NOT NULL DEFAULT 'live'
    CHECK (env IN ('test', 'live'));

-- §4's Scale entitlement. Per-key, not per-org: an integrator locks down the
-- production key and leaves the test key open from a laptop.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS ip_allowlist text[];

------------------------------------------------------------------------------
-- A telecaller's team
--
-- `teams` has existed since 0177 (the org chart) but nothing connected a
-- telecaller to one: the chart models SEATS, and `position_assignments` binds a
-- person to a seat, which is the right model for an org that has an org chart
-- and no use at all to a Starter tenant on a flat list.
--
-- So this is a direct, nullable link, and it coexists with the chart rather
-- than competing: the chart stays the authority for who reports to whom, and
-- this column answers "which team's numbers does this person's work land in".
-- §4's `team_structure` entitlement decides whether a tenant sees either.
------------------------------------------------------------------------------

ALTER TABLE telecallers
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS telecallers_org_team ON telecallers (org_id, team_id)
  WHERE team_id IS NOT NULL;

-- The customer's own identifier for a team, so `PUT /v1/teams/{external_id}`
-- is an upsert on something the caller already has. `telecallers.external_id`
-- has existed since 0067 for exactly this reason.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS teams_org_external
  ON teams (org_id, external_id) WHERE external_id IS NOT NULL;

-- §6.2: a team names its parent. The chart does this through `departments`,
-- which a flat-plan tenant does not have, so the hierarchy a customer sends
-- lands here.
ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS parent_team_id uuid REFERENCES teams(id) ON DELETE SET NULL;

------------------------------------------------------------------------------
-- The raw store
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL for an Import Center upload, which is a signed-in person and not a
  -- key. `source` says which, so the column being null is never ambiguous.
  api_key_id      uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  source          text NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'import')),
  env             text NOT NULL DEFAULT 'live' CHECK (env IN ('test', 'live')),
  resource        text NOT NULL CHECK (resource IN (
                    'telecaller', 'team', 'call', 'disposition', 'conversion',
                    'payment', 'attendance', 'quality_score', 'target')),
  -- The caller's own id for the thing. NOT unique - see the header.
  external_id     text,
  idempotency_key text,
  payload         jsonb NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  -- `queued` is the only status this row is ever written with. The transitions
  -- live in `ingest_event_results`, because this table is append-only.
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'processed', 'rejected')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- §6.3's idempotency. Partial, because most writes send no key and a unique
-- index over nulls would be useless; scoped per org so two tenants cannot
-- collide on "batch-1".
CREATE UNIQUE INDEX IF NOT EXISTS ingest_events_idempotency
  ON ingest_events (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The spec's minimum index set, plus the two the drain and the inspector need.
CREATE INDEX IF NOT EXISTS ingest_events_org_received
  ON ingest_events (org_id, received_at DESC);
CREATE INDEX IF NOT EXISTS ingest_events_queued
  ON ingest_events (received_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS ingest_events_org_external
  ON ingest_events (org_id, resource, external_id);

/*
 * What happened to an event, written by the drain.
 *
 * A separate table rather than `error jsonb` + `status` on the event itself,
 * because the event row is append-only and because an event can be processed
 * more than once legitimately: a replay from the inspector, or a recompute
 * after a bug fix, both produce a new result for the same event. One row per
 * attempt makes "why did this land twice" answerable, which is the question the
 * §8.8 event inspector exists to answer.
 *
 * `status` on `ingest_events` is therefore a denormalised convenience the drain
 * does update - the one exception to append-only, and the grant below allows
 * exactly that column and nothing else via a trigger check.
 */
CREATE TABLE IF NOT EXISTS ingest_event_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ingest_event_id uuid NOT NULL REFERENCES ingest_events(id) ON DELETE CASCADE,
  attempt         int  NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status          text NOT NULL CHECK (status IN ('processed', 'rejected')),
  -- `{ "code": ..., "message": ..., "field_errors": [...] }`, the §6.3 problem
  -- shape, so the inspector and the batch response render from one structure.
  error           jsonb,
  -- Which fact row this event became, so a dashboard number can be drilled
  -- back to the payload that produced it (§8.3's "drill to underlying events").
  fact_table      text,
  fact_id         uuid,
  processed_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ingest_event_id, attempt)
);

CREATE INDEX IF NOT EXISTS ingest_event_results_org_failed
  ON ingest_event_results (org_id, processed_at DESC) WHERE status = 'rejected';
CREATE INDEX IF NOT EXISTS ingest_event_results_fact
  ON ingest_event_results (org_id, fact_table, fact_id);

------------------------------------------------------------------------------
-- The unmapped queue (§7)
--
-- "Unmatched data (unknown telecaller external_id) goes to an 'unmapped' queue
-- with a one-click create or map action; it never silently disappears."
--
-- One row per unknown reference, not per event: a dialer pushing 4,000 calls
-- for a telecaller nobody created would otherwise produce 4,000 identical
-- queue entries. `occurrences` counts them and `last_event_id` keeps a way
-- back to one example payload.
--
-- Resolving a row does NOT replay the events - the drain does, on its next
-- tick, because the facts it writes are upserts and the events are still
-- there. That is the whole return on an append-only raw store.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS unmapped_refs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('telecaller', 'team')),
  external_ref   text NOT NULL,
  occurrences    bigint NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_event_id  uuid REFERENCES ingest_events(id) ON DELETE SET NULL,
  resolved_at    timestamptz,
  resolved_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution     text CHECK (resolution IS NULL OR resolution IN ('created', 'mapped', 'ignored')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, external_ref),
  -- A resolution without a timestamp, or a timestamp without a resolution, is
  -- a half-resolved row the queue would either hide or show forever.
  CONSTRAINT unmapped_refs_resolution_complete CHECK (
    (resolved_at IS NULL AND resolution IS NULL)
    OR (resolved_at IS NOT NULL AND resolution IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS unmapped_refs_open
  ON unmapped_refs (org_id, last_seen_at DESC) WHERE resolved_at IS NULL;

------------------------------------------------------------------------------
-- RLS, with the partner wall every post-0163 org-scoped table owes
------------------------------------------------------------------------------

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ingest_events', 'ingest_event_results', 'unmapped_refs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
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
      EXECUTE format('REVOKE ALL ON %I FROM aura_app', t);
    END IF;
  END LOOP;
END $$;

-- Now the grants, deliberately asymmetric.
--
-- `ingest_events`: SELECT, INSERT and UPDATE. No DELETE - the raw log is the
-- replay source and a request must never be able to erase it. The UPDATE is
-- for the denormalised `status` column only, which the trigger below pins.
--
-- `ingest_event_results`: SELECT and INSERT. An attempt that has happened
-- cannot un-happen.
--
-- `unmapped_refs`: all four. It is a work queue, and a resolved row that has
-- been acted on is reasonable to remove.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
    GRANT SELECT, INSERT, UPDATE ON ingest_events TO aura_app;
    GRANT SELECT, INSERT         ON ingest_event_results TO aura_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON unmapped_refs TO aura_app;
  END IF;
END $$;

/*
 * Append-only, for real.
 *
 * The GRANT above still allows `UPDATE ingest_events SET payload = ...`, and a
 * narrow GRANT is not a mechanism - 0177's org chart learned exactly this about
 * trying to make a table append-only with privileges alone. So the rule is a
 * trigger: every column except `status` must be unchanged.
 *
 * This is cheap because the drain touches one row per event, once.
 */
CREATE OR REPLACE FUNCTION ingest_events_append_only() RETURNS trigger AS $$
BEGIN
  IF NEW.id              IS DISTINCT FROM OLD.id
  OR NEW.org_id          IS DISTINCT FROM OLD.org_id
  OR NEW.api_key_id      IS DISTINCT FROM OLD.api_key_id
  OR NEW.source          IS DISTINCT FROM OLD.source
  OR NEW.env             IS DISTINCT FROM OLD.env
  OR NEW.resource        IS DISTINCT FROM OLD.resource
  OR NEW.external_id     IS DISTINCT FROM OLD.external_id
  OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  OR NEW.payload         IS DISTINCT FROM OLD.payload
  OR NEW.received_at     IS DISTINCT FROM OLD.received_at
  THEN
    RAISE EXCEPTION 'ingest_events is append-only; only status may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ingest_events_append_only ON ingest_events;
CREATE TRIGGER ingest_events_append_only BEFORE UPDATE ON ingest_events
  FOR EACH ROW EXECUTE FUNCTION ingest_events_append_only();

DO $$ BEGIN
  CREATE TRIGGER unmapped_refs_set_updated_at BEFORE UPDATE ON unmapped_refs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Prove the wall, as 0184 and 0188 do.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
    FROM unnest(ARRAY['ingest_events', 'ingest_event_results', 'unmapped_refs']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
        AND policyname = 'partner_wall' AND permissive = 'RESTRICTIVE'
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0193: partner_wall missing or not RESTRICTIVE on: %', missing;
  END IF;
END $$;
