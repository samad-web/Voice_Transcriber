------------------------------------------------------------------------------
-- 0184_feature_gates.sql - a GENERIC feature gate with scopes, modes and
-- capabilities (Build docs/transcript-agent-build-plan.md §3A, M1a).
--
-- ── WHY THIS IS NOT `org_feature_settings` ─────────────────────────────────
--
-- 0101 gave every tenant a switchboard: one boolean per feature, per org. Its
-- whole design rests on that shape - `resolveFeatures` takes a module list and
-- a sparse override map and returns on/off/unavailable/blocked, and a row in
-- `org_feature_settings` means "this business made a decision".
--
-- §3A needs four things a boolean cannot express:
--
--   · FIVE scopes. platform -> plan -> org -> team/role -> user.
--   · A MODE. `shadow` analyses and never acts; `suggest` puts every action in
--     front of a person; `assisted` does the internal work; `auto` acts.
--   · CAPABILITIES. An owner may want summaries and call-backs and
--     categorically not customer messaging.
--   · A CEILING. A user setting may never exceed the org's maximum, and an
--     explicit OFF at any broader scope always wins.
--
-- Widening `org_feature_settings.enabled` into that shape would change the
-- meaning of all 42 existing rows on deploy day. So this is a second, narrower
-- mechanism that sits BELOW the switchboard: the switchboard and the module
-- behind it are the plan ceiling this consults, and
-- `packages/shared/src/feature-gates.ts` is the one resolver both halves share.
--
-- ── WHAT IS DELIBERATELY NOT A TABLE HERE ──────────────────────────────────
--
-- 1. `feature_definition` (§15). The catalogue is `GATED_FEATURES` in
--    TypeScript, for the reason `features.ts`'s header argues at length: the
--    API gates a request with it, the web tier draws a screen from it, and the
--    worker decides whether to spend money on a provider call with it. Those
--    three answers drifting apart is how a page renders a link the API
--    refuses. One exported table, three importers, no fourth copy in a CHECK
--    that fails at write time in production.
--
-- 2. THE PLATFORM KILL SWITCH. §3A.1 step 1. It is the `FEATURE_GATE_KILL_
--    SWITCH` environment variable, not a row, because a platform-wide kill
--    switch has to work when the database is the thing that is wrong - and
--    because `packages/db/verify-rls.js` fails the build for any public table
--    with no `org_id`. That allowlist is short on purpose and a kill switch
--    does not earn an entry.
--
-- 3. THE PLAN. `organizations.enabled_modules` (0072) already is it: the
--    resolved entitlement, and already the ceiling a client switch cannot
--    widen. A second entitlement store would be a fourth copy of one answer.
--
-- ── THE SUBJECT IS A USER **OR** A TELECALLER, AND THAT IS THE ONE PLACE
--    THIS PLATFORM AND §3A GENUINELY DISAGREE ──────────────────────────────
--
-- §3A.3 keys the processing gate on "the telecaller who handled the call" and
-- assumes that is a user. Here it often is not: `telecallers.user_id` has been
-- nullable since 0017 because most telecallers carry a paired handset and have
-- never signed in to anything. Lead routing already skips them for exactly
-- this reason.
--
-- A gate keyed only on `users` would therefore silently refuse to process the
-- calls of the majority of a floor - the most expensive possible failure,
-- because it looks like the feature working. So `scope_type = 'user'` may point
-- at either, which is why `scope_id` is a bare uuid with no FK and a
-- `scope_kind` beside it rather than two nullable foreign keys.
------------------------------------------------------------------------------

-- ── feature_settings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The catalogue key. NO CHECK on the value, and that is the same decision
  -- 0101 records for `org_feature_settings.feature_key`: a CHECK listing the
  -- keys is a copy of the TypeScript catalogue that fails at INSERT time on a
  -- production tenant the first time the two drift. The resolver ignores a key
  -- it does not recognise, which is what lets a feature be REMOVED from the
  -- catalogue without stranding rows here.
  feature_key text NOT NULL CHECK (feature_key ~ '^[a-z][a-z0-9_]{2,63}$'),

  scope_type  text NOT NULL CHECK (scope_type IN ('org', 'team', 'role', 'user')),
  -- NULL only for `org` - the org is the row's own `org_id`. Enforced below.
  scope_id    uuid,
  -- Which table `scope_id` points at when `scope_type = 'user'`. See the
  -- header: a handset-only telecaller has no `users` row to point at.
  scope_kind  text CHECK (scope_kind IN ('user', 'telecaller', 'team')),
  -- `role` scopes carry a persona name rather than an id (`memberships.
  -- owner_role`), which is text and not a uuid - so it lives here.
  scope_role  text,

  state       text NOT NULL CHECK (state IN ('on', 'off', 'inherit')),

  -- For an `org` row this is the MAXIMUM mode; for the narrower scopes it is
  -- the mode asked for, and the resolver takes the lower of the two. NULL
  -- means "whatever is inherited".
  mode        text CHECK (mode IN ('off', 'shadow', 'suggest', 'assisted', 'auto')),

  -- A JSON ARRAY of capability keys, not a set of boolean columns. §3A.2's
  -- list will grow (`live_assist` is M12 and already catalogued), and a column
  -- per capability is a migration per capability on a table every gated
  -- request reads. NULL = inherited.
  capabilities jsonb CHECK (capabilities IS NULL OR jsonb_typeof(capabilities) = 'array'),

  -- §3A.5's scheduled changes: "support effective_from and effective_to (for
  -- example a trial for 14 days that ends automatically)".
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,

  set_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- An `org` row has no scope_id; everything narrower must have one of the two
  -- ways of naming its subject. A `role` row names a persona in `scope_role`.
  CONSTRAINT feature_settings_scope_shape CHECK (
    (scope_type = 'org'  AND scope_id IS NULL AND scope_role IS NULL) OR
    (scope_type = 'role' AND scope_id IS NULL AND scope_role IS NOT NULL) OR
    (scope_type IN ('team', 'user') AND scope_id IS NOT NULL)
  ),
  CONSTRAINT feature_settings_window CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- ── ONE ROW PER (feature, scope) **IN FORCE**, and three indexes to say it ──
--
-- A partial unique index per scope shape rather than one over COALESCEd
-- columns: `COALESCE(scope_id, '00000000-…')` works and makes the index
-- unusable for the lookup the resolver actually does, which is "every row for
-- this feature and org" - and that read happens on every gated request against
-- a database ~125ms away.
--
-- OPEN rows only (`effective_to IS NULL`). A closed row is history: a 14-day
-- trial that ended leaves its row behind so the audit can say what was true in
-- March, and a second open row for the same scope is the ambiguity worth
-- refusing. Same shape as 0177's "at most one OPEN solid reporting line", and
-- for the same reason: the full statement needs an exclusion constraint over a
-- tstzrange, which needs btree_gist, which 0042 records this platform cannot
-- assume `CREATE EXTENSION` for on a hosted Postgres.
CREATE UNIQUE INDEX IF NOT EXISTS feature_settings_org_scope
  ON feature_settings (org_id, feature_key)
  WHERE scope_type = 'org' AND effective_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feature_settings_role_scope
  ON feature_settings (org_id, feature_key, scope_role)
  WHERE scope_type = 'role' AND effective_to IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feature_settings_id_scope
  ON feature_settings (org_id, feature_key, scope_type, scope_id)
  WHERE scope_type IN ('team', 'user') AND effective_to IS NULL;

-- The resolver's own read: every row for one feature in one org, in one scan.
CREATE INDEX IF NOT EXISTS feature_settings_lookup
  ON feature_settings (org_id, feature_key, effective_from DESC);

ALTER TABLE feature_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_settings FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON feature_settings
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_settings TO aura_app;

-- ── feature_usage (§3A.7) ──────────────────────────────────────────────────
--
-- Metered per user and per org. `period` is a `YYYY-MM` string rather than a
-- date: §3A.7 wants a monthly figure beside a cap, every read is "this
-- month's", and a month is not a point in time. Same convention
-- `finance_periods` uses.
CREATE TABLE IF NOT EXISTS feature_usage (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  -- NULL = the org's own total, which is the row the cap is checked against
  -- when the limit is org-wide. A per-user row carries the subject.
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  telecaller_id  uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  period      text NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),

  transcripts     integer NOT NULL DEFAULT 0 CHECK (transcripts >= 0),
  -- Minutes, rounded up per call. Integer because that is what the invoice
  -- line is, and `usage_events` already records ASR minutes the same way.
  audio_minutes   integer NOT NULL DEFAULT 0 CHECK (audio_minutes >= 0),
  -- PAISE. The only minor-unit column in this wave, and deliberately so: it is
  -- a model-provider charge, it is never compared against an invoice total,
  -- and `TRANSCRIPT_AGENT_DECISIONS.md` §4.1 records why every OTHER money
  -- column here is numeric.
  model_cost_minor bigint NOT NULL DEFAULT 0 CHECK (model_cost_minor >= 0),

  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, feature_key, period, user_id, telecaller_id)
);

-- A composite primary key with two NULLABLE columns does not do what it looks
-- like it does: in Postgres, NULL is distinct from NULL for uniqueness, so
-- `(org, feature, period, NULL, NULL)` can be inserted twice. The org's own
-- total needs exactly one row, so it gets its own partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS feature_usage_org_total
  ON feature_usage (org_id, feature_key, period)
  WHERE user_id IS NULL AND telecaller_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feature_usage_user_total
  ON feature_usage (org_id, feature_key, period, user_id)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feature_usage_telecaller_total
  ON feature_usage (org_id, feature_key, period, telecaller_id)
  WHERE telecaller_id IS NOT NULL AND user_id IS NULL;

ALTER TABLE feature_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_usage FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON feature_usage
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_usage TO aura_app;

-- ── feature_limits (§3A.7) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_limits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  scope_type  text NOT NULL CHECK (scope_type IN ('org', 'team', 'user')),
  scope_id    uuid,
  metric      text NOT NULL CHECK (metric IN ('transcripts', 'audio_minutes', 'model_cost_minor')),
  -- NULL = no warning / no stop. §3A.7's default is NO CAP, which is why both
  -- are nullable rather than defaulting to a number somebody did not choose.
  soft_limit  bigint CHECK (soft_limit IS NULL OR soft_limit >= 0),
  hard_limit  bigint CHECK (hard_limit IS NULL OR hard_limit >= 0),
  -- Which threshold has already been alerted on, so the sweep warns once per
  -- period rather than every tick. Same mechanism as `storage_quota`'s.
  alerted_state text CHECK (alerted_state IN ('warn', 'hard')),
  alerted_period text CHECK (alerted_period IS NULL OR alerted_period ~ '^\d{4}-\d{2}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_limits_order CHECK (
    soft_limit IS NULL OR hard_limit IS NULL OR soft_limit <= hard_limit
  ),
  CONSTRAINT feature_limits_scope CHECK (
    (scope_type = 'org' AND scope_id IS NULL) OR (scope_type <> 'org' AND scope_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS feature_limits_org_metric
  ON feature_limits (org_id, feature_key, metric) WHERE scope_type = 'org';
CREATE UNIQUE INDEX IF NOT EXISTS feature_limits_scoped_metric
  ON feature_limits (org_id, feature_key, scope_type, scope_id, metric)
  WHERE scope_type <> 'org';

ALTER TABLE feature_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_limits FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON feature_limits
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON feature_limits TO aura_app;

-- ── feature_consents (§3A.5) ───────────────────────────────────────────────
--
-- "First enablement shows the owner a consent and notice acknowledgement (call
-- recording and transcription, customer data processing, message consent),
-- stored with who and when."
--
-- APPEND-ONLY, and a GRANT alone does not achieve that - 0177's
-- `org_change_log` header records the proof. 0001 runs `ALTER DEFAULT
-- PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aura_app`, so
-- a narrower GRANT here is a no-op on top of something wider. The REVOKE is
-- what does it.
CREATE TABLE IF NOT EXISTS feature_consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  -- The person who clicked. Nullable because the operator console can enable a
  -- feature with an admin key and has no `users` row; the audit row carries the
  -- actor in that case, exactly as 0166's `attended_by` does.
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_by_label text,
  -- Bumped when the notice TEXT changes, so every org acknowledges again
  -- rather than a new notice being retroactively consented to.
  notice_version text NOT NULL,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feature_consents_org
  ON feature_consents (org_id, feature_key, created_at DESC);

ALTER TABLE feature_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_consents FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON feature_consents
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
REVOKE ALL ON feature_consents FROM aura_app;
GRANT SELECT, INSERT ON feature_consents TO aura_app;

-- ── feature_audit (§3A.6's audit tab) ──────────────────────────────────────
--
-- "Who changed what, when, from what to what, with the reason."
--
-- SEPARATE from `audit_log`, and the reason is the question each answers.
-- `audit_log` is a flat stream of actions for an org, read chronologically;
-- this is a per-feature, per-scope history read as "what has happened to
-- Priya's setting" - which is a filter on two columns `audit_log` does not
-- have. The writes go to both: the generic trail keeps the governance view,
-- this keeps the screen.
--
-- Append-only, same REVOKE-then-GRANT as above.
CREATE TABLE IF NOT EXISTS feature_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  -- 'user' | 'operator' | 'system', matching `audit_log.actor_type` and
  -- `common/audit-actor.ts`, so a vendor-side edit is not filed as a tenant
  -- user called "admin-key" (doc 31 §2 X9).
  actor_type  text NOT NULL DEFAULT 'user',
  scope_type  text NOT NULL,
  scope_id    uuid,
  scope_role  text,
  event       text NOT NULL,
  before      jsonb,
  after       jsonb,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feature_audit_org_time
  ON feature_audit (org_id, feature_key, created_at DESC);
CREATE INDEX IF NOT EXISTS feature_audit_scope
  ON feature_audit (org_id, feature_key, scope_type, scope_id, created_at DESC);

ALTER TABLE feature_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_audit FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON feature_audit
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
REVOKE ALL ON feature_audit FROM aura_app;
GRANT SELECT, INSERT ON feature_audit TO aura_app;

-- ── THE SECOND RLS AXIS: the partner wall (0163) ───────────────────────────
--
-- `org_isolation` keeps one tenant out of another's data. It does NOT keep a
-- CHANNEL PARTNER out of the tenant that invited them: a partner principal
-- runs inside `withPartnerContext`, which sets `app.org_id` to the tenant's own
-- id, so every permissive org policy admits them. The second axis is a
-- RESTRICTIVE policy that denies any row whenever `app.partner_id` is set.
--
-- 0163's own header predicted this exact gap - "until that lands, a new tenant
-- table is unwalled" - and `verify-rls.js` is the check that found it: the
-- first run of this wave failed with all 22 of these tables named. That is the
-- gate working, and the fix belongs in the migration that creates the table
-- rather than in a future sweep that would be forgotten.
--
-- Nothing here is ever partner-visible. A partner has no business reading which
-- features a tenant has switched on, let alone a transcript.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['feature_settings', 'feature_usage', 'feature_limits',
                           'feature_consents', 'feature_audit'] LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $do$;

-- Prove it, and prove it is RESTRICTIVE. A `partner_wall` created as
-- PERMISSIVE ORs with `org_isolation`, admits every row it was meant to deny,
-- and reads in `pg_policies` exactly like the thing that was supposed to be
-- there - 0163's §5 records that as the one failure mode here that changes
-- nothing visible and removes the whole boundary.
DO $do$
DECLARE t text; missing text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['feature_settings', 'feature_usage', 'feature_limits',
                           'feature_consents', 'feature_audit'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND policyname = 'partner_wall' AND permissive = 'RESTRICTIVE'
    ) THEN
      missing := missing || ' ' || t;
    END IF;
  END LOOP;
  IF missing <> '' THEN
    RAISE EXCEPTION '0184: partner_wall missing or not RESTRICTIVE on:%', missing;
  END IF;
END $do$;

-- ── The Supabase API roles hold nothing here ───────────────────────────────
--
-- REVOKE and not "do not GRANT", for the reason the marketing-schema trap
-- records: 0001's ALTER DEFAULT PRIVILEGES means a table arrives already
-- granted, so a GRANT-only migration narrows nothing. Every table in this file
-- is reachable only through the API's own `aura_app` role.
DO $do$
DECLARE api_role text; t text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN CONTINUE; END IF;
    FOREACH t IN ARRAY ARRAY['feature_settings', 'feature_usage', 'feature_limits',
                             'feature_consents', 'feature_audit'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
    END LOOP;
  END LOOP;
END $do$;

------------------------------------------------------------------------------
-- NOTHING IS SEEDED, AND THAT IS §18's DEFAULT
--
-- "Feature default: OFF for the org and for every user until the owner enables
-- it." An org with no rows in `feature_settings` resolves to OFF for everybody,
-- which is what `resolveGate` step 3 does with an absent org row - so the
-- correct seed is no seed at all, and a deploy of this file changes nothing
-- any tenant can see.
--
-- It also means the first thing the admin screen writes is the org row, and the
-- consent acknowledgement is required before it (§3A.5). Both are the API's
-- job; this file deliberately leaves no state that could be read as consent.
------------------------------------------------------------------------------

DO $do$
BEGIN
  RAISE NOTICE '0184: feature gate ready - scopes, modes, capabilities, caps, consent and audit. Nothing enabled.';
END $do$;
