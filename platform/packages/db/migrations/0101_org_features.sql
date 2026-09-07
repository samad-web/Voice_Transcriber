-- 0101_org_features.sql - the client's own switchboard, underneath the
-- provider's entitlement.
--
-- ── TWO LAYERS, AND WHY THEY MUST NOT BE ONE ────────────────────────────────
--
-- `organizations.enabled_modules` (0072) already answers a question that looks
-- like this one: which parts of the product does this tenant get. It is the
-- wrong column for the feature switches a client asked for, and merging them
-- would be the kind of mistake that is invisible until it is a contract
-- dispute.
--
--   enabled_modules      what the tenant HAS BOUGHT. Written by the operator
--                        console only. `call_intel` in particular decides
--                        whether a client may read a word-for-word transcript
--                        of a customer's phone call - a decision per client
--                        contract, per 0072's own header.
--
--   org_feature_settings what the tenant has CHOSEN to use, inside that.
--                        Written by the client's own Owner, from their own
--                        console.
--
-- The composition is intersection, in one direction only: a client switch can
-- narrow an entitlement and can never widen one. That is the same invariant
-- the persona model carries ("adding a persona must only ever narrow access",
-- roles.ts), and it is what makes this table safe to expose to a customer -
-- the worst an owner can do with it is hide their own pages from themselves.
--
-- ── WHY THE TABLE IS SPARSE ─────────────────────────────────────────────────
--
-- A row exists ONLY where the client has departed from the catalogue's
-- default. No row means "whatever the product ships as the default for this
-- feature", not "off".
--
-- The alternative - one row per feature per org, written at provisioning -
-- reads as tidier and rots immediately: every feature added afterwards needs a
-- backfill, and an org created between the deploy and the backfill silently
-- has the feature off. Sparse means a new feature lands with its intended
-- default for every tenant, existing and future, with no data migration at
-- all. The cost is that "reset to defaults" is a DELETE rather than an UPDATE,
-- which is not a cost.
--
-- ── WHAT IS DELIBERATELY NOT MODELLED ───────────────────────────────────────
--
-- No per-user overrides. Who sees what is already answered twice - by the
-- console persona (roles.ts) and by the permission grid (0039) - and a third
-- axis that could also hide a page would make "why can't I see Invoices"
-- unanswerable without reading three tables. This is a workspace-wide
-- decision about which parts of the product this business uses.
--
-- No `hidden_by_operator`. Hawcus has one (`GET /api/integrations/visibility`
-- → `{hidden}`) and it is a reasonable white-label control, but it is the
-- operator's half and belongs in `enabled_modules` beside the entitlement it
-- resembles, not in the customer's own table.

CREATE TABLE IF NOT EXISTS org_feature_settings (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The catalogue key (packages/shared/src/features.ts). Deliberately NOT a
  -- CHECK constraint listing every feature: the catalogue is TypeScript read
  -- by both tiers, and a CHECK here would be a fourth copy of it that only
  -- fails at write time, in production, after the code that writes it shipped.
  -- The API validates against the catalogue before writing; an unknown key
  -- reaching this table is inert - `resolveFeatures` ignores what it does not
  -- recognise, which is also what makes a feature safely REMOVABLE from the
  -- catalogue without stranding rows.
  --
  -- The shape is still constrained, because a key that is not a slug is a bug
  -- in the caller rather than a feature nobody has heard of.
  feature_key text NOT NULL CHECK (feature_key ~ '^[a-z][a-z0-9_]{0,47}$'),

  enabled     bool NOT NULL,

  -- Who last flipped it. A feature going missing from a colleague's console is
  -- reported as a bug, and the first useful question is "did somebody turn it
  -- off" - a question the audit log can also answer, but only if somebody
  -- thinks to look there. SET NULL rather than CASCADE: the setting outlives
  -- the person who made it, and losing the row would silently restore a
  -- default the business had deliberately changed.
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, feature_key)
);

ALTER TABLE org_feature_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_feature_settings FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON org_feature_settings
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

GRANT SELECT, INSERT, UPDATE, DELETE ON org_feature_settings TO aura_app;
DO $do$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON org_feature_settings FROM %I', api_role);
    END IF;
  END LOOP;
END $do$;
REVOKE ALL ON org_feature_settings FROM PUBLIC;

DO $do$ BEGIN
  CREATE TRIGGER org_feature_settings_set_updated_at BEFORE UPDATE ON org_feature_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

COMMENT ON TABLE org_feature_settings IS
  'Client-chosen feature switches, sparse: a row exists only where the tenant '
  'has departed from the catalogue default in packages/shared/src/features.ts. '
  'Narrows organizations.enabled_modules and can never widen it.';

-- ── The worker''s question ──────────────────────────────────────────────────
--
-- The console resolves features per request through the API. The WORKER cannot:
-- its sweeps run over every org at once, on the admin pool, with no request and
-- no RLS context, and asking one org at a time would be one Mumbai→Seoul round
-- trip per tenant per sweep.
--
-- This function answers "is this feature on for this org" as a single SQL
-- expression that a sweep can join against. It takes the org id explicitly
-- rather than reading `app.org_id`, so it cannot silently answer about
-- whichever tenant happened to be on the connection.
--
-- Deliberately NOT `SECURITY DEFINER`. On the admin pool - where the sweeps
-- pick their org list - RLS is bypassed already and a definer would add
-- nothing but an owner-privilege footgun. Inside `withOrgContext` the org
-- policy narrows both tables to the current tenant, so asking about a
-- DIFFERENT org returns no row at all: the function answers NULL, and every
-- caller reads NULL as "not enabled". Fail-closed in the only direction that
-- matters.
--
-- The DEFAULT is the caller''s to supply, and that is the load-bearing argument.
-- The catalogue's defaults live in TypeScript, and duplicating them here would
-- create exactly the drift this migration's header refuses elsewhere. So the
-- sweep passes the default it read from the catalogue, and this function only
-- answers the two things SQL actually knows: is the module entitled, and has
-- the client overridden it.
CREATE OR REPLACE FUNCTION org_feature_enabled(
  p_org_id  uuid,
  p_feature text,
  p_module  text,
  p_default boolean
) RETURNS boolean AS $fn$
  SELECT
    -- Entitlement first, and it is absolute: no client switch can turn on a
    -- module the operator has not granted.
    (p_module = ANY(o.enabled_modules))
    AND COALESCE(
      (SELECT f.enabled FROM org_feature_settings f
        WHERE f.org_id = p_org_id AND f.feature_key = p_feature),
      p_default)
    FROM organizations o
   WHERE o.id = p_org_id;
$fn$ LANGUAGE sql STABLE;

REVOKE ALL ON FUNCTION org_feature_enabled(uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_feature_enabled(uuid, text, text, boolean) TO aura_app;
