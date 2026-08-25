-- 0037_custom_fields.sql — CRM Phase 1 foundation, part 4: org-definable
-- fields on Contact/Account/Deal.
--
-- Generalises two existing precedents instead of inventing a third: the
-- dynamic-field-DEFINITION shape from agents.field_schema / ExtractionField
-- (packages/shared/src/extraction.ts), and call_facts' typed-EAV-with-typed-
-- columns shape for VALUE storage.
--
-- object_type is an open string, app-validated by a zod enum (currently
-- contact|account|deal — packages/shared/src/custom-fields.ts), not a DB
-- CHECK — same reasoning as ExtractionFieldType being a zod enum: widening it
-- to a future custom-object type is meant to be a code change, not a
-- migration.

CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  object_type text NOT NULL,
  -- Same identifier rule as ExtractionField.key.
  key         text NOT NULL,
  label       text NOT NULL,
  -- App-validated enum: text|number|date|boolean|picklist|multiselect|lookup.
  -- Immutable after creation (app-enforced) — a field whose storage type
  -- needs to change is archived and a new one created, not mutated in place,
  -- the same reasoning that keeps agents versioned rather than edited.
  type        text NOT NULL,
  description text,
  required    bool NOT NULL DEFAULT false,
  -- [{value,label}] for picklist/multiselect.
  options     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Which object type a 'lookup' field points at.
  lookup_object_type text,
  -- {min,max}, mirrors ExtractionField.validation.
  validation  jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order  int NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_field_definitions_org_object_key
  ON custom_field_definitions (org_id, object_type, key);
CREATE INDEX IF NOT EXISTS custom_field_definitions_org_object_active
  ON custom_field_definitions (org_id, object_type, sort_order) WHERE status = 'active';

ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON custom_field_definitions
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_field_definitions TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON custom_field_definitions FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON custom_field_definitions FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER custom_field_definitions_set_updated_at BEFORE UPDATE ON custom_field_definitions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Value storage ──────────────────────────────────────────────────────
-- Three parallel typed-EAV tables, one per object, rather than one
-- (object_type, record_id) polymorphic table: record_id in a single generic
-- table can't be a real FK across three target tables, which means no
-- ON DELETE CASCADE and no referential guarantee — a first for this schema,
-- where every other FK is real. object_type stays open on the definitions
-- table above; it is specifically value STORAGE that gets the fixed-table
-- treatment. No updated_at/trigger, matching call_facts exactly — these rows
-- are always fully replaced via ON CONFLICT DO UPDATE, never partially edited.

CREATE TABLE IF NOT EXISTS contact_custom_field_values (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  field_id   uuid NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  value_text text,
  value_num  numeric,
  value_bool bool,
  value_date date,
  value_json jsonb,
  PRIMARY KEY (contact_id, field_id)
);
CREATE INDEX IF NOT EXISTS contact_custom_field_values_kv
  ON contact_custom_field_values (org_id, field_id, value_text);

CREATE TABLE IF NOT EXISTS account_custom_field_values (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  field_id   uuid NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  value_text text,
  value_num  numeric,
  value_bool bool,
  value_date date,
  value_json jsonb,
  PRIMARY KEY (account_id, field_id)
);
CREATE INDEX IF NOT EXISTS account_custom_field_values_kv
  ON account_custom_field_values (org_id, field_id, value_text);

CREATE TABLE IF NOT EXISTS deal_custom_field_values (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id    uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  field_id   uuid NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  value_text text,
  value_num  numeric,
  value_bool bool,
  value_date date,
  value_json jsonb,
  PRIMARY KEY (deal_id, field_id)
);
CREATE INDEX IF NOT EXISTS deal_custom_field_values_kv
  ON deal_custom_field_values (org_id, field_id, value_text);

-- RLS + grants, identical treatment for all three value tables — looped the
-- same way 0001's original table set was, so adding a fourth later is a
-- one-line change to the array rather than a copy-pasted block.
DO $$
DECLARE
  t text;
  api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contact_custom_field_values', 'account_custom_field_values', 'deal_custom_field_values'] LOOP
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
