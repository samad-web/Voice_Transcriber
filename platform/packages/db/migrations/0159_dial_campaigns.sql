-- 0159_dial_campaigns.sql - the dialer itself (Build docs/39 §7).
--
-- P0 (0157/0158) answered "may we ring this person". This answers "whom, in
-- what order, from which phone, and what happened when we did".
--
-- ── THREE TABLES, AND WHY THAT IS THE RIGHT NUMBER ──────────────────────────
--
--   dial_campaigns    the supervisor's decision: a source, an order, a ceiling
--                     and a retry gap. One row per campaign.
--   dial_queue_items  one row per RECORD in that campaign - the materialised
--                     work list, with the lease a handset claims it under.
--   dial_attempts     one row per DIAL. Not per call: see below.
--
-- ── WHY `dial_attempts` IS NOT FOLDED INTO `calls` (§7) ─────────────────────
--
-- A dial that never connects produces no `calls` row on some OEMs, and a dial
-- the agent cancels before it rings produces nothing anywhere. If attempts
-- lived on `calls`, those events would be invisible and "how many numbers did
-- we actually try" - the only number a campaign is judged on - would be
-- unanswerable. That is the same reasoning that put NO_AUDIO calls in 0133
-- rather than discarding them: the absence of audio is a fact about the call,
-- not a reason to forget the call happened.
--
-- The link between the two is therefore asynchronous and allowed to be absent:
-- `dial_attempts.call_id` is NULL for ~30s after every dial, and permanently
-- NULL for every dial that produced nothing. §10 and
-- apps/worker/src/pipeline/dial-attempt-link.ts own that join.
--
-- ── NO NUMBER IN ANY OF THESE TABLES ────────────────────────────────────────
--
-- `dial_queue_items.number_key` is the digest, never an E.164. The vault
-- (0157) holds the only copy of a dialable number and exactly two API routes
-- may serve it; a queue table that stored numbers would put six thousand of
-- them in a table with different grants and defeat the whole arrangement.
--
-- ── WHAT THIS MIGRATION MUST NOT SKIP ───────────────────────────────────────
--
-- The `dial_campaign` grant seeding at the bottom. `CrmPermissionsGuard` denies
-- whatever it finds no grant for, so landing the controllers without those rows
-- 403s every user in every tenant the moment the API container restarts. 0041
-- says this about `task`, 0103 about `lead`, 0158 about `dnc`; this file says it
-- about `dial_campaign`.

-- ── 1. dial_campaigns ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dial_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL,

  mode          text NOT NULL DEFAULT 'preview'
                  CHECK (mode IN ('preview', 'progressive')),
  -- Progressive only: seconds between the disposition saving and the next
  -- auto-dial. 0 means "immediately", which agents hate; 5 is the default and
  -- the agent screen shows a cancellable countdown either way.
  advance_delay_sec int NOT NULL DEFAULT 5
                  CHECK (advance_delay_sec BETWEEN 0 AND 60),

  -- Where records come from. A saved view (0118), a lead board (0136) or an
  -- ad-hoc filter - resolved at build time AND again on refresh, never frozen
  -- as an id list, so a lead that becomes un-dialable between build and dial
  -- is still caught by §5.
  source_kind   text NOT NULL CHECK (source_kind IN ('saved_view','board','filter')),
  source_ref    uuid,
  source_filter jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 'temperature' uses leads.temperature (0083): Hot > Medium > Cold. Never
  -- leads.score - that is the extraction's confidence heuristic and reusing it
  -- as a rating is explicitly forbidden.
  priority      text NOT NULL DEFAULT 'temperature'
                  CHECK (priority IN ('temperature','oldest','newest','value')),

  max_attempts  int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  retry_after_hours int NOT NULL DEFAULT 24,

  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','active','paused','completed')),
  starts_at     timestamptz,
  ends_at       timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── 2. dial_queue_items ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dial_queue_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES dial_campaigns(id) ON DELETE CASCADE,

  lead_id     uuid REFERENCES leads(id)    ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id) ON DELETE CASCADE,
  number_key  text NOT NULL,

  -- Assignment is to a PERSON; the device is resolved at fetch time, because
  -- somebody may swap handsets mid-shift and an item bound to a dead device
  -- would strand.
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  position    int NOT NULL,

  state       text NOT NULL DEFAULT 'queued' CHECK (state IN
                ('queued','locked','dialed','done','skipped','blocked')),
  -- Verbatim from dialability(). The agent screen renders it, so an agent
  -- knows WHY a record is greyed out rather than assuming a bug.
  block_reason text,

  attempt_count int NOT NULL DEFAULT 0,
  -- Optimistic lease, 120s. An expired lease is reclaimable, so a phone that
  -- dies mid-queue releases its record instead of holding it forever.
  locked_until timestamptz,
  locked_by_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dial_queue_campaign_lead
  ON dial_queue_items (campaign_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dial_queue_next
  ON dial_queue_items (campaign_id, assigned_user_id, state, position);

-- ── 3. dial_attempts ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dial_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  queue_item_id uuid NOT NULL REFERENCES dial_queue_items(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL REFERENCES dial_campaigns(id)   ON DELETE CASCADE,

  device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  user_id     uuid REFERENCES users(id)   ON DELETE SET NULL,

  dialed_at   timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  duration_sec int,

  -- The handset's read of the DIAL MECHANICS, from READ_PHONE_STATE. Not the
  -- disposition: that is a human judgement and lives on the call.
  result      text CHECK (result IN
                ('connected','no_answer','busy','rejected','failed',
                 'invalid_number','cancelled_by_agent')),

  -- Resolved asynchronously by §10. NULL is normal for ~30s after the call.
  call_id     uuid REFERENCES calls(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dial_attempts_campaign ON dial_attempts (campaign_id, dialed_at DESC);
CREATE INDEX IF NOT EXISTS dial_attempts_unlinked
  ON dial_attempts (org_id, dialed_at) WHERE call_id IS NULL;

-- ── 4. WHAT §7 DOES NOT HAVE, AND §8/§10 CANNOT BE BUILT WITHOUT ────────────
--
-- Everything above is §7 verbatim. Everything below is an ADDITION, kept in
-- its own block so a reviewer can see exactly what was added and argue with it
-- without re-reading the DDL. Each one is forced by another section of the
-- same document, not by taste.

-- (a) `client_ref` - §8 requires `POST /device/dialer/attempts` to be
--     "idempotent on a client key, same contract as the call upload", and §7
--     gives it no column to store one in. Without it a phone that retries a
--     report after a lost response writes the attempt twice, which
--     double-counts the only number a campaign is judged on AND steps the
--     record past `max_attempts` - the exact leak dialability()'s `>=` comment
--     warns about.
--
--     Same shape as `call_escalations.client_ref` (0151): the phone's own
--     opaque string, unique per org, nullable because a console-side or
--     backfilled attempt has no phone to have generated one.
ALTER TABLE dial_attempts ADD COLUMN IF NOT EXISTS client_ref text;

CREATE UNIQUE INDEX IF NOT EXISTS dial_attempts_client_ref
  ON dial_attempts (org_id, client_ref) WHERE client_ref IS NOT NULL;

-- (b) The ambiguity §10 says to "surface on the campaign health panel". An
--     agent who dials the same number twice in two minutes produces two
--     candidate calls for one attempt, and 0146 set the precedent that a
--     collision means ASK A PERSON rather than pick the newest. That verdict
--     has to be durable or the sweep re-derives it every minute and nothing
--     can show it.
--
--     `link_candidate_count` is how many calls the matcher could not choose
--     between, so the panel can say "2 possible calls" without re-running the
--     window query over `calls`.
ALTER TABLE dial_attempts
  ADD COLUMN IF NOT EXISTS link_ambiguous_at    timestamptz,
  ADD COLUMN IF NOT EXISTS link_candidate_count int;

-- (c) A call belongs to at most ONE attempt. §10's rule is "neither row is
--     already matched", and nothing in §7 enforces the second half: two
--     attempts could each link the same `calls` row and the campaign would
--     report two conversations where one happened. The partial unique index is
--     also what makes the sweep's write safe to retry.
CREATE UNIQUE INDEX IF NOT EXISTS dial_attempts_call_unique
  ON dial_attempts (call_id) WHERE call_id IS NOT NULL;

-- (d) The matcher's own read path, and the `last_attempt_at` recompute. §7
--     indexes `dial_attempts` by campaign and by unlinked-ness, neither of
--     which answers "the attempts of THIS queue item, newest first".
CREATE INDEX IF NOT EXISTS dial_attempts_queue_item
  ON dial_attempts (queue_item_id, dialed_at DESC);

-- (d2) The PERSON an attempt rang, denormalised onto the attempt.
--
--      Needed by the org-wide per-person daily ceiling
--      (organizations.dialer_max_calls_per_person_per_day, 0157), and it cannot
--      be derived by joining back through queue_item -> lead. Two leads can be
--      the SAME HUMAN - that is ordinary in this product, it is why contacts
--      have a merge flow at all - and a ceiling that counts per lead would let
--      a duplicated person be rung twice over while reporting compliance. The
--      ceiling is about a human being's phone ringing, so the human's key is
--      the thing the row has to carry.
--
--      Nullable: an attempt on a lead with no `contact_number_key` has no
--      person to count against, and such a row simply does not participate in
--      the ceiling. It is a key, never a number - the same hash
--      `leads.contact_number_key` holds, so this column is NOT a reintroduction
--      of 0006's removal and the number-disclosure spec stays true.
ALTER TABLE dial_attempts ADD COLUMN IF NOT EXISTS number_key text;

COMMENT ON COLUMN dial_attempts.number_key IS
  'sha256 of the last 10 digits, copied from leads.contact_number_key when the attempt is '
  'recorded. The counting key for organizations.dialer_max_calls_per_person_per_day (doc 39 '
  '§40.10): per PERSON, so two leads that are one human share a ceiling. Never an E.164.';

-- The ceiling asks exactly one question - "how many times has this org rung
-- this person since local midnight" - and this is the index that answers it
-- without reading the campaign's attempts.
CREATE INDEX IF NOT EXISTS dial_attempts_person_day
  ON dial_attempts (org_id, number_key, dialed_at DESC)
  WHERE number_key IS NOT NULL;

-- (e) `last_attempt_at` on the queue item - dialability()'s `lastAttemptAt`
--     input, which §7 leaves with nowhere to come from.
--
--     Denormalised for the same reason `dnc_lists.entry_count` is: the preview
--     and a queue refresh evaluate §5 over thousands of records in one request,
--     and a correlated `max(dialed_at)` per record at Seoul latency is what
--     turns an honest count into an estimate. Written in the same statement
--     that increments `attempt_count`, so the two cannot disagree.
ALTER TABLE dial_queue_items ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

-- (f) The lease reclaim's own index. §7's `dial_queue_next` leads on
--     `campaign_id`, which is right for the claim; nothing answers "every
--     expired lease in this org", which is what a supervisor screen and any
--     future reaper ask.
CREATE INDEX IF NOT EXISTS dial_queue_expired_lease
  ON dial_queue_items (org_id, locked_until) WHERE state = 'locked';

COMMENT ON TABLE dial_campaigns IS
  'A supervisor''s outbound calling decision (doc 39 §7): a record source, an order, an attempt '
  'ceiling and a retry gap. Holds no numbers.';
COMMENT ON TABLE dial_queue_items IS
  'One record in a campaign''s materialised work list. `number_key` is the digest shared with '
  'contact_numbers (0157), leads (0146) and calls (0133) - never an E.164.';
COMMENT ON TABLE dial_attempts IS
  'One DIAL, not one call. Deliberately separate from `calls` (doc 39 §7): a dial that never '
  'connects produces no calls row on some OEMs and a cancelled dial produces nothing anywhere, '
  'so "how many numbers did we try" is only answerable here. `call_id` is filled asynchronously '
  'by the §10 sweep and stays NULL for every dial that produced no call.';
COMMENT ON COLUMN dial_queue_items.block_reason IS
  'Verbatim from dialability() in @aura/shared - one of the seven DialBlockReason strings. '
  'Rendered to an agent as-is, so the preview''s count and the agent''s explanation cannot '
  'disagree. Note `quiet_hours` means "outside the calling window" (doc 39 §5.2''s naming wart).';
COMMENT ON COLUMN dial_queue_items.locked_until IS
  'Optimistic 120s lease. An EXPIRED lease is reclaimable by any handset, so a phone that dies '
  'mid-queue releases its record instead of stranding it. The claim is a single UPDATE ... FROM '
  '(SELECT ... FOR UPDATE OF q SKIP LOCKED) so two handsets never take the same row.';
COMMENT ON COLUMN dial_attempts.client_ref IS
  'The handset''s own idempotency key for its attempt report (doc 39 §8). Unique per org; NULL '
  'for an attempt no phone generated.';
COMMENT ON COLUMN dial_attempts.link_ambiguous_at IS
  'The §10 matcher found two or more candidate calls and refused to guess (the 0146 precedent). '
  'A person resolves it; the sweep will not revisit it.';

-- `updated_at` by trigger rather than by every future caller remembering.
-- Load-bearing on the queue item: the lease is written by an UPDATE and
-- "when did this record last change hands" is the question a stuck-queue
-- investigation starts from.
DO $$ BEGIN
  CREATE TRIGGER dial_campaigns_set_updated_at BEFORE UPDATE ON dial_campaigns
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER dial_queue_items_set_updated_at BEFORE UPDATE ON dial_queue_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Row-level security and grants - the tenant pattern ──────────────────────
--
-- All three tables are org-scoped, so the standard policy applies and
-- verify-rls.js passes with no allowlist entry - the difference from 0145,
-- whose non-tenant table failed the closure check and would have killed the
-- prod migrate job after applying four migrations.
--
-- REVOKE before GRANT. A GRANT-only migration in a database the Supabase API
-- roles can already reach narrows nothing: see 0075, 0081, 0089, 0145, 0157,
-- 0158 and the marketing-schema trap on exactly this.

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dial_campaigns', 'dial_queue_items', 'dial_attempts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
      -- DELETE included: a campaign deleted takes its queue and attempts with
      -- it by CASCADE, and a rebuilt queue removes the items whose records left
      -- the source. Neither is an audit record - `audit_log` carries the
      -- supervisor's decisions.
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    END IF;
  END LOOP;
END $$;

-- ── Permission grants for `dial_campaign` ───────────────────────────────────
--
-- `dial_campaign` is already in `PermissionObjectType`, mapped to module
-- `aura` (a recorder-only tenant still dials), and listed in
-- `ALL_SCOPE_ONLY_OBJECTS` - "my own campaign" means nothing, a campaign is a
-- whole-org decision about whom the business rings. So scope is always 'all'
-- and no statement in the dialer module emits an `owned` clause.
--
-- No CHECK to widen: `role_permissions.object_type` is an open string
-- (0039's decision, app-validated by a zod enum) and view/create/edit are
-- already in `role_permissions_action_check`. Only rows are needed.
--
-- CUSTOM roles are deliberately NOT touched - 0041's choice, repeated by 0158:
-- somebody defined those by hand and silently widening them is not a
-- migration's call. Nobody has ever held `dial_campaign`, so there is nothing
-- to preserve and over-granting would be a decision rather than a restoration.
--
-- NEW orgs are already covered: `seedCrmDefaults` in admin.controller.ts
-- cross-joins `PermissionObjectType.options`, so an org provisioned after this
-- deploy gets the grid without another backfill. This block is for the orgs
-- that exist today.

-- `dial_campaign:view` - every console role INCLUDING `viewer`.
--
-- The same test 0158 applied to `dnc:view` and failed for `contact_number`:
-- what does reading this disclose? A campaign is a name, a source, an order
-- and a set of counts. `dial_queue_items` holds a digest, never a number, and
-- the two routes that may serve an E.164 are both gated elsewhere - the
-- console's reveal on `contact_number:view` (which 0158 withholds from
-- `viewer`) and the handset's claim on a device token no browser holds. So a
-- viewer reading a campaign sees how the floor is doing and cannot ring
-- anybody, which is exactly what the role is for.
--
-- `workspace_member` is the telecaller working the queue; withholding the read
-- would make the agent screen look broken to the only people who use it.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'dial_campaign', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin',
                 'workspace_member', 'viewer')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `dial_campaign:create` - the three admin roles only.
--
-- Creating a campaign is choosing whom the business rings and committing a day
-- of the team's time to it. That is the same judgement 0136 made keeping
-- `workspace_member` away from `lead_board` and 0158 made for `dnc:create`,
-- and it is a narrowing of 0041's pattern on purpose.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'dial_campaign', 'create', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `dial_campaign:edit` - the three admin roles AND `workspace_member`, which is
-- WIDER than 0158's `dnc:edit` and needs saying out loud.
--
-- §8 maps SIX routes onto this one action: PATCH the campaign, build the
-- queue, activate, pause - and `POST /dialer/queue/:id/skip`, which is an
-- AGENT passing on the record in front of them. A telecaller who cannot skip
-- cannot work a queue at all (§13 lists it as an acceptance test), so
-- withholding `edit` from `workspace_member` would ship a dialer its own
-- agents cannot use.
--
-- The cost of granting it is real and is NOT hidden here: the same cell also
-- lets a telecaller pause or rebuild a campaign. That is a flaw in §8's
-- mapping rather than in this seed - "skip the record I am looking at" and
-- "stop the floor's campaign" are different trust decisions and should be
-- different actions. The fix is a separate `dial_campaign:dial` action (or
-- routing skip under its own object) in a later migration, at which point this
-- grant narrows to the three admin roles like `dnc:edit`. Until then an owner
-- can revoke the cell on Team & permissions, accepting that it also disables
-- Skip.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'dial_campaign', 'edit', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin',
                 'workspace_member')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- ── Prove it, rather than assume it ─────────────────────────────────────────
--
-- Every active membership that can reach the console must resolve to a
-- `dial_campaign:view` grant through the same join `CrmPermissionsGuard` uses,
-- including its `role_id IS NULL` fallback that matches `roles.key` against the
-- legacy `memberships.role` string.
--
-- A WARNING and not an exception, for 0103's and 0158's reason: this runs
-- inside the deploy's migrate job, and aborting would leave the schema
-- half-applied and the deploy dead in order to report a data condition that is
-- visible and repairable from the console afterwards. A membership on a CUSTOM
-- role is the expected finding, since custom roles are not seeded above.
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
           ON rp.role_id = r.id AND rp.object_type = 'dial_campaign' AND rp.action = 'view'
        WHERE r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
     );

  IF stranded > 0 THEN
    RAISE WARNING '0159: % membership(s) resolve to no dial_campaign:view grant (custom roles are not seeded) - grant it on Team & permissions', stranded;
  ELSE
    RAISE NOTICE '0159: every active membership resolves to a dial_campaign:view grant';
  END IF;
END $do$;
