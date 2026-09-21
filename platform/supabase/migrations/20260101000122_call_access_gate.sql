-- 0122_call_access_gate.sql - a tenant's call recordings are not ours to read.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--
-- Until now a platform operator could open any tenant's Call Explorer, play
-- any recording and read any transcript, because the operator console carries
-- the root ADMIN_API_KEY and nothing between it and the audio asked whether
-- the customer had agreed. For a product whose whole content is other
-- people's phone calls, "nobody happened to look" is not a control.
--
-- From here an operator reaching ANY call content in a gated org must hold a
-- live grant from that org's own administrator, bounded by a start and an end.
-- The attempt itself raises the request and tells the administrator it
-- happened.
--
-- ── WHO THIS GATES, AND WHO IT DOES NOT ─────────────────────────────────────
--
-- ONLY the platform operator - us. The tenant's own people are untouched:
-- their access to their own calls is already decided by `recordings_listen`,
-- the console persona and the permission grid, and adding a fourth axis over
-- the same object is what permission-grid.md warns gives "why can't Priya
-- hear this call" four answers.
--
-- The discriminator is the one OperatorOnlyGuard already relies on, inverted:
-- an owner-console request arrives on the admin key WITH `x-caller-user-id`,
-- an operator request arrives WITHOUT one. See call-access.guard.ts.
--
-- ── WHAT THIS CANNOT DO ─────────────────────────────────────────────────────
--
-- It does not constrain a holder of the raw ADMIN_API_KEY. That credential is
-- cross-tenant root by construction (DEPLOYMENT.md §7): anyone with the key
-- can forge `x-caller-user-id` and present as a tenant's own owner, or write
-- this table directly. This gate closes the CONSOLE path, makes every attempt
-- visible to the customer, and leaves an append-only trail. Claiming more than
-- that would be a lie told to a customer about their own recordings.
--
-- ── EXISTING TENANTS KEEP TODAY'S BEHAVIOUR ─────────────────────────────────
--
-- `call_access_gate_enabled` defaults TRUE, so every org created from here on
-- is gated. Every org that already exists is set FALSE by the backfill at the
-- bottom - the same rule 0103 followed for the permission grid: the migration
-- permits exactly what the product permitted the day before, and turning the
-- gate on is a decision somebody makes out loud, per tenant, not a side effect
-- of a deploy that silently locks support out of two live customers.
--
-- The toggle is CLIENT-side (owner console). The operator console can see
-- whether it is on and cannot turn it off - a gate whose subject can lift it
-- is not a gate.

-- 1 ── THE TOGGLE AND THE DESIGNATED ADMINISTRATOR ───────────────────────────

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS call_access_gate_enabled boolean NOT NULL DEFAULT true;

-- WHO gets told, and whose approval counts. NULL - the normal case - means
-- "every member with the `owner` persona", resolved at notify time so that
-- appointing a new owner does not leave the alert addressed to nobody.
-- Naming one person narrows it to them.
--
-- ON DELETE SET NULL, never CASCADE: removing a person from the business must
-- fall back to "every owner", not quietly delete the organisation.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS call_access_admin_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN organizations.call_access_gate_enabled IS
  'When true, a platform operator needs a live call_access_requests grant to read '
  'any call content in this org. Set from the OWNER console only - see 0122.';
COMMENT ON COLUMN organizations.call_access_admin_user_id IS
  'The member whose approval unlocks call access, and who is alerted on an attempt. '
  'NULL means every member holding the owner persona.';

-- 2 ── THE REQUEST, WHICH IS ALSO THE GRANT ─────────────────────────────────
--
-- One row is one operator's request for one org and whatever became of it.
-- Deliberately not two tables: a grant that could exist without the request it
-- answers is a grant nobody can account for, and the question a reader always
-- has - "who asked, why, who said yes, until when" - is then one row.

CREATE TABLE IF NOT EXISTS call_access_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The operator who asked. TEXT, not a users FK, and that is not laziness: a
  -- platform operator is a Supabase auth user with no membership and therefore
  -- no `users` row at all (see aura-console-access - `getPrincipal` resolves an
  -- account with no membership to kind:"operator"). The email is the only
  -- durable identifier they have.
  requested_by_email text NOT NULL
    CHECK (char_length(btrim(requested_by_email)) BETWEEN 3 AND 320),

  -- Why. Shown to the administrator verbatim, because "somebody at the vendor
  -- wants to hear your calls" is not a question anyone can answer well.
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),

  -- What the operator ASKED for. Kept even after the administrator edits it,
  -- so a narrowed grant still shows what was originally wanted.
  requested_start timestamptz NOT NULL,
  requested_end   timestamptz NOT NULL,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),

  -- What was actually GRANTED. Both NULL until approved.
  granted_start timestamptz,
  granted_end   timestamptz,

  -- Who decided, and how. `console` = the administrator signed in and pressed
  -- the button, and decided_by_user_id names them. `otp` = they read a code off
  -- their phone and gave it to the operator, so there is no console session to
  -- attribute and decided_by_user_id stays NULL - the code IS the attribution.
  decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_via text CHECK (decided_via IN ('console', 'otp')),
  decided_at  timestamptz,
  revoked_at  timestamptz,

  -- ── the one-time code ───────────────────────────────────────────────────
  -- PBKDF2, never the digits: six digits is ~20 bits, so a leaked table with
  -- plaintext codes would be no better than no codes. Attempts are counted and
  -- capped by the API for the same reason.
  otp_hash       text,
  otp_expires_at timestamptz,
  otp_attempts   integer NOT NULL DEFAULT 0 CHECK (otp_attempts >= 0),
  otp_sent_at    timestamptz,
  -- Last three digits only, for the trail: enough for the administrator to
  -- recognise their own number, not enough to be a copy of it.
  otp_sent_to_last3 text CHECK (otp_sent_to_last3 IS NULL OR otp_sent_to_last3 ~ '^[0-9]{3}$'),

  -- How many times this operator has been turned away while this request sat
  -- unanswered. The alert is raised once and this counts the rest - see the
  -- partial unique index below.
  attempts        integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── THE INVARIANTS, IN THE DATABASE ─────────────────────────────────────────
--
-- Every one of these could live in the API instead. They do not, because the
-- API is several controllers plus a worker plus whatever gets written next
-- year, and "an approved row always has an end" is the property the whole
-- feature rests on. A grant that reached `approved` with a NULL
-- `granted_end` would be permanent access wearing the word "granted".

-- A window must run forwards. Zero-length is not a window either.
ALTER TABLE call_access_requests DROP CONSTRAINT IF EXISTS call_access_requested_window;
ALTER TABLE call_access_requests
  ADD CONSTRAINT call_access_requested_window CHECK (requested_end > requested_start);

ALTER TABLE call_access_requests DROP CONSTRAINT IF EXISTS call_access_granted_window;
ALTER TABLE call_access_requests
  ADD CONSTRAINT call_access_granted_window CHECK (
    granted_end IS NULL OR granted_start IS NULL OR granted_end > granted_start
  );

-- Approved means bounded, decided, and attributable. Anything else is a
-- half-written row that the guard would read as live access.
ALTER TABLE call_access_requests DROP CONSTRAINT IF EXISTS call_access_approved_is_complete;
ALTER TABLE call_access_requests
  ADD CONSTRAINT call_access_approved_is_complete CHECK (
    status <> 'approved'
    OR (granted_start IS NOT NULL
        AND granted_end   IS NOT NULL
        AND decided_at    IS NOT NULL
        AND decided_via   IS NOT NULL
        -- A console decision names the person; an OTP decision cannot and
        -- must not pretend to.
        AND (decided_via = 'otp') = (decided_by_user_id IS NULL))
  );

-- A request nobody has answered holds no grant. Without this, a bug that set
-- `granted_end` while leaving the status alone would be invisible until the
-- day somebody changed how the guard reads it.
ALTER TABLE call_access_requests DROP CONSTRAINT IF EXISTS call_access_pending_grants_nothing;
ALTER TABLE call_access_requests
  ADD CONSTRAINT call_access_pending_grants_nothing CHECK (
    status <> 'pending'
    OR (granted_start IS NULL AND granted_end IS NULL
        AND decided_at IS NULL AND decided_via IS NULL AND decided_by_user_id IS NULL)
  );

ALTER TABLE call_access_requests DROP CONSTRAINT IF EXISTS call_access_decided_has_when;
ALTER TABLE call_access_requests
  ADD CONSTRAINT call_access_decided_has_when CHECK (
    status <> 'denied' OR decided_at IS NOT NULL
  );

ALTER TABLE call_access_requests DROP CONSTRAINT IF EXISTS call_access_revoked_has_when;
ALTER TABLE call_access_requests
  ADD CONSTRAINT call_access_revoked_has_when CHECK (
    status <> 'revoked' OR revoked_at IS NOT NULL
  );

-- A ceiling on how long any single grant can run.
--
-- "Until further notice" is what this feature exists to abolish, and a
-- thirty-day maximum is what stops an approval made once in March from still
-- being live in August. It is enforced here rather than in the form because
-- the form is one of several writers and the ceiling is the point. A tenant
-- that genuinely wants standing access has an honest way to say so - turning
-- the gate off - instead of a grant that pretends to expire.
ALTER TABLE call_access_requests DROP CONSTRAINT IF EXISTS call_access_window_is_bounded;
ALTER TABLE call_access_requests
  ADD CONSTRAINT call_access_window_is_bounded CHECK (
    granted_end IS NULL OR granted_start IS NULL
    OR granted_end <= granted_start + interval '30 days'
  );

-- ── INDEXES ─────────────────────────────────────────────────────────────────

-- ONE open request per operator per org. This is what turns "every attempt
-- alerts the administrator" into something a person can live with: the first
-- blocked read inserts the row and notifies, and the next forty - a console
-- page fans out to the list, the detail, the audio and the transcript at once -
-- collide here and only bump `attempts`. Without it, opening one page would
-- ring the customer's bell four times.
--
-- Case-insensitive on the email: an operator is one person whether they signed
-- in as Support@ or support@.
CREATE UNIQUE INDEX IF NOT EXISTS call_access_requests_one_open
  ON call_access_requests (org_id, lower(btrim(requested_by_email)))
  WHERE status = 'pending';

-- The guard's hot path: "does this operator hold a live grant on this org right
-- now". Partial, because the guard never looks at anything but approved rows.
CREATE INDEX IF NOT EXISTS call_access_requests_live
  ON call_access_requests (org_id, lower(btrim(requested_by_email)), granted_end)
  WHERE status = 'approved';

-- The administrator's queue, newest first.
CREATE INDEX IF NOT EXISTS call_access_requests_org_recent
  ON call_access_requests (org_id, created_at DESC);

-- 3 ── RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE call_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_access_requests FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY org_isolation ON call_access_requests
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE ON call_access_requests TO aura_app;

-- No DELETE, deliberately. A request is the record that somebody asked to hear
-- a customer's calls; withdrawing access is `revoked`, which keeps the row.
-- The retention reaper does not touch it either - it is a record ABOUT access,
-- not call content.

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON call_access_requests FROM %I', api_role);
    END IF;
  END LOOP;
  REVOKE ALL ON call_access_requests FROM PUBLIC;
END $$;

-- 3b ── A FOURTH KIND OF ACTOR ──────────────────────────────────────────────
--
-- `audit_log.actor_type` is plain text with no CHECK, and 0001 documents its
-- vocabulary in a trailing comment: user | device | api_key | system. The
-- call-access trail adds `operator` - a platform operator is none of those
-- four. They are not a `user` (no `users` row exists for them; they are a
-- Supabase auth account with no membership), and calling them `system` would
-- file the one actor a customer most needs to identify under the label that
-- means "nobody in particular".
--
-- Recorded as a COMMENT so the documented list stays true; 0001 cannot be
-- edited, and a reader checking what an actor_type may be should not have to
-- find this migration to learn the answer.
COMMENT ON COLUMN audit_log.actor_type IS
  'user | device | api_key | system | operator. `operator` (0122) is a platform '
  'operator acting on a tenant - actor_id is their email, since they hold no users row.';

-- 4 ── THE NOTIFICATION KIND ────────────────────────────────────────────────
--
-- Restated in full, the way 0100 and 0119 do it. `NotificationKind` in
-- packages/shared/src/notifications.ts is the other copy and
-- notification-kinds.test.ts reads THIS file to fail when the two drift - the
-- bug 0100's header records, where an INSERT of a kind only the enum knew
-- threw 23514 in production.

DO $$
DECLARE conname text;
BEGIN
  SELECT c.conname INTO conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'notifications' AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%kind%';
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', conname);
  END IF;
END $$;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'task_due', 'deal_stage_changed', 'deal_idle',
                  'automation', 'report_ready', 'lead_assigned',
                  'opt_out_requested', 'channel_needs_attention',
                  'sla_breach', 'review_pending',
                  -- 0122: a platform operator tried to open this org's call
                  -- content and was refused. The customer is told every time
                  -- somebody at the vendor reaches for their recordings.
                  'call_access_requested'));

-- 5 ── EXISTING TENANTS KEEP TODAY'S BEHAVIOUR ──────────────────────────────
--
-- See the header. Every org that exists at this moment is left exactly as
-- permissive as it was a second ago; the DEFAULT above gates every org created
-- from here on. Turning it on for a live customer is one UPDATE, made
-- deliberately, per tenant - not a deploy that locks support out of two
-- running accounts and reads as an outage.
--
-- `created_at < now()` rather than an unqualified UPDATE so that re-running
-- this migration cannot un-gate an org somebody has since switched on.
UPDATE organizations
   SET call_access_gate_enabled = false
 WHERE created_at < now()
   AND call_access_gate_enabled IS TRUE;

DO $$
BEGIN
  RAISE NOTICE '0122: call access gate OFF for % existing org(s); new orgs are gated by default',
    (SELECT count(*) FROM organizations WHERE call_access_gate_enabled = false);
END $$;
