-- 0020_funnel_submissions.sql — the acquisition funnel's storage (doc 16 §3.1).
--
-- ── Why this is not in `public`, and not called `leads` ──────────────────────
-- `public.leads` already exists and means something entirely different: one row
-- per qualified extraction from an ANALYZED CALL, RLS-scoped by org_id, deduped
-- on contact_number_hash within a workspace, written by
-- apps/worker/src/pipeline/leads.ts. It is a core product object owned by a
-- tenant.
--
-- What this migration stores is an INBOUND MARKETING ENQUIRY from a stranger:
-- no org, no workspace, no call, no tenant. Same English word, unrelated object
-- (doc 16 §0.1). Reusing the name would guarantee permanent confusion in every
-- query, every console screen and every future conversation, so the table is
-- `funnel_submissions` and it lives in its own schema.
--
-- The schema separation is load-bearing, not tidiness. packages/db/verify-rls.js
-- enumerates every BASE TABLE in `public` and fails the run unless each one
-- either carries an org_id with a FORCED org_isolation policy or appears on a
-- hand-reviewed non-tenant allowlist. A tenant-less table in `public` would
-- force one of two bad outcomes: invent a fake org_id (and lie in the tenancy
-- model), or widen that allowlist (and weaken the single invariant that proves
-- tenants cannot see each other). Putting it in `marketing` means the sweep does
-- not see it at all, the grants are separate, and the invariant is untouched.
-- verify-rls.js gets a comment recording that this schema was reviewed and why —
-- see NON_TENANT_TABLES there.
--
-- One database, one backup, one connection story; two blast radii.
--
-- ── Transaction semantics ───────────────────────────────────────────────────
-- packages/db/migrate.js:37-40 wraps this whole file in BEGIN / <file> / COMMIT
-- and ROLLBACKs on the first error, so every statement below must be legal
-- inside a transaction block (no CREATE INDEX CONCURRENTLY, no CREATE DATABASE)
-- and the file either applies completely or not at all. Everything here is
-- IF NOT EXISTS / guarded, so re-running after a failure is safe.

------------------------------------------------------------------------------
-- Schema
------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS marketing;

------------------------------------------------------------------------------
-- Runtime role
--
-- apps/marketing is a PUBLIC, UNAUTHENTICATED web server. It must not hold
-- aura_app's credentials: aura_app reaches every tenant table in `public`, and
-- its isolation depends on the caller setting app.org_id correctly on every
-- transaction — a discipline that exists in apps/api and apps/worker and has no
-- reason to exist in a marketing site. A server-action bug or an SQL injection
-- in the funnel would then be a cross-tenant data breach rather than a marketing
-- database problem.
--
-- So: a second login role, granted USAGE on `marketing` and nothing else. It is
-- deliberately NOT granted USAGE on `public`, so `SELECT * FROM users` from the
-- funnel's connection is a permission error rather than a dump.
--
-- Dev password only, exactly as 0001 does for aura_app. Production rotates it
-- with the existing bootstrapper, which already parameterises the role name:
--   DATABASE_URL=<owner> APP_DB_ROLE=aura_marketing APP_DB_PASSWORD=<secret> \
--     node packages/db/bootstrap-role.js
------------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_marketing') THEN
    CREATE ROLE aura_marketing LOGIN PASSWORD 'aura_marketing_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing.funnel_submissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  email             text NOT NULL,
  -- lower(trim(email)). Stored rather than expression-indexed so the dedupe
  -- lookup, the unique index and the application all agree on one definition of
  -- "the same email" — see packages/shared/src/funnel.ts normalizeEmail().
  email_normalized  text NOT NULL,
  phone_e164        text NOT NULL,
  -- Stored separately even when identical to phone_e164: a fair number of Indian
  -- SMB owners run WhatsApp on a second handset, and collapsing the two loses
  -- the only channel that actually gets read.
  whatsapp_e164     text,
  country_code      text NOT NULL,
  business_type     text,
  team_size         text,
  budget_inr        text,
  intent            text,
  has_crm           text CHECK (has_crm IN ('yes','spreadsheets_whatsapp','no')),
  crm_name          text,                    -- free text when has_crm = 'yes'
  wants_custom_crm  text CHECK (wants_custom_crm IN ('yes','no','tell_me_more')),
  status            text NOT NULL DEFAULT 'contact_captured'
                    CHECK (status IN ('contact_captured','qualified','disqualified')),
  variant           text NOT NULL            -- §3.5
                    CHECK (variant IN ('demo_first','form_first')),
  -- The consent EVIDENCE (§0.3). Not a boolean: under the DPDP Act and the GDPR
  -- what has to be reproducible two years later is the exact wording the person
  -- was shown and when they ticked it, not the fact that some box was ticked.
  -- The wording is versioned in apps/marketing/lib/funnel/consent.ts; this
  -- column stores the literal string, so editing that file never rewrites
  -- history.
  consent_text      text NOT NULL,
  consent_at        timestamptz NOT NULL,
  utm               jsonb NOT NULL DEFAULT '{}',
  calendar_event_id text,
  booking_slot      timestamptz,
  contact_attempts  integer NOT NULL DEFAULT 1,
  last_contacted_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),

  -- ── Two derived columns, computed at write time ──────────────────────────
  -- Not in §3.1's SQL block, but required by §3.7 and §3.2, which both say the
  -- lead LIST has to show these. Deriving them at read time means every future
  -- reader re-implements the connector catalogue and the routing rule, and the
  -- first one to forget shows a salesperson a promise the product cannot keep.
  --
  -- §3.7: a named CRM that is IN the catalogue means onboarding is a connector
  -- config the call can promise; one that is not means a custom connector build
  -- and a different quote. Four catalogue entries (Zoho, Salesforce, monday,
  -- Dynamics 365) authenticate today with pasted tokens that expire in hours
  -- and have no OAuth refresh flow (DEPLOYMENT.md §7.8), so they are their own
  -- value — the call has to be set up honestly.
  crm_connector_status text
                    CHECK (crm_connector_status IN
                      ('catalogue','catalogue_oauth_pending','custom_build','none')),
  -- §3.2: wants_custom_crm = 'tell_me_more' takes the disqualified path (it
  -- books no slot — an information request is not a buying signal) but must be
  -- FLAGGED so a human triages it and the follow-up answers the question
  -- instead of pushing a call. Without this column that distinction is lost the
  -- moment the row is written.
  route_to_human    boolean NOT NULL DEFAULT false
);

-- Append-only journal of every repeat fill. §3.1/dedupe: a returning person does
-- not create a second row — their new answers land here, because business type,
-- budget and intent genuinely change between fills and overwriting them destroys
-- the only signal that says so.
CREATE TABLE IF NOT EXISTS marketing.funnel_contact_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES marketing.funnel_submissions(id) ON DELETE CASCADE,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  business_type  text, team_size text, budget_inr text, intent text,
  has_crm        text, crm_name text, wants_custom_crm text,
  variant        text, utm jsonb NOT NULL DEFAULT '{}',

  -- Not in §3.1's block. This is where the phone-vs-email identity conflict is
  -- recorded (§3.1's closing note): a submission whose EMAIL matches row A and
  -- whose PHONE matches row B attaches to the phone row, and the email it
  -- arrived with is written here so the collision is visible rather than
  -- silently discarded. Also carries the email/phone actually typed on a repeat
  -- fill, which is how "same person, new work address" stays reconstructable.
  submitted_email  text,
  submitted_phone  text,
  -- 'new' | 'phone' | 'email' | 'phone_over_email' — which key matched, so the
  -- dedupe rule's behaviour on live traffic is measurable instead of assumed.
  match_reason     text
);

-- ── Dedupe keys (§3.1) ──────────────────────────────────────────────────────
-- Both UNIQUE, deliberately. They are what makes "one row per person" a database
-- guarantee rather than an application convention, and they are also what
-- creates the conflict case: an insert can violate either one independently, so
-- the write path resolves the match BEFORE inserting and treats a violation here
-- as a lost race to be retried, never as a 500.
CREATE UNIQUE INDEX IF NOT EXISTS funnel_email_uniq
  ON marketing.funnel_submissions (email_normalized);
CREATE UNIQUE INDEX IF NOT EXISTS funnel_phone_uniq
  ON marketing.funnel_submissions (phone_e164);
CREATE INDEX IF NOT EXISTS funnel_created
  ON marketing.funnel_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS funnel_history_submission
  ON marketing.funnel_contact_history (submission_id, occurred_at DESC);

------------------------------------------------------------------------------
-- Rate limiting (§3.3)
--
-- A public, unauthenticated form that writes to the database. Per-IP and
-- per-identity limits are not optional, and they need somewhere durable to
-- count: an in-process Map resets on every deploy and does not exist at all
-- across two Node instances behind nginx.
--
-- The key is a SALTED HASH, never a raw IP or a raw phone number. This table
-- would otherwise become a second, unregulated copy of the personal data the
-- submissions table is careful about — and an IP address is personal data under
-- both the GDPR and the DPDP Act. The salt lives in the application
-- (FUNNEL_HASH_SALT), so a database dump alone does not reverse a /32.
--
-- `window_start` is bucketed by the application; rows older than the widest
-- window are disposable. There is no sweeper yet — the volume this form will see
-- makes that a later problem, and the index below keeps the lookup cheap
-- regardless.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing.funnel_rate_limit (
  bucket_key   text        NOT NULL,   -- 'ip:<hash>' | 'identity:<hash>'
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS funnel_rate_limit_window
  ON marketing.funnel_rate_limit (window_start);

------------------------------------------------------------------------------
-- Grants
--
-- No RLS here, and that is the correct answer rather than an omission: RLS in
-- this codebase means org_isolation keyed on current_setting('app.org_id'), and
-- there is no org. The boundary is the schema plus the role — aura_marketing can
-- reach these three tables and nothing else in the database.
------------------------------------------------------------------------------

REVOKE ALL ON SCHEMA marketing FROM PUBLIC;

GRANT USAGE ON SCHEMA marketing TO aura_marketing;
GRANT SELECT, INSERT, UPDATE ON marketing.funnel_submissions      TO aura_marketing;
GRANT SELECT, INSERT         ON marketing.funnel_contact_history  TO aura_marketing;
GRANT SELECT, INSERT, UPDATE ON marketing.funnel_rate_limit       TO aura_marketing;

-- No DELETE anywhere, on purpose. Nothing in the funnel's write path deletes a
-- row: dedupe UPDATEs, history APPENDs, and rate limiting UPSERTs. A public web
-- server that can delete its own audit trail is a public web server whose audit
-- trail proves nothing — and an erasure request is a deliberate, owner-run
-- operation, not something the form should be able to do by accident.

-- The console (aura_app) is NOT granted anything here. Reading funnel
-- submissions is an owner/operator concern that will arrive with its own
-- surface; until it does, no grant.

-- Supabase's PostgREST roles must never see this schema. 0007 revoked their
-- access to `public` and set default privileges for FUTURE public tables, but
-- neither covers a schema created three years of migrations later — and unlike
-- `public`, this one holds nothing but pre-customer personal data (name, phone,
-- WhatsApp, email, budget) reachable with the project's public anon key if the
-- grant were ever inherited.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA marketing FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA marketing FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SCHEMA marketing FROM %I', api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA marketing REVOKE ALL ON TABLES FROM %I',
        current_user, api_role);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA marketing REVOKE ALL ON SEQUENCES FROM %I',
        current_user, api_role);
    END IF;
  END LOOP;
END $$;

-- A table added to this schema by a later migration inherits the funnel role's
-- access, so the funnel keeps working without an edit here. It does NOT inherit
-- anything for the API roles — the ALTER DEFAULT PRIVILEGES above sees to that.
ALTER DEFAULT PRIVILEGES IN SCHEMA marketing
  GRANT SELECT, INSERT, UPDATE ON TABLES TO aura_marketing;
