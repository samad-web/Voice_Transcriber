-- 0157_dialable_numbers_vault.sql - the one place a callable number may live
-- (Build docs/39, §1-§3).
--
-- ── WHY THIS TABLE HAS TO EXIST, AND WHY IT IS NOT A COLUMN ─────────────────
--
-- This platform cannot dial anything today, and that was a decision rather than
-- an omission: 0006 took the full counterparty number out of the schema, and
-- what is left is deliberately undialable - `leads.contact_number_hash` plus a
-- prefix and the last three, `contacts.phone_hash` the same, and
-- `calls.remote_number_full` only for a tenant who opted in under 0011 (default
-- false) and stripped to `undefined` before any route serves it.
--
-- A dialer needs a number store, so building one reverses that decision. The
-- reversal is therefore SCOPED, OPT-IN, CONSENT-TYPED AND AUDITED instead of
-- implicit, and it lands in a table of its own.
--
-- The obvious alternative - `contacts.phone_full` - was rejected, and not on
-- taste. `contacts` is read by the list, the board, the drawer, every export,
-- the Report Builder and the MCP server, so a column there is a column in all
-- of them and the first `SELECT *` puts customer phone numbers in a CSV. A
-- separate table with its own grants is the shape 0122 used to put call content
-- behind a gate, for the same reason.
--
-- ── NOTHING IS WRITTEN WHILE 0011'S SWITCH IS OFF ───────────────────────────
--
-- `organizations.store_full_number` already means "this tenant may keep
-- callable numbers". There is deliberately NO second privacy axis beside it:
-- the vault writes nothing while it is false, so every existing tenant is
-- bit-for-bit unaffected until an operator turns it on. That is 0011's contract
-- and it still holds after this migration. The backfill at the end of this file
-- honours it too - it seeds only orgs already switched on.
--
-- ── WHO MAY READ A NUMBER ───────────────────────────────────────────────────
--
-- Only two routes in the whole API may ever serve `e164`: the console's
-- `GET /numbers/:key/reveal` and the handset's `GET /device/dialer/next`. A
-- human revealing a number is a DISCLOSURE and writes an `auth_events` row
-- (0127 - reuse it, do not invent a second audit table). A queue push to a
-- handset is not separately audited, because the dial attempt is itself a
-- durable record.
--
-- ── WHAT THIS TABLE DELIBERATELY LACKS ─────────────────────────────────────
--
-- No `lead_id` and no `contact_id`. The number key already joins to both, and
-- an FK would force a second row the moment one number sits on two leads in two
-- workspaces.
--
-- No soft delete. A number is removed with `DELETE`, because "we deleted their
-- number but kept it" must not be a sentence anybody can say about this table.
-- That is also why the GRANT below includes DELETE and `messaging_opt_outs`
-- (0111) does not: there, the record of the request is the point; here, the
-- absence of the number is.

-- ── contact_numbers ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contact_numbers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The join key, NOT the identity. Same value as leads.contact_number_key
  -- (0146) and calls.remote_number_key (0133): sha256(phoneMatchDigits(n)), the
  -- last ten digits. A row here is therefore reachable from a lead, a contact or
  -- a call without any of them storing a number themselves.
  number_key  text NOT NULL,

  -- The payload. E.164, validated by libphonenumber through
  -- @aura/shared/dist/phone - the same helper PhoneInput uses - so a number
  -- that cannot be dialled is never stored in the first place.
  e164        text NOT NULL,
  country     text,

  source      text NOT NULL CHECK (source IN
                ('call','web_form','import','manual','meta_ads',
                 'linkedin_ads','api','partner','card_scan')),

  -- WHY we may ring it. This column is what makes the table defensible, and it
  -- is an ordered scale even though the database does not know that:
  --   customer_initiated  they rang us, or submitted a form. Strongest.
  --   consent_given       a form with a ticked, logged consent box.
  --   existing_relation   an imported customer list the tenant asserts.
  --   unknown             imported with no basis stated. Dialable ONLY if the
  --                       org has explicitly accepted that risk (below).
  --
  -- The ordering lives in the service in @aura/shared, not in a CHECK, because
  -- "stronger" is a product judgement the database should not need to hold -
  -- and because the upsert PROMOTES and never demotes: a number that arrived by
  -- import as `unknown` and later by web form becomes `consent_given`, and the
  -- reverse never happens.
  consent_basis text NOT NULL CHECK (consent_basis IN
                ('customer_initiated','consent_given','existing_relation','unknown')),

  -- Evidence for a basis that has any: form id + submission id + the consent
  -- text AS RENDERED AT THE TIME, or the import job id and filename. Storing the
  -- rendered text matters - a tenant who later edits their consent wording must
  -- not retroactively change what an existing customer agreed to.
  consent_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent_at       timestamptz,

  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per number per tenant, which is what makes the promoting upsert an
-- `ON CONFLICT` rather than a read-modify-write with a race in it.
CREATE UNIQUE INDEX IF NOT EXISTS contact_numbers_org_key
  ON contact_numbers (org_id, number_key);

COMMENT ON TABLE contact_numbers IS
  'The only place a dialable customer number lives (doc 39 §2). Written only for orgs with '
  'store_full_number = true; served by exactly two API routes. Keyed on number_key so leads, '
  'contacts and calls reach it without storing a number themselves.';
COMMENT ON COLUMN contact_numbers.consent_basis IS
  'Why we may ring it, strongest first: customer_initiated > consent_given > existing_relation '
  '> unknown. An ordered scale the database does not enforce - the promoting upsert in '
  '@aura/shared owns the ordering. `unknown` is dialable only under '
  'organizations.dialer_allows_unknown_consent.';
COMMENT ON COLUMN contact_numbers.consent_evidence IS
  'The proof, frozen: form + submission id + the consent text AS RENDERED THEN, or the import '
  'job and filename. Never re-derived, so editing the wording cannot change what somebody agreed to.';

-- `updated_at` is load-bearing here rather than decorative: the promoting upsert
-- is how a basis strengthens, and "when did this number last gain a stronger
-- basis" is the question an auditor asks. A trigger rather than trusting every
-- future caller to remember.
DO $$ BEGIN
  CREATE TRIGGER contact_numbers_set_updated_at BEFORE UPDATE ON contact_numbers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Row-level security and grants - the tenant pattern ──────────────────────
--
-- Org-scoped, so the standard policy applies and verify-rls.js needs no
-- allowlist entry. REVOKE before GRANT: a GRANT-only migration in a database
-- the Supabase API roles can already reach narrows nothing - see 0075, 0081,
-- 0089, 0145 and the marketing-schema trap on exactly this.

ALTER TABLE contact_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_numbers FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON contact_numbers
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON contact_numbers FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON contact_numbers FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_numbers TO aura_app;

-- ── The second switch: may `unknown` ever be dialled ────────────────────────
--
-- Not a privacy axis - 0011 is the only one of those. This is the tenant
-- accepting a RISK: a number imported with no stated basis is excluded from
-- every queue unless this is on. An OWNER turns it on themselves at
-- /owner/settings, behind copy that states plainly what they are asserting, and
-- the flag is then the audit trail for a decision that is theirs to make.
--
-- Default false, so turning on 0011's switch alone changes nothing about who
-- can be rung.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS dialer_allows_unknown_consent boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.dialer_allows_unknown_consent IS
  'Owner-set risk acceptance (doc 39 §3): when true, contact_numbers rows with '
  'consent_basis = ''unknown'' may enter a dial queue. Default false excludes them everywhere. '
  'Not a privacy switch - organizations.store_full_number (0011) is the only one of those.';

-- ── The calling window: the hours a tenant may ring somebody ────────────────
--
-- `dialability()` returns `quiet_hours` outside this window, and until these two
-- columns existed it had NOTHING TO READ. The plan doc said quiet hours were
-- "resolved in the org's timezone", but `quietHoursFromEnv` in @aura/shared is
-- configured from QUIET_HOURS_START / QUIET_HOURS_END / SCHEDULER_TIMEZONE -
-- DEPLOYMENT-WIDE environment variables. Falling back to those would have given
-- every tenant on this VPS one shared calling window, so a clinic in Kerala and
-- a desk selling into Dubai would have been held by the same clock.
--
-- Hours, not timestamps, and local to the org - an int is what an owner is
-- actually choosing ("we ring between 9 and 9"), and storing an instant would
-- make the question "which day's offset" for no gain.
--
-- ── WHY THE DEFAULT IS 09:00-21:00 AND NOT "NO WINDOW" ──────────────────────
--
-- NULL would mean "ring at any hour", which is the permissive default, and this
-- is the one place in 0157/0158 where the permissive default is the wrong one.
-- India's telemarketing rules put outbound commercial calls inside 09:00-21:00,
-- and 09:00-21:00 is also simply what a person would call a reasonable hour. A
-- tenant who has thought about it can widen or narrow it; a tenant who has not
-- is compliant by accident rather than exposed by accident.
--
-- Nothing dials yet, so this default changes no existing behaviour - which is
-- precisely why it is free to set it correctly now rather than after the first
-- tenant rings somebody at 23:40.
--
-- The ZONE is deliberately not a third column: `organizations.reporting_timezone`
-- already exists and org_reporting_tz() (0132) already resolves it with an
-- 'Asia/Kolkata' fallback. A calling window in a different zone from the
-- tenant's own reports would be a bug nobody would find.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS calling_window_start_hour int NOT NULL DEFAULT 9
    CHECK (calling_window_start_hour BETWEEN 0 AND 23),
  -- 24 is legal and means midnight-end-of-day, so a tenant can say 09:00-24:00
  -- without the window wrapping and reading as an overnight shift.
  ADD COLUMN IF NOT EXISTS calling_window_end_hour int NOT NULL DEFAULT 21
    CHECK (calling_window_end_hour BETWEEN 1 AND 24);

COMMENT ON COLUMN organizations.calling_window_start_hour IS
  'Local hour (in organizations.reporting_timezone) from which this tenant may place outbound '
  'calls. Read by dialability() (doc 39 §5); default 09 follows India telemarketing practice.';
COMMENT ON COLUMN organizations.calling_window_end_hour IS
  'Local hour at which this tenant must stop placing outbound calls, exclusive - 21 means the '
  'last call may start at 20:59. 24 means end of day. A start greater than the end is read as '
  'an overnight window by inQuietWindow''s wrapping branch, which is intended for night shifts.';

-- ── The per-person daily ceiling: what `max_attempts` does NOT mean ─────────
--
-- `dial_campaigns.max_attempts` is enforced against `dial_queue_items.attempt_count`,
-- which is keyed (campaign_id, lead_id). So a lead sitting in two campaigns can
-- be rung 2 x max_attempts and dialability() cannot see it - nothing passes the
-- predicate a cross-campaign total. At the default ceiling of 3, two campaigns
-- is six calls to one person and three is nine, and the supervisor who typed 3
-- has no way to know.
--
-- NULL means no cross-campaign ceiling, and that is the DEFAULT - a deliberate
-- product decision (doc 39 §40.10, 2026-10-06), so that no tenant's running
-- floor is silently throttled the day this migration lands. The exposure
-- therefore stays open until somebody sets a number.
--
-- That default is only defensible if the setting is VISIBLE: it must render
-- beside max_attempts wherever a campaign ceiling is edited, so "3" and "and
-- the cross-campaign total is uncapped" are read in the same breath. Moving it
-- to a settings page is a defect, not a layout choice.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS dialer_max_calls_per_person_per_day int
    CHECK (dialer_max_calls_per_person_per_day IS NULL
           OR dialer_max_calls_per_person_per_day BETWEEN 1 AND 50);

COMMENT ON COLUMN organizations.dialer_max_calls_per_person_per_day IS
  'Org-wide ceiling on dial attempts to ONE person per local day, counted across every campaign '
  'and checked by dialability() alongside the per-campaign max_attempts (doc 39 §5, §40.10). '
  'NULL = uncapped, which is the default: campaign ceilings alone let a lead in two campaigns be '
  'rung twice over. Must be shown next to max_attempts in the console, not buried in settings.';

-- ── Backfill: inbound calls only ────────────────────────────────────────────
--
-- For the orgs already on `store_full_number`, seed the vault from the one place
-- a callable number already exists: `calls.remote_number_full`.
--
-- `direction = 'incoming'` ONLY, and this is the whole point of the statement.
-- They rang us, which is the strongest basis there is. An OUTBOUND call proves
-- nothing whatsoever about consent and must not be backfilled as though it did -
-- a vault seeded from outgoing calls would assert `customer_initiated` over
-- numbers the business found somewhere and tried once.
--
-- NOTE: the plan doc writes this predicate as `WHERE direction = 'in'`. There is
-- no such value. `calls.direction` has been CHECK (direction IN ('incoming',
-- 'outgoing')) since 0001_init, so the doc's literal would have matched zero
-- rows and seeded an empty vault silently. The doc's INTENT - inbound only - is
-- what is implemented.
--
-- `number_key` comes from `calls.remote_number_key` (0133) wherever it is
-- present, which after 0133's own backfill is every row that has a full number.
-- The COALESCE fallback is phoneMatchDigits written in SQL, byte-for-byte the
-- CASE 0133 used, so a row that somehow lacks the key still keys IDENTICALLY to
-- the way the application would key it. Inventing a second keying rule here
-- would produce vault rows that no lead, contact or call ever joins to.
--
-- `e164` is the conservative half. libphonenumber is not available inside
-- Postgres, and a bare ten-digit number cannot be turned into E.164 without
-- knowing the country - '+9876543210' would parse as country code 98. So a row
-- is seeded only when the stored number already carries its country code:
-- either the handset reported international form (which 0133's header notes is
-- the usual case for an INCOMING call - exactly the direction being backfilled),
-- or there are more than ten digits and no trunk zero. Everything else is left
-- out rather than guessed at; those numbers are still in `calls` and a later
-- pass through @aura/shared/dist/phone, which can resolve them against the
-- tenant's country, can seed them properly.
--
-- One row per (org_id, number_key) - the unique index above - taking the MOST
-- RECENT inbound call, because consent_at means "when they last rang us" and the
-- freshest contact is the strongest thing to be able to assert.

WITH inbound AS (
  SELECT c.id,
         c.org_id,
         c.started_at,
         c.remote_number_full,
         c.remote_number_key,
         regexp_replace(c.remote_number_full, '\D', '', 'g') AS digits
    FROM calls c
    JOIN organizations o ON o.id = c.org_id AND o.store_full_number
   WHERE c.direction = 'incoming'
     AND c.remote_number_full IS NOT NULL
),
keyed AS (
  SELECT i.id,
         i.org_id,
         i.started_at,
         COALESCE(
           i.remote_number_key,
           CASE WHEN length(i.digits) >= 10
                  THEN encode(sha256(convert_to(right(i.digits, 10), 'UTF8')), 'hex')
                WHEN length(i.digits) >= 6
                  THEN encode(sha256(convert_to(ltrim(i.digits, '0'), 'UTF8')), 'hex')
           END) AS number_key,
         CASE
           WHEN i.remote_number_full LIKE '+%' THEN '+' || i.digits
           WHEN length(i.digits) > 10 AND left(i.digits, 1) <> '0' THEN '+' || i.digits
         END AS e164
    FROM inbound i
   WHERE length(i.digits) >= 6
),
newest AS (
  SELECT DISTINCT ON (k.org_id, k.number_key)
         k.org_id, k.number_key, k.e164, k.id AS call_id, k.started_at
    FROM keyed k
   WHERE k.number_key IS NOT NULL
     -- The shape check the application's validator would apply. Deliberately
     -- here and not as a column CHECK: the doc's DDL has none, and a CHECK this
     -- migration invented could start refusing a form libphonenumber accepts.
     AND k.e164 ~ '^\+[1-9][0-9]{6,14}$'
   ORDER BY k.org_id, k.number_key, k.started_at DESC
)
INSERT INTO contact_numbers
  (org_id, number_key, e164, source, consent_basis, consent_evidence, consent_at)
SELECT n.org_id,
       n.number_key,
       n.e164,
       'call',
       'customer_initiated',
       jsonb_build_object(
         'kind', 'inbound_call',
         'call_id', n.call_id,
         'call_started_at', n.started_at,
         'seeded_by', '0157_dialable_numbers_vault'),
       n.started_at
  FROM newest n
ON CONFLICT (org_id, number_key) DO NOTHING;

-- Say out loud what the backfill did. A silent seed is indistinguishable from a
-- seed that matched nothing, which is the failure the doc's 'in' literal would
-- have caused.
DO $do$
DECLARE seeded int; orgs int;
BEGIN
  SELECT count(*), count(DISTINCT org_id) INTO seeded, orgs
    FROM contact_numbers WHERE source = 'call';
  RAISE NOTICE '0157: vault holds % number(s) from inbound calls across % org(s)', seeded, orgs;
END $do$;
