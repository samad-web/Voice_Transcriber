-- 0174_finance_connectors.sql
-- Build docs/finance-section-build-plan, M3: the connector framework (§7).
--
-- ── THE RAW EVENT STORE *IS* THE QUEUE ──────────────────────────────────────
--
-- §7.2 asks for a queue with exponential backoff and a dead-letter queue.
-- RabbitMQ is right here and the call pipeline uses it - but §7.2.5 also
-- requires that "the normalizer must be re-runnable from stored raw events
-- after a bug fix", and an acked message is gone. A queue plus a raw store
-- means two systems that can disagree about what has been processed.
--
-- So `connector_events` is both. The webhook verifies the signature, writes the
-- row and acks in one statement (§7.2.1-2); a worker sweep claims unprocessed
-- rows with `FOR UPDATE SKIP LOCKED`; `attempts` / `next_attempt_at` / `error`
-- carry the backoff; and `attempts >= max` is the dead letter - a ROW, which is
-- exactly what §7.2.4's "UI to view, fix and replay failed events" needs. A
-- replay is `UPDATE … SET processed_at = NULL, attempts = 0`, over any window,
-- as many times as a bug needs. DECISIONS.md §3.5 records the trade.
--
-- ── WHY THIS TABLE IS ORG-SCOPED WHEN `payment_webhook_events` IS NOT ───────
--
-- 0060's idempotency ledger is deliberately NOT tenant-scoped: that controller
-- resolves the org FROM the payload's payment-link id, so it cannot already be
-- inside the org context it is establishing. This is different - a webhook
-- arrives on a per-account URL carrying `connector_account_id`, so the org is
-- known from the ROUTE before the body is parsed, and the row can be written
-- inside the tenant transaction like everything else.

-- ── §7.1 the connector account ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connector_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- "razorpay", "cashfree", "bank_csv"... TEXT and not an enum, because §7.4's
  -- whole point is that a new gateway is a mapper plus config. A CHECK here
  -- would make the registry's claim false: shipping Cashfree would need a
  -- migration, which is precisely what M10's acceptance criterion forbids.
  type          text NOT NULL,
  -- What a person called this account. Two Razorpay accounts (one live, one
  -- for a sister company) are a real configuration.
  label         text NOT NULL,
  -- ── §7.2.8: ENCRYPTED, AND NEVER RETURNED BY ANY API ───────────────────
  --
  -- Sealed with `encryptSecret()` (packages/db/src/secrets.ts, AES-256-GCM
  -- under CRM_SECRET_KEY) before it reaches this column, the same envelope the
  -- CRM integrations and org OAuth apps use. The column is named `_enc` so a
  -- `SELECT *` in a review reads as obviously wrong, and no controller may put
  -- it in a response - `CONNECTOR_COLUMNS` in the API omits it and a test pins
  -- that it does.
  credentials_enc jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Non-secret connector configuration: which events to subscribe to, the
  -- notes keys to read a deal id from, the backfill start date.
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'disconnected'
                  CHECK (status IN ('connected', 'disconnected', 'needs_reauth', 'error')),
  -- §7.5's health page reads these four. `last_event_at` is the one that
  -- matters most: a connector whose status says "connected" and which has not
  -- delivered anything for a day is the failure that costs money, and
  -- `connector_unhealthy` fires on it.
  last_event_at      timestamptz,
  last_error         text,
  consecutive_failures int NOT NULL DEFAULT 0,
  token_expires_at   timestamptz,
  -- §7.2.6's daily reconciliation: how far it has caught up.
  reconciled_through date,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One account per (org, type, label), so re-connecting updates rather than
-- accumulating a second copy of the same gateway.
CREATE UNIQUE INDEX IF NOT EXISTS connector_accounts_label
  ON connector_accounts (org_id, type, lower(label));
CREATE INDEX IF NOT EXISTS connector_accounts_org ON connector_accounts (org_id, type);

ALTER TABLE connector_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_accounts FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON connector_accounts
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_accounts TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON connector_accounts FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON connector_accounts FROM PUBLIC;
DO $$ BEGIN
  CREATE TRIGGER connector_accounts_set_updated_at BEFORE UPDATE ON connector_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The forward references 0173 left open, now that the table exists.
ALTER TABLE finance_payments
  DROP CONSTRAINT IF EXISTS finance_payments_connector_account_id_fkey;
ALTER TABLE finance_payments
  ADD CONSTRAINT finance_payments_connector_account_id_fkey
  FOREIGN KEY (connector_account_id) REFERENCES connector_accounts(id) ON DELETE SET NULL;

ALTER TABLE finance_settlements
  DROP CONSTRAINT IF EXISTS finance_settlements_connector_account_id_fkey;
ALTER TABLE finance_settlements
  ADD CONSTRAINT finance_settlements_connector_account_id_fkey
  FOREIGN KEY (connector_account_id) REFERENCES connector_accounts(id) ON DELETE SET NULL;

-- ── §7.2 the raw event store ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connector_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- CASCADE: disconnecting an account and deleting it takes its event history
  -- with it. That is the right reading - the events are only interpretable
  -- against the account's own mapper and credentials - and `finance_payments`
  -- survives independently because the money did arrive.
  connector_account_id uuid NOT NULL REFERENCES connector_accounts(id) ON DELETE CASCADE,
  -- The gateway's own id for the DELIVERY (Razorpay's x-razorpay-event-id) or,
  -- when it sends none, a hash of the raw body. Either way it is what makes
  -- §7.2.3's unique index a real idempotency key.
  external_id   text NOT NULL,
  event_type    text,
  -- ── IMMUTABLE, AND THE WHOLE BODY ──────────────────────────────────────
  --
  -- §7.2.2: "store the raw event first, immutable". The entire payload, not
  -- the fields today's mapper happens to read - because §7.2.5's replay after
  -- a bug fix is only possible if the data the fixed mapper needs is still
  -- here. A trigger below refuses an UPDATE of this column.
  payload       jsonb NOT NULL,
  -- Kept so a signature can be re-verified later, and so a mapper bug can be
  -- reproduced against the exact bytes. §13's "PII minimized in raw event
  -- views" is honoured in the UI, which redacts on read rather than on write -
  -- redacting on write would destroy the replay.
  headers       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- §7.2.1: verify BEFORE parsing. A row with `signature_ok = false` is kept
  -- deliberately (the request was rejected with a 4xx, and the row is the
  -- evidence) and is never processed.
  signature_ok  boolean NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  -- §7.2.4's backoff and dead letter.
  attempts      int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error         text,
  -- How this arrived: a webhook, the catch-up poll, the backfill, or a replay.
  -- Worth distinguishing because "the webhook never arrived but reconciliation
  -- caught it" is the diagnosis §7.2.6 exists to produce.
  delivery      text NOT NULL DEFAULT 'webhook'
                  CHECK (delivery IN ('webhook', 'poll', 'backfill', 'replay'))
);

-- §7.2.3's idempotency key. The second delivery of the same event violates it
-- and the handler treats that as success.
CREATE UNIQUE INDEX IF NOT EXISTS connector_events_external
  ON connector_events (connector_account_id, external_id);
-- §9's required index: the sweep's claim query.
CREATE INDEX IF NOT EXISTS connector_events_account_processed
  ON connector_events (connector_account_id, processed_at);
-- What the sweep actually scans - unprocessed, due, not dead-lettered - and
-- nothing else. A partial index so a tenant with a million processed events
-- costs the sweep nothing.
CREATE INDEX IF NOT EXISTS connector_events_pending
  ON connector_events (next_attempt_at)
  WHERE processed_at IS NULL AND signature_ok;
-- The failed-event list on the health page.
CREATE INDEX IF NOT EXISTS connector_events_failed
  ON connector_events (org_id, received_at DESC)
  WHERE processed_at IS NULL AND error IS NOT NULL;

ALTER TABLE connector_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_events FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON connector_events
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- DELETE is granted, unlike the ledger's: §13 asks for PII minimisation, and
-- ageing out raw payloads older than the retention window is how that is
-- eventually done. The payload is never EDITED - see the trigger.
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_events TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON connector_events FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON connector_events FROM PUBLIC;

-- ── The payload is immutable, enforced ─────────────────────────────────────
--
-- §7.2.2 says "immutable" and the sweep legitimately UPDATEs the row
-- (processed_at, attempts, error), so a blanket refusal is not available and a
-- column-level grant cannot express "all columns except this one". A trigger
-- can.
--
-- Without it, a mapper bug could be "fixed" by editing the stored payload,
-- which destroys the only evidence of what the gateway actually sent - and
-- makes §7.2.5's replay a replay of somebody's guess.
CREATE OR REPLACE FUNCTION connector_events_refuse_payload_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.headers IS DISTINCT FROM OLD.headers
     OR NEW.signature_ok IS DISTINCT FROM OLD.signature_ok
     OR NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'connector_events.payload is immutable'
      USING ERRCODE = 'check_violation',
            HINT = 'Replay the event instead: set processed_at = NULL and fix the mapper.';
  END IF;
  RETURN NEW;
END
$fn$;

DO $$ BEGIN
  CREATE TRIGGER connector_events_immutable_payload
    BEFORE UPDATE ON connector_events
    FOR EACH ROW EXECUTE FUNCTION connector_events_refuse_payload_edit();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The last forward reference from 0173.
ALTER TABLE finance_payments
  DROP CONSTRAINT IF EXISTS finance_payments_raw_event_id_fkey;
ALTER TABLE finance_payments
  ADD CONSTRAINT finance_payments_raw_event_id_fkey
  FOREIGN KEY (raw_event_id) REFERENCES connector_events(id) ON DELETE SET NULL;

-- ── Migrating what already exists ──────────────────────────────────────────
--
-- Every org with a Razorpay key saved in `payment_gateway_config` (0060/0099)
-- gets a `connector_accounts` row, so the health page is not empty for the
-- tenants who have been collecting money all along.
--
-- `credentials_enc` is left EMPTY on purpose and `status` is `needs_reauth`.
-- The existing columns hold the key in whatever state 0060 left it, the
-- gateway path still reads them, and copying a possibly-plaintext secret into
-- a column named `_enc` would be a lie that the next reader would believe.
-- Re-saving the key from the connector screen seals it properly.
INSERT INTO connector_accounts (org_id, type, label, status, config)
SELECT c.org_id,
       c.provider,
       initcap(c.provider),
       'needs_reauth',
       jsonb_build_object('migratedFrom', 'payment_gateway_config', 'enabled', c.enabled)
  FROM payment_gateway_config c
 WHERE c.key_id IS NOT NULL
ON CONFLICT (org_id, type, lower(label)) DO NOTHING;

DO $do$
DECLARE migrated int;
BEGIN
  SELECT count(*) INTO migrated FROM connector_accounts
   WHERE config ? 'migratedFrom';
  RAISE NOTICE '0174: % connector account(s) created from payment_gateway_config - each needs its key re-saved to seal it', migrated;
END $do$;
