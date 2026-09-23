-- The tenant's business identity (doc 27 §4.3-4.4).
--
-- Until now an org had a display name, set once by the operator and never
-- editable, and a branding jsonb of URLs and colours - and nothing that says
-- WHO the business legally is. No legal name, no address, no GSTIN, no state
-- (invoices.controller.ts carried a comment that the home-state setting
-- "doesn't exist yet"). That is the row this creates.
--
-- ── CORE, NOT FINANCE ────────────────────────────────────────────────────────
--
-- Doc 26 first put these fields under Finance settings. They moved here because
-- a call-recording-only tenant has a business identity too, and because doc
-- 26's invoices need to SNAPSHOT the seller from one place rather than keep a
-- second copy in `billing_settings`. That table must not duplicate a column
-- that lives here.
--
-- ── WHAT THE CHECKS ARE, AND ARE NOT ─────────────────────────────────────────
--
-- The GSTIN and PAN patterns are a backstop. The real rule - the mod-36
-- checksum, and "the first two digits are the chosen state's GST code" - is
-- enforced in the API (packages/shared/src/gstin.ts), because a CHECK cannot
-- compute a checksum readably and cannot see the form the state came from.
--
-- `reporting_timezone` and the display name stay on `organizations`, where
-- every report and the whole console already read them; the PUT that saves
-- this row updates those two columns in the same transaction.

CREATE TABLE IF NOT EXISTS org_business_profile (
  org_id          uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- Required for the setup step to count as done (businessProfileComplete),
  -- but nullable here: a half-filled form is still worth saving.
  legal_name      text CHECK (legal_name IS NULL OR btrim(legal_name) <> ''),
  trade_name      text,
  gstin           text CHECK (gstin IS NULL OR gstin ~ '^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  -- Derived from characters 3-12 of the GSTIN whenever there is one; typed only
  -- by an unregistered business that has a PAN.
  pan             text CHECK (pan IS NULL OR pan ~ '^[A-Z]{5}\d{4}[A-Z]$'),
  address_line1   text,
  address_line2   text,
  city            text,
  postal_code     text,
  -- A GST state code ('27' = Maharashtra). Only meaningful when country = 'IN';
  -- the API clears it for any other country.
  state_code      text CHECK (state_code IS NULL OR state_code ~ '^\d{2}$'),
  country         text NOT NULL DEFAULT 'IN' CHECK (country ~ '^[A-Z]{2}$'),
  base_currency   text NOT NULL DEFAULT 'INR' CHECK (base_currency ~ '^[A-Z]{3}$'),
  -- April, the Indian financial year.
  fy_start_month  smallint NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  -- Display only. NOTHING in Aura ever sends to these (safety rule 3); they
  -- exist to be printed on the business's own documents.
  contact_email   text,
  contact_phone   text,
  website         text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE org_business_profile IS
  'Legal identity, address and regional settings of a tenant (doc 27). The seller on its documents.';

ALTER TABLE org_business_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_business_profile FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON org_business_profile
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- REVOKE first, GRANT second. A GRANT-only migration narrows nothing: the
-- Supabase API roles can already reach a new public table by default
-- privileges, and `anon` is the key that ships in the browser bundle.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON org_business_profile FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON org_business_profile FROM PUBLIC;
-- No DELETE: the row goes when its org does (ON DELETE CASCADE), and a
-- tenant clearing its profile is an UPDATE to nulls, not a missing row.
GRANT SELECT, INSERT, UPDATE ON org_business_profile TO aura_app;

DO $$ BEGIN
  CREATE TRIGGER org_business_profile_set_updated_at BEFORE UPDATE ON org_business_profile
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
