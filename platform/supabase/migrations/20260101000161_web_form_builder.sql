-- 0161_web_form_builder.sql - the no-code form builder (Build docs/39 §15-§16).
--
-- ── EVERY FORM IS A LEAD SOURCE, AND THAT IS THE WHOLE DESIGN ──────────────
--
-- `source_id` is NOT NULL and NOT optional. A form without a `lead_sources` row
-- cannot exist, which is what makes it impossible for a submission to take any
-- path other than 0078's.
--
-- That matters more than it looks. 0078 got six separate bugs out of the intake
-- path under live traffic - dedupe, routing, source attribution, the
-- `lead_intake_events` ledger, the honeypot, rate limiting and signature
-- checks - and every one of them is a property of the PATH, not of a table. A
-- form builder with its own `INSERT INTO leads` would reacquire all six on day
-- one, and reacquire them invisibly: the leads would still appear, they would
-- simply be attributed to nothing, deduplicate against nothing, and leave no
-- record of the submissions that failed.
--
-- So the submission handler builds a payload, resolves the form's source, and
-- calls the existing `LeadIntakeService`. The only thing this migration adds to
-- that path is a row in the number vault - see below.
--
-- ── AND THAT IS WHY THIS FEEDS THE VAULT ───────────────────────────────────
--
-- 0157 built `contact_numbers` and left it with one writer: an INCOMING call
-- (`noteIncomingCallNumber`). That is the strongest consent basis there is, and
-- it is also the rarest - a tenant who has never been rung by a prospect has an
-- empty vault and a dialer with nothing to dial.
--
-- A submitted web form is the second strongest: the person typed their number
-- into our page, under a consent sentence we can reproduce. §16 therefore makes
-- the submission path upsert the vault with `source = 'web_form'`,
-- `consent_basis = consent_required ? 'consent_given' : 'customer_initiated'`,
-- and the rendered consent text plus the submission id as evidence. The form
-- builder is how a tenant acquires legitimately dialable numbers at volume,
-- which is why doc 39 says W4 is worth more than its position in the sequence.
--
-- The write still honours 0011: nothing enters the vault while
-- `organizations.store_full_number` is false. The handler checks it on the same
-- row it resolves the form from, exactly as the call-upload path does.
--
-- ── TWO DEPARTURES FROM §15's DDL, BOTH ADDITIVE ───────────────────────────
--
-- §15's table is reproduced below unchanged, including `web_forms_org_slug`.
-- Two things are ADDED, and both are load-bearing for §16's own route:
--
--  1. `web_forms_slug_global`, a PLATFORM-WIDE unique index on `slug`.
--
--     §16 hosts the form at `/f/[slug]`. A slug that is unique only within an
--     org cannot resolve a tenant from that URL - there is no org in the path
--     and no session on a public page - so `/f/contact-us` would be ambiguous
--     the moment two tenants both called a form "Contact us". The same
--     bootstrap problem `lead_sources_token` solves the same way, and its
--     header says so: "this index is what makes 'resolve the token, learn the
--     tenant' a single lookup with no org context".
--
--     The cost is a shared namespace, and the API absorbs it rather than
--     passing it on: `webFormSlugify` proposes a slug and the create handler
--     appends a short random suffix until it finds a free one. A tenant
--     therefore never sees "that name is taken", and never learns that another
--     tenant took it - which is the one thing a shared namespace must not
--     disclose.
--
--  2. `web_forms_slug_shape`, a CHECK that a slug really is one URL path
--     segment. §15 types it as bare `text`, and a slug containing a slash or a
--     space is not a validation nicety - it is a published link that 404s, in
--     somebody's printed brochure.
--
-- Neither changes a column, a default or a constraint §15 specifies.

-- ── web_forms ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS web_forms (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Every form IS a lead source, not "can be mapped to one". The submission
  -- path is 0078's intake path, so a form without a source row cannot submit.
  source_id uuid NOT NULL REFERENCES lead_sources(id) ON DELETE CASCADE,

  name      text NOT NULL,
  slug      text NOT NULL,
  definition jsonb NOT NULL DEFAULT '{"fields":[]}'::jsonb,
  -- Per field: where it lands. A lead column, a contact column, or a custom
  -- field id (0037). Validated against the LIVE custom-field set on save, so a
  -- deleted field surfaces as a broken form rather than silent data loss.
  field_map jsonb NOT NULL DEFAULT '{}'::jsonb,

  consent_required boolean NOT NULL DEFAULT true,
  consent_text     text,

  theme     jsonb NOT NULL DEFAULT '{}'::jsonb,
  redirect_url text,
  thank_you_text text,

  status    text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','published','closed')),
  submit_count int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS web_forms_org_slug ON web_forms (org_id, slug);

-- Departure 1. See the header: `/f/<slug>` has no tenant in it.
CREATE UNIQUE INDEX IF NOT EXISTS web_forms_slug_global ON web_forms (slug);

-- Departure 2. One URL path segment: lowercase letters, digits and single
-- hyphens. `WEB_FORM_SLUG_RE` in packages/shared/src/web-forms.ts is the same
-- expression, and web-forms.test.ts pins it - the two must agree or the console
-- offers a slug the database refuses.
DO $$ BEGIN
  ALTER TABLE web_forms ADD CONSTRAINT web_forms_slug_shape
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 60);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One source row serves exactly one form. Without this, two forms could be
-- built on one source and their leads would be indistinguishable in the ledger
-- and in every attribution report - which is the thing `source_id` exists to
-- prevent. The API creates the pair in one transaction, so nothing legitimate
-- ever collides here.
CREATE UNIQUE INDEX IF NOT EXISTS web_forms_source ON web_forms (source_id);

-- The console's list: this tenant's forms, published first, newest first.
CREATE INDEX IF NOT EXISTS web_forms_org_status ON web_forms (org_id, status, created_at DESC);

COMMENT ON TABLE web_forms IS
  'A tenant-built public form (doc 39 §15). Every row has a lead_sources row: the submission '
  'path is 0078''s intake pipeline and a form without a source cannot submit. Hosted at '
  '/f/<slug> on the marketing app, which is why slug is unique PLATFORM-WIDE and not per org.';
COMMENT ON COLUMN web_forms.slug IS
  'The public URL segment. Unique across every tenant - /f/<slug> carries no org, so the slug '
  'is what names one. Allocated with a random suffix on collision so a tenant never learns '
  'that another tenant holds the name they asked for.';
COMMENT ON COLUMN web_forms.definition IS
  'WebFormDefinition (packages/shared/src/web-forms.ts): the ordered fields, their types and '
  'their one-level-deep showIf rules. Authored in the console, rendered on the marketing app '
  'and validated in the API by the SAME parser.';
COMMENT ON COLUMN web_forms.field_map IS
  'Field key -> where the answer lands: {"kind":"intake","field":"phone"} for a lead/contact '
  'column 0078''s WEB_FORM_MAP already reads, or {"kind":"custom","objectType":"contact",'
  '"fieldId":<uuid>} for a 0037 custom field. Re-validated against the LIVE definitions on '
  'every save, so a deleted field is a visibly broken form rather than silent data loss. A '
  'field with no entry here lands on leads.facts, which is where a form''s extra questions '
  'already go today.';
COMMENT ON COLUMN web_forms.consent_required IS
  'Decides the vault basis §16 records: true -> consent_given, false -> customer_initiated. '
  'The sentence in consent_text is stored with the submission AS RENDERED, version-prefixed, '
  'because the evidence somebody consented is the sentence they read and not a boolean.';
COMMENT ON COLUMN web_forms.submit_count IS
  'Counter, not a count(*) over lead_intake_events: that table is prunable and this must '
  'survive it. Same reasoning as lead_sources.event_count (0078).';

-- ── Row-level security and grants - the tenant pattern ──────────────────────
--
-- `web_forms` is org-scoped, so the standard policy applies and verify-rls.js
-- passes with no allowlist entry. REVOKE before GRANT (0147, 0150, 0158 on the
-- same trap: a GRANT-only block narrows nothing).
--
-- The PUBLIC read path does NOT go through `anon`. A visitor loading /f/<slug>
-- is served by the marketing app, which has no credentials for this database at
-- all (its role reaches the `marketing` schema and nothing else) - it asks the
-- API, and the API resolves the slug on the admin pool before entering the
-- org's own context, exactly as `resolveSource` does for an intake token. So
-- `anon` and `authenticated` stay revoked here like everywhere else.

ALTER TABLE web_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_forms FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON web_forms
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON web_forms FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON web_forms FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
    -- No DELETE. See the permission block below: a form is CLOSED, never
    -- deleted, because its lead_sources row is what every lead it has ever
    -- created is attributed to.
    GRANT SELECT, INSERT, UPDATE ON web_forms TO aura_app;
  END IF;
END $$;

DO $$ BEGIN
  CREATE TRIGGER web_forms_set_updated_at BEFORE UPDATE ON web_forms
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Permission grants for the new object type ───────────────────────────────
--
-- `CrmPermissionsGuard` DENIES whatever it finds no grant for. `web_form` is
-- already in `PermissionObjectType`, so mounting the guard on the new routes
-- without seeding these first would 403 every user in every tenant the moment
-- the API container restarted - and the grid is only editable by an admin who
-- would first have to notice. 0041 says this about `task`, 0103 about `lead`,
-- 0158 about `dnc`; this block is the one thing in this file that exists purely
-- to prevent a deploy-day lockout.
--
-- No CHECK to widen: `role_permissions.object_type` is an open string (0039),
-- and view/create/edit are already in `role_permissions_action_check`.
--
-- CUSTOM roles are deliberately NOT touched - 0041's choice, kept by 0157/0158.
-- Nobody has ever held `web_form`, so there is nothing to preserve and widening
-- a hand-built role would be a decision rather than a restoration.

-- `web_form:view` - everybody, `viewer` included.
--
-- This is the opposite judgement to 0158's `contact_number:view`, and the
-- schema is why. A form row holds a definition, a slug and a counter; there is
-- no customer in it and no number. What reading it discloses is "this
-- workspace publishes a Diwali offer form", which is already public - the page
-- is on the open internet. Withholding it would mean a telecaller looking at a
-- lead attributed to "Diwali offer" cannot see what that is.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'web_form', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin',
                 'workspace_member', 'viewer')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `web_form:create` and `web_form:edit` - the three admin roles only.
--
-- The same narrowing 0136 made for `lead_board` and 0158 for `dnc`, and here
-- the argument is stronger than either: publishing a form puts a page carrying
-- the tenant's name on the open internet, under a consent sentence that becomes
-- the legal basis for every number it collects. `edit` includes rewriting that
-- sentence and includes `status = 'published'`. That is not floor work.
--
-- Scope is always `all` - `web_form` is in `ALL_SCOPE_ONLY_OBJECTS`, because a
-- public form has no owner and "my own forms" means nothing. No statement in
-- the API emits an `owned` clause for it and none should be added.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'web_form', a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('create'), ('edit')) AS a(action)
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- There is deliberately NO `web_form:delete`, and no DELETE grant above.
--
-- A form is retired with `status = 'closed'`, which keeps the row, the slug and
-- the source. Deleting one would orphan the `lead_sources` row that every lead
-- it ever produced is attributed to, so an attribution report would start
-- showing leads from a source nobody can name - and the published link, which
-- by then is in an email signature and on a printed card, would 404 instead of
-- saying the form has closed. The same reasoning 0158 gives for a DNC list and
-- 0111 for an opt-out: the record of the thing is the point.
--
-- A cell on the permissions grid for an action no route performs is worse than
-- no cell, so `ENFORCED_PERMISSIONS` must not gain `web_form:delete` either.

-- ── Prove it, rather than assume it ─────────────────────────────────────────
--
-- Every active membership that can reach the console must resolve to a
-- `web_form:view` grant through the same join the guard uses, including its
-- `role_id IS NULL` fallback against the legacy `memberships.role` string.
--
-- A WARNING and not an exception, for 0103's and 0158's reason: this runs
-- inside the deploy's migrate job, and aborting would leave the schema
-- half-applied and the deploy dead to report a data condition that is visible
-- and repairable from the console afterwards. A membership on a CUSTOM role is
-- the expected finding - those are not seeded above.
DO $do$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
    FROM memberships m
    JOIN organizations o ON o.id = m.org_id AND 'aura' = ANY(o.enabled_modules)
   WHERE m.status = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM roles r
         JOIN role_permissions rp
           ON rp.role_id = r.id AND rp.object_type = 'web_form' AND rp.action = 'view'
        WHERE r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
     );

  IF stranded > 0 THEN
    RAISE WARNING '0161: % membership(s) resolve to no web_form:view grant (custom roles are not seeded) - grant it on Team & permissions', stranded;
  ELSE
    RAISE NOTICE '0161: every active membership resolves to a web_form:view grant';
  END IF;
END $do$;
