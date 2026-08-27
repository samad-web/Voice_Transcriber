-- 0060_invoices_payments.sql — Kailash gap Milestone 1, part 2: invoices
-- (with India-GST fields, since that is this business's actual market) and
-- Razorpay payment collection. Depends on 0059 (products/quotations).
--
-- The money-moves-only-off-a-signed-webhook design mirrors Kailash's own
-- (Sirah CRM) proven pattern, re-implemented against this app's own guard/
-- audit conventions rather than copied: POST /invoices/:id/payment-link is a
-- human clicking "Collect Payment" and only ever creates a Razorpay Payment
-- Link with notify:{sms:false,email:false} (the rep shares the link) — it can
-- never mark an invoice paid by itself. Only the signed razorpay-webhook
-- controller, verified with a raw-body HMAC compare, can do that.

-- ── Invoices ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  account_id      uuid REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id         uuid REFERENCES deals(id) ON DELETE SET NULL,
  quotation_id    uuid REFERENCES quotations(id) ON DELETE SET NULL,
  invoice_number  text NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'void')),
  currency        text NOT NULL DEFAULT 'INR',
  subtotal        numeric NOT NULL DEFAULT 0,
  discount_type   text CHECK (discount_type IN ('percent', 'amount')),
  discount_value  numeric NOT NULL DEFAULT 0,
  -- India GST split, per this business's actual invoicing requirement — not a
  -- generic international tax model. cgst+sgst for an intra-state sale,
  -- igst for inter-state; the API decides which pair applies, this table just
  -- holds whichever the API computed.
  cgst            numeric NOT NULL DEFAULT 0,
  sgst            numeric NOT NULL DEFAULT 0,
  igst            numeric NOT NULL DEFAULT 0,
  customer_gstin  text,
  place_of_supply text,
  total           numeric NOT NULL DEFAULT 0,
  amount_paid     numeric NOT NULL DEFAULT 0,
  due_date        date,
  notes           text,
  owner_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS invoices_org_number ON invoices (org_id, invoice_number);
CREATE INDEX IF NOT EXISTS invoices_org_status ON invoices (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_deal       ON invoices (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_account    ON invoices (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_quotation  ON invoices (quotation_id) WHERE quotation_id IS NOT NULL;

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON invoices
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON invoices FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON invoices FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER invoices_set_updated_at BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Invoice line items ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id    uuid REFERENCES products(id) ON DELETE SET NULL,
  description   text NOT NULL,
  hsn_sac       text,
  quantity      numeric NOT NULL DEFAULT 1,
  unit_price    numeric NOT NULL DEFAULT 0,
  discount_pct  numeric NOT NULL DEFAULT 0,
  tax_rate      numeric NOT NULL DEFAULT 0,
  line_total    numeric NOT NULL DEFAULT 0,
  position      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_items_invoice ON invoice_items (invoice_id, position);

ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON invoice_items
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_items TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON invoice_items FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON invoice_items FROM PUBLIC;

-- ── Payments (Razorpay Payment Links) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id             uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  provider               text NOT NULL DEFAULT 'razorpay',
  razorpay_payment_link_id text,
  razorpay_payment_id    text,
  status                 text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed')),
  amount                 numeric NOT NULL,
  currency               text NOT NULL DEFAULT 'INR',
  created_by_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  captured_at            timestamptz
);

CREATE INDEX IF NOT EXISTS payments_invoice ON payments (invoice_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payments_razorpay_link
  ON payments (razorpay_payment_link_id) WHERE razorpay_payment_link_id IS NOT NULL;

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON payments
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON payments TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON payments FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON payments FROM PUBLIC;

-- ── Webhook idempotency ─────────────────────────────────────────────────
-- Deliberately NOT org-scoped/RLS'd: the webhook controller resolves the org
-- from the payment link's own invoice, off the admin pool, same as
-- messaging-webhook.controller.ts resolves a channel's org before anything
-- else runs. A replayed Razorpay delivery for an event_id already here is a
-- no-op, not a second "paid" transition.
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text NOT NULL DEFAULT 'razorpay',
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_webhook_events_unique ON payment_webhook_events (provider, event_id);

GRANT SELECT, INSERT ON payment_webhook_events TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON payment_webhook_events FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON payment_webhook_events FROM PUBLIC;

-- ── Per-org Razorpay credentials, env fallback ─────────────────────────
-- Same tenant-then-env precedence this codebase already uses for CRM
-- connector / outbound config elsewhere: an org that has connected its own
-- Razorpay account uses it; one that hasn't falls back to the platform's
-- RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET env vars, so a fresh org can start
-- collecting payment without doing anything first.
CREATE TABLE IF NOT EXISTS payment_gateway_config (
  org_id          uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'razorpay',
  key_id          text,
  key_secret      text,
  webhook_secret  text,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_gateway_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_gateway_config FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON payment_gateway_config
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_gateway_config TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON payment_gateway_config FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON payment_gateway_config FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER payment_gateway_config_set_updated_at BEFORE UPDATE ON payment_gateway_config
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Number generation ───────────────────────────────────────────────────
-- Same technique as next_quotation_number() in 0059 — see its comment.
CREATE OR REPLACE FUNCTION next_invoice_number(p_org_id uuid) RETURNS text AS $$
DECLARE
  yr  text := to_char(now(), 'YYYY');
  seq int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('invoice_number:' || p_org_id::text, 0));
  SELECT count(*) + 1 INTO seq FROM invoices
   WHERE org_id = p_org_id AND invoice_number LIKE 'INV-' || yr || '-%';
  RETURN 'INV-' || yr || '-' || lpad(seq::text, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- ── Permission grants for the new 'invoice' object type ────────────────
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'invoice', a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete'), ('export')) AS a(action)
 WHERE r.is_system
   AND (
     r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
     OR (r.key = 'workspace_member' AND a.action IN ('view', 'create', 'edit'))
     OR (r.key = 'viewer' AND a.action = 'view')
   )
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.object_type = 'invoice' AND rp.action = a.action
   );
