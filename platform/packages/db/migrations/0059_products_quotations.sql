-- 0059_products_quotations.sql - Kailash gap Milestone 1, part 1: a product
-- catalogue and quotations, so a rep can price something before there's
-- anything to invoice. Greenfield - no existing table modeled a price list or
-- a line-item document before this.
--
-- Line-item math (quantity/unit_price/discount/tax -> line_total, then a
-- document-level discount/tax rollup) is NOT trusted to SQL generated columns
-- here: it is computed once, in application code, by the pure function in
-- packages/shared/src/quotations.ts, and written as plain numeric columns.
-- Two engines agreeing on money math by accident is worse than one engine
-- owning it - see that file's header for the full reasoning.

-- ── Products ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sku         text,
  description text,
  unit_price  numeric NOT NULL DEFAULT 0,
  currency    text NOT NULL DEFAULT 'INR',
  tax_rate    numeric NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS products_org_sku
  ON products (org_id, lower(sku)) WHERE sku IS NOT NULL AND status <> 'archived';
CREATE INDEX IF NOT EXISTS products_org_name ON products (org_id, name);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON products
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON products TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON products FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON products FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Quotations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id     uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  account_id       uuid REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id       uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- A deal being deleted must not be blocked by an old quote hanging off it -
  -- SET NULL, not the RESTRICT deals.pipeline_id uses for a live pipeline.
  deal_id          uuid REFERENCES deals(id) ON DELETE SET NULL,
  quotation_number text NOT NULL,
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  currency         text NOT NULL DEFAULT 'INR',
  subtotal         numeric NOT NULL DEFAULT 0,
  discount_type    text CHECK (discount_type IN ('percent', 'amount')),
  discount_value   numeric NOT NULL DEFAULT 0,
  tax_total        numeric NOT NULL DEFAULT 0,
  total            numeric NOT NULL DEFAULT 0,
  valid_until      date,
  notes            text,
  owner_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS quotations_org_number ON quotations (org_id, quotation_number);
CREATE INDEX IF NOT EXISTS quotations_org_status   ON quotations (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS quotations_deal         ON quotations (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS quotations_account      ON quotations (account_id) WHERE account_id IS NOT NULL;

ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotations FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON quotations
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON quotations TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON quotations FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON quotations FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER quotations_set_updated_at BEFORE UPDATE ON quotations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Quotation line items ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quotation_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quotation_id  uuid NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id    uuid REFERENCES products(id) ON DELETE SET NULL,
  description   text NOT NULL,
  quantity      numeric NOT NULL DEFAULT 1,
  unit_price    numeric NOT NULL DEFAULT 0,
  discount_pct  numeric NOT NULL DEFAULT 0,
  tax_rate      numeric NOT NULL DEFAULT 0,
  -- Written by the API from computeLineTotal(), never trusted from the
  -- client and never a generated column - see this file's header.
  line_total    numeric NOT NULL DEFAULT 0,
  position      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quotation_items_quotation ON quotation_items (quotation_id, position);

ALTER TABLE quotation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotation_items FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON quotation_items
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON quotation_items TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON quotation_items FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON quotation_items FROM PUBLIC;

-- ── Number generation ───────────────────────────────────────────────────
-- Q-<year>-<0001>, unique per org. pg_advisory_xact_lock serializes
-- concurrent callers on the SAME org (different orgs hash to different keys
-- and never contend) for the life of the caller's transaction, so the
-- count-then-generate below can't race two creates into the same number -
-- the alternative, a dedicated per-org sequence table, is more moving parts
-- than this record volume ever needs.
CREATE OR REPLACE FUNCTION next_quotation_number(p_org_id uuid) RETURNS text AS $$
DECLARE
  yr  text := to_char(now(), 'YYYY');
  seq int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('quotation_number:' || p_org_id::text, 0));
  SELECT count(*) + 1 INTO seq FROM quotations
   WHERE org_id = p_org_id AND quotation_number LIKE 'Q-' || yr || '-%';
  RETURN 'Q-' || yr || '-' || lpad(seq::text, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- ── Permission grants for the two new object types ─────────────────────
-- Same predicate 0041/0055 used, so a role's product/quotation grants match
-- its contact grants. CrmPermissionsGuard denies anything ungranted, so
-- without this every existing user is locked out the day this ships.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, t.object_type, a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('product'), ('quotation')) AS t(object_type)
  CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete'), ('export')) AS a(action)
 WHERE r.is_system
   AND (
     r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
     OR (r.key = 'workspace_member' AND a.action IN ('view', 'create', 'edit'))
     OR (r.key = 'viewer' AND a.action = 'view')
   )
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.object_type = t.object_type AND rp.action = a.action
   );
