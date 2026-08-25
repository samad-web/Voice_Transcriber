-- 0040_interactions.sql — Track A2: the unified interaction timeline.
--
-- One row per thing that happened with a contact/account/deal: a call the
-- pipeline processed, a note somebody typed, and (once Layer 1 lands) an
-- email or SMS. The point is that a rep opening a deal sees ONE chronological
-- list rather than having to cross-reference the call explorer by hand.
--
-- Strangler-fig, same as 0034-0039: nothing here reads or writes `calls`,
-- `call_notes` or `call_facts` at migration time. Calls are projected in by
-- the worker dual-write (apps/worker/src/pipeline/crm-objects.ts) and the
-- backfill script, which share one function so they cannot drift.
--
-- `type` is an app-validated string, not a DB CHECK — the same choice
-- 0037 made for custom_field_definitions.object_type, and for the same
-- reason: Layer 1 adds email/sms/whatsapp channels, and that should be a
-- code change, not a migration. See packages/shared/src/interactions.ts for
-- the authoritative enum.

CREATE TABLE IF NOT EXISTS interactions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Attribution only, like accounts/contacts — which desk this happened on.
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  -- call | email | sms | whatsapp | meeting | note (app-validated, see above).
  type           text NOT NULL,
  -- Null for the types where it is meaningless (a note has no direction).
  direction      text CHECK (direction IS NULL OR direction IN ('incoming', 'outgoing')),

  -- All three nullable and all three independent: a call is usually attached
  -- to a contact AND the deal it advanced, a note might be on the account
  -- only. CASCADE because an interaction has no meaning once the object it
  -- describes is gone — unlike merge_log, this is not an audit trail.
  contact_id     uuid REFERENCES contacts(id) ON DELETE CASCADE,
  account_id     uuid REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id        uuid REFERENCES deals(id) ON DELETE CASCADE,

  -- Provenance for a projected call, and the idempotency key that lets the
  -- live dual-write and the backfill run over the same call any number of
  -- times. SET NULL rather than CASCADE: if a call is erased under the
  -- retention policy, the fact that it happened stays on the timeline.
  call_id        uuid REFERENCES calls(id) ON DELETE SET NULL,

  subject        text,
  body           text,
  -- When it HAPPENED, which is not when the row was written — a backfilled
  -- call from March is created_at today but occurred_at in March. Every
  -- timeline orders by this.
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  duration_s     int,

  -- Who did it. Two columns because not every actor is a platform user: a
  -- call's actor is the telecaller's device label, and Layer 1's inbound
  -- email has no user at all.
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label    text,

  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The dual-write/backfill idempotency key. Partial so that non-call rows
-- (which all have call_id NULL) are unconstrained, exactly as
-- deals(source_lead_id) works for the lead projection.
CREATE UNIQUE INDEX IF NOT EXISTS interactions_call
  ON interactions (call_id) WHERE call_id IS NOT NULL AND type = 'call';

-- One index per timeline query shape; all partial, since most rows attach to
-- only one or two of the three objects.
CREATE INDEX IF NOT EXISTS interactions_contact
  ON interactions (contact_id, occurred_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS interactions_deal
  ON interactions (deal_id, occurred_at DESC) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS interactions_account
  ON interactions (account_id, occurred_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS interactions_org_occurred
  ON interactions (org_id, occurred_at DESC);

ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON interactions
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON interactions TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON interactions FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON interactions FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER interactions_set_updated_at BEFORE UPDATE ON interactions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
