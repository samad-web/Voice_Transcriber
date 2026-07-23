-- 0008_crm_outbox.sql — configurable CRM dispatch + a durable outgoing queue.
--
-- Before this, crm-dispatch was a single unauthenticated fetch whose body shape
-- was hardcoded, with `attempts` written as a literal 1. A CRM that was briefly
-- down lost the lead permanently, and a CRM that required auth could never be
-- integrated at all.
--
-- Two changes:
--
--   1. crm_integrations becomes configuration rather than just a URL. Endpoint,
--      auth scheme, extra headers and the outgoing payload shape all live in the
--      row, so onboarding a new CRM is an INSERT and not a deploy. `field_map`
--      already existed for this and was never read; it now defines the body.
--
--   2. crm_sync_log becomes the outbox. One row per (call, integration) holds
--      the pending send, when it may next be tried, and the full request and
--      response of the last attempt. A worker restart loses nothing because the
--      queue is the table.

-- ── 1. Integration configuration ──────────────────────────────────────
ALTER TABLE crm_integrations
  -- Destination URL. Previously buried in auth->>'url'; promoted to a column so
  -- it can be indexed, validated and shown in the console without unwrapping.
  ADD COLUMN IF NOT EXISTS endpoint text,
  -- none   → no credential (the old behaviour)
  -- bearer → Authorization: Bearer <secret>
  -- header → <auth_header>: <secret>   e.g. X-API-Key
  ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS auth_header text NOT NULL DEFAULT 'X-API-Key',
  -- TODO (§2.5): envelope-encrypt before GA. Same exposure as auth.jsonb today.
  ADD COLUMN IF NOT EXISTS auth_secret text,
  -- Static headers merged into every request (tenant ids, routing hints, ...).
  ADD COLUMN IF NOT EXISTS headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Give up after this many attempts and park the row as 'dead'.
  ADD COLUMN IF NOT EXISTS max_attempts int NOT NULL DEFAULT 6,
  -- Ceiling on drain rate so a backlog can't trip the receiver's rate limit.
  ADD COLUMN IF NOT EXISTS rate_limit_per_min int NOT NULL DEFAULT 60;

DO $$ BEGIN
  ALTER TABLE crm_integrations
    ADD CONSTRAINT crm_integrations_auth_type_check
    CHECK (auth_type IN ('none', 'bearer', 'header'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill the endpoint for integrations created under the old shape.
UPDATE crm_integrations
   SET endpoint = auth->>'url'
 WHERE endpoint IS NULL AND auth ? 'url';

-- ── 2. crm_sync_log becomes the outbox ────────────────────────────────
ALTER TABLE crm_sync_log
  -- NULL = not scheduled (terminal). A due row is status='pending' AND
  -- next_attempt_at <= now().
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS request_body jsonb,
  ADD COLUMN IF NOT EXISTS response_status int,
  -- Truncated by the writer; a CRM returning an HTML error page must not bloat
  -- the row.
  ADD COLUMN IF NOT EXISTS response_body text,
  -- Echoed to the receiver as X-Request-Id so one id traces both systems.
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

-- 'dead' = attempts exhausted or a terminal 4xx; distinct from 'failed' so a
-- transient failure awaiting retry is not confused with one that gave up.
ALTER TABLE crm_sync_log DROP CONSTRAINT IF EXISTS crm_sync_log_status_check;
ALTER TABLE crm_sync_log
  ADD CONSTRAINT crm_sync_log_status_check
  CHECK (status IN ('pending', 'synced', 'failed', 'dead'));

-- One outbox row per (call, integration): re-processing a call must reset the
-- existing row rather than queue a second delivery of the same lead. Collapse
-- any pre-existing duplicates (keeping the newest) before enforcing it.
DELETE FROM crm_sync_log a
 USING crm_sync_log b
 WHERE a.call_id = b.call_id
   AND a.integration_id = b.integration_id
   AND a.created_at < b.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS crm_sync_log_call_integration
  ON crm_sync_log (call_id, integration_id);

-- The drain query: due rows, oldest first.
CREATE INDEX IF NOT EXISTS crm_sync_log_due
  ON crm_sync_log (status, next_attempt_at)
  WHERE status = 'pending';
