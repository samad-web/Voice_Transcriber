------------------------------------------------------------------------------
-- 0186_agent_callbacks.sql - "call me at 5" becomes a managed commitment
-- (Build docs/transcript-agent-build-plan.md §10A, milestone M5a).
--
-- ── THE ONE SENTENCE THIS FILE IS SHAPED BY ────────────────────────────────
--
-- §20: "no customer commitment is silently lost, **including when the feature
-- is turned off**."
--
-- Every column below exists because of a way that can happen quietly:
--
--   `due_at` + `window_*`   resolved to the wrong day, and nobody rings
--   `moved_reason`          moved into calling hours without the telecaller
--                           being told, so they ring at an hour nobody agreed
--   `original_assignee_id`  reassigned off somebody on leave, and the history
--                           of who it was promised by is gone
--   `callback_reminders`    reminded by a browser timer, and lost when the tab
--                           closed
--   `callback_escalations`  missed, and escalated to the person who missed it
--   `superseded_by`         a second request creating a second callback
--   `converted_task_id`     deleted when the owner switched the feature off
--
-- ── WHY NOT `tasks`? ───────────────────────────────────────────────────────
--
-- This platform already has dated follow-ups with assignees and acceptance
-- (0041/0095/0135/0141), and 0134's missed-call sweep already creates a
-- "callback task". So the obvious move is a flag on `tasks`, and it is the
-- wrong one for three reasons:
--
--   1. A callback has a LIFECYCLE a task does not: due -> reminded ->
--      in_progress -> missed -> escalated -> reassigned, with attempts and
--      retries. Modelling that as `tasks.status` would widen a CHECK every
--      other task reader depends on.
--   2. A callback carries the CUSTOMER'S OWN WORDS with an audio offset, and a
--      commitment flag (`committed`) that decides whether a manager is woken.
--      Neither belongs on a general to-do.
--   3. §10A.7 requires that switching the feature off CONVERTS open callbacks
--      INTO tasks. That conversion is only expressible if they are different
--      things - and it is the mechanism by which nothing is lost.
--
-- So this is its own table, and `converted_task_id` is the bridge back.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS callbacks (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- CASCADE on the lead and SET NULL on the contact, the same split 0023 and
  -- 0166 make: a lead IS the enquiry, so erasing it takes the promise made
  -- about it, while a contact may be erased independently of a promise that was
  -- still made.
  lead_id    uuid REFERENCES leads(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,

  -- §10A.1: "capture, when present, a different contact or number ('call my
  -- brother on this number')". So the number is stored on the CALLBACK and is
  -- not read off the lead at ring time - the lead's number is the wrong one in
  -- exactly the case the customer took the trouble to tell us about.
  --
  -- HMAC'd and last-3, matching `calls` (0001) and the number vault (0157): a
  -- callback list is read by managers, and a full number in it is a disclosure
  -- the vault's own `contact_number:view` grant exists to control.
  contact_phone_hash  text,
  contact_phone_last3 text,
  -- The E.164 number lives in the vault (`contact_numbers`, 0157) and is
  -- revealed through its own `contact_number:view` grant. This is the link, and
  -- the reason the number is not duplicated here.
  contact_number_id uuid REFERENCES contact_numbers(id) ON DELETE SET NULL,
  -- `sha256(phoneMatchDigits(n))` - the vault's own join key (0157/0133/0146),
  -- so a callback is reachable from a call or a lead without any of them
  -- storing a number.
  number_key text,
  contact_name text,
  -- §10A.1: "preferred language".
  preferred_language text,

  -- Where it came from. All three nullable: a callback may be created by hand
  -- from the console, which is a callback with no run behind it.
  source_call_id   uuid REFERENCES calls(id) ON DELETE SET NULL,
  source_run_id    uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  source_intent_id uuid REFERENCES agent_intents(id) ON DELETE SET NULL,

  -- §10A.3: assigned to the telecaller who handled the call. BOTH identities,
  -- for the reason 0184's header sets out: most telecallers have no `users`
  -- row, and a list keyed only on users would be empty for most of a floor.
  assigned_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_telecaller_id uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  -- Kept when a reassignment happens, so "who promised this" survives "who
  -- owns it now". §10A.3 reassigns on absence; without this the trail of a
  -- commitment made by a person on leave simply ends.
  original_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  original_telecaller_id uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assignment_reason text,

  -- §10A.1's five kinds.
  type text NOT NULL CHECK (type IN ('exact', 'window', 'vague', 'far_future', 'conditional')),
  -- THE COLUMN THE ESCALATION LADDER READS. §10A.5: "by default, escalate only
  -- committed callbacks (customer gave a time)". Waking a manager about "call
  -- me sometime" is how a business learns to ignore this alert.
  committed boolean NOT NULL DEFAULT false,

  -- The customer's own words, and the offset to jump to in the audio. §10A.3:
  -- "the customer's quote with an audio jump link". A telecaller who can hear
  -- the sentence does not have to trust the system about it.
  requested_text text,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- §10A.1: the condition, quoted, for a conditional request.
  condition_text text,

  due_at       timestamptz NOT NULL,
  window_start timestamptz,
  window_end   timestamptz,
  -- §10A.3: "a request outside [calling hours] is moved to the nearest
  -- permitted time and FLAGGED to the telecaller." The flag is this column,
  -- and it is not cosmetic: a callback moved without a note is a telecaller
  -- ringing at an hour the customer did not agree to with no idea that is what
  -- they are doing.
  requested_due_at timestamptz,
  moved_reason text,
  -- §10A.1: a vague or conditional request needs confirming with the customer.
  needs_confirmation boolean NOT NULL DEFAULT false,

  -- §10A.3's priority score, "stored with its reasons".
  priority_score  numeric NOT NULL DEFAULT 0,
  priority_reason jsonb NOT NULL DEFAULT '[]'::jsonb,

  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN (
    'scheduled', 'due', 'reminded', 'in_progress', 'completed', 'rescheduled',
    'missed', 'escalated', 'reassigned', 'closed_unreachable', 'cancelled'
  )),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  completed_at timestamptz,
  -- How it ended, where that is a thing a person chose.
  outcome text,
  -- The call that closed it, for the auto-complete path (§10A.2).
  completed_call_id uuid REFERENCES calls(id) ON DELETE SET NULL,
  auto_completed boolean NOT NULL DEFAULT false,

  notes text,
  -- §10A.2: "a newer request supersedes the older one (the last confirmed
  -- statement wins) and the old one is marked superseded_by."
  superseded_by uuid REFERENCES callbacks(id) ON DELETE SET NULL,
  -- §10A.7's bridge: what this became when the feature was switched off.
  converted_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,

  -- §3A.4: "the executor refuses any action lacking a valid gate_decision_id."
  -- The run whose gate snapshot authorised this callback's creation.
  gate_decision_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,

  -- §10A.3's optional calendar block for committed exact-time callbacks.
  slot_hold_id uuid REFERENCES agent_slot_holds(id) ON DELETE SET NULL,

  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT callbacks_window CHECK (
    window_start IS NULL OR window_end IS NULL OR window_end >= window_start
  ),
  CONSTRAINT callbacks_assignee CHECK (
    assigned_user_id IS NOT NULL OR assigned_telecaller_id IS NOT NULL
  ),
  -- A terminal status must say when it got there. Without this, the adherence
  -- metric (§10A.8) divides by a completion instant that may be null and
  -- silently under-reports a floor that is doing fine.
  CONSTRAINT callbacks_completed_at CHECK (
    status <> 'completed' OR completed_at IS NOT NULL
  )
);

-- ── ONE ACTIVE CALLBACK PER LEAD AND CONTACT (§10A.2) ──────────────────────
--
-- "One active callback per lead and contact; a newer request supersedes the
-- older one."
--
-- A partial unique index over the OPEN statuses is what enforces it, rather
-- than a check in the API. The acceptance criterion in §17 M5a is "a repeated
-- or duplicate transcript creates no second callback", and the only way to
-- hold that against a redelivered queue message, a reprocess and a second call
-- in the same minute is a constraint the database refuses.
--
-- `COALESCE` on the contact hash: a callback for the lead's own number has no
-- separate contact, and NULL is distinct from NULL for uniqueness - so without
-- the coalesce two "call the lead back" callbacks would both insert.
CREATE UNIQUE INDEX IF NOT EXISTS callbacks_one_active_per_contact
  ON callbacks (org_id, lead_id, COALESCE(contact_phone_hash, ''))
  WHERE status IN ('scheduled', 'due', 'reminded', 'in_progress', 'missed', 'escalated')
    AND lead_id IS NOT NULL;

-- §15's index, verbatim: the to-call list's own read.
CREATE INDEX IF NOT EXISTS callbacks_list
  ON callbacks (org_id, assigned_user_id, status, due_at);
CREATE INDEX IF NOT EXISTS callbacks_list_telecaller
  ON callbacks (org_id, assigned_telecaller_id, status, due_at);
-- The sweep's read: anything open and due, across the org.
CREATE INDEX IF NOT EXISTS callbacks_due
  ON callbacks (org_id, due_at)
  WHERE status IN ('scheduled', 'due', 'reminded');
CREATE INDEX IF NOT EXISTS callbacks_retry
  ON callbacks (next_attempt_at)
  WHERE next_attempt_at IS NOT NULL AND status IN ('missed', 'escalated', 'in_progress');
CREATE INDEX IF NOT EXISTS callbacks_lead ON callbacks (org_id, lead_id);
CREATE INDEX IF NOT EXISTS callbacks_source_call ON callbacks (source_call_id);

ALTER TABLE callbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE callbacks FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON callbacks
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON callbacks TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §10A.4 - reminders, SERVER-SIDE
-- ══════════════════════════════════════════════════════════════════════════
--
-- "Delivered by a server-side scheduler, not client timers. Reminders survive
-- restarts, are idempotent, and have tracked states (scheduled -> delivered ->
-- acted)."
--
-- That is three requirements and all three are this table. A `setTimeout` in a
-- browser tab is lost at lunchtime; a row with an instant and a state is not,
-- and the sweep that drains it is the same shape as every other outbox here.
CREATE TABLE IF NOT EXISTS callback_reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  callback_id uuid NOT NULL REFERENCES callbacks(id) ON DELETE CASCADE,

  kind    text NOT NULL CHECK (kind IN ('pre', 'due', 'nudge')),
  channel text NOT NULL CHECK (channel IN ('in_app', 'push', 'whatsapp', 'email', 'digest')),

  scheduled_at timestamptz NOT NULL,
  delivered_at timestamptz,
  -- §10A.4: the popup "persists until acted on". This is when it was.
  acted_at     timestamptz,
  state text NOT NULL DEFAULT 'scheduled' CHECK (state IN (
    'scheduled', 'delivered', 'acted',
    -- §10A.4's smart suppression: queued because the telecaller is on a call,
    -- or inside quiet hours. Retried on the next tick.
    'held',
    -- Past its usefulness. A phone that was off all day should not wake up to
    -- "follow-up due now" from the morning - the same rule
    -- `HANDSET_ALERT_TTL_MINUTES` applies.
    'expired',
    -- The callback was completed or cancelled before this fired.
    'cancelled'
  )),
  held_reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The handset alert or notification this produced, so a delivery receipt
  -- exists rather than being inferred.
  notification_id uuid REFERENCES notifications(id) ON DELETE SET NULL,
  handset_alert_id uuid REFERENCES handset_alerts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- IDEMPOTENT, which §10A.4 asks for by name. One reminder of each kind per
  -- channel per callback - so a sweep that runs twice, or a restart mid-drain,
  -- cannot give the telecaller two popups for one commitment.
  CONSTRAINT callback_reminders_one_per_kind UNIQUE (callback_id, kind, channel)
);

CREATE INDEX IF NOT EXISTS callback_reminders_due
  ON callback_reminders (scheduled_at)
  WHERE state IN ('scheduled', 'held');
CREATE INDEX IF NOT EXISTS callback_reminders_callback
  ON callback_reminders (callback_id, kind);

ALTER TABLE callback_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE callback_reminders FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON callback_reminders
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON callback_reminders TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §10A.5 - the escalation ladder
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS callback_escalations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  callback_id uuid NOT NULL REFERENCES callbacks(id) ON DELETE CASCADE,

  level integer NOT NULL CHECK (level >= 0 AND level <= 5),
  -- §10A.5: "recipients are roles, positions or named users, resolved through
  -- the org chart's reporting line." Stored as what was CONFIGURED and what it
  -- RESOLVED TO, separately - because "the manager" in March was a different
  -- person to "the manager" today, and an audit of a missed commitment needs
  -- the person who was actually told.
  recipient_kind text NOT NULL CHECK (recipient_kind IN
    ('assignee', 'manager', 'owner', 'position', 'user')),
  recipient_position_id uuid REFERENCES positions(id) ON DELETE SET NULL,
  recipient_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_telecaller_id uuid REFERENCES telecallers(id) ON DELETE SET NULL,
  -- §10A.5: "if a recipient is vacant or on leave, skip to the next level or
  -- the configured fallback." This records which happened.
  resolution text CHECK (resolution IS NULL OR resolution IN
    ('resolved', 'vacant', 'on_leave', 'no_recipient', 'skipped')),

  channel text NOT NULL CHECK (channel IN ('in_app', 'push', 'whatsapp', 'email', 'digest')),
  action  text NOT NULL DEFAULT 'notify' CHECK (action IN ('notify', 'reassign', 'raise_priority')),

  scheduled_at timestamptz NOT NULL,
  sent_at      timestamptz,
  -- §10A.5: "acknowledgement stops further escalation FOR THAT LEVEL."
  -- Per-level and not for the ladder: a manager seeing it at +15 does not mean
  -- the owner should not learn at +60 that it is still not done.
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- §10A.5: "managers can reassign, call the customer themselves, extend the
  -- time, or dismiss with a REQUIRED reason."
  outcome text CHECK (outcome IS NULL OR outcome IN
    ('acknowledged', 'reassigned', 'called', 'extended', 'dismissed')),
  outcome_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- One row per level per recipient. A sweep that runs twice must not send the
  -- manager two alerts about one missed call.
  CONSTRAINT callback_escalations_one_per_level
    UNIQUE (callback_id, level, recipient_kind, recipient_user_id, recipient_position_id),
  -- A dismissal has to say why. §10A.5 requires the reason, and a NOT NULL on
  -- a nullable column cannot express "required only for one value" - a CHECK
  -- can.
  CONSTRAINT callback_escalations_dismiss_reason CHECK (
    outcome <> 'dismissed' OR (outcome_reason IS NOT NULL AND length(btrim(outcome_reason)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS callback_escalations_due
  ON callback_escalations (scheduled_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS callback_escalations_callback
  ON callback_escalations (callback_id, level);
-- The owner's daily digest (§10A.5 level 2).
CREATE INDEX IF NOT EXISTS callback_escalations_digest
  ON callback_escalations (org_id, channel, sent_at) WHERE channel = 'digest';

ALTER TABLE callback_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE callback_escalations FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON callback_escalations
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON callback_escalations TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §10A.6 - the owner's setup wizard
-- ══════════════════════════════════════════════════════════════════════════
--
-- ── EFFECTIVE-DATED, BECAUSE §10A.6 STEP 10 ASKS FOR IT ────────────────────
--
-- "Settings are effective-dated and audited; changes apply to new callbacks,
-- with an option to re-apply to open ones."
--
-- So a policy is a ROW WITH A WINDOW, not a mutable settings record. A
-- callback created in March escalated by March's ladder, and an owner who
-- tightens the grace period in June has not retroactively made February's
-- callbacks late. One open row at a time, same partial-unique shape as 0184's
-- settings.
CREATE TABLE IF NOT EXISTS callback_policies (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The whole of `CallbackPolicy` as one validated document.
  --
  -- ── WHY JSONB AND NOT THIRTY COLUMNS ─────────────────────────────────────
  --
  -- Unusual for this codebase, which prefers columns with CHECKs, and the
  -- reason is the escalation LADDER. It is an ordered list of levels, each with
  -- a list of recipients and a list of channels - a shape that is two child
  -- tables if it is columns, and those child tables would have to be
  -- effective-dated alongside this one. Three versioned tables to express one
  -- document that is read in full on every tick and written by one screen.
  --
  -- The validation that columns would have given is `CallbackPolicyInput` in
  -- `packages/shared/src/callbacks.ts`, which is stricter than a CHECK can be
  -- (a ladder must climb; retry intervals must not get shorter), and is applied
  -- by the API before the write. The CHECK below holds the shape.
  params  jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  -- Pinned on the row, so a stored policy written by an older rules version is
  -- recognisable rather than being silently reinterpreted.
  rules_version text NOT NULL DEFAULT '1.0.0',

  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to   timestamptz,
  set_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT callback_policies_window CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS callback_policies_one_open
  ON callback_policies (org_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS callback_policies_history
  ON callback_policies (org_id, effective_from DESC);

ALTER TABLE callback_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE callback_policies FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON callback_policies
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON callback_policies TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §10A.4 - a telecaller's own preferences
-- ══════════════════════════════════════════════════════════════════════════
--
-- §10A.6 step 4: "which personal preferences a telecaller may change". The
-- POLICY says which are permitted (`personalOverrides`); this holds what each
-- person chose. A column per permitted preference rather than JSON, because
-- there are three of them and they are read on every reminder.
CREATE TABLE IF NOT EXISTS callback_preferences (
  org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sound   boolean,
  pre_reminder_minutes integer CHECK (pre_reminder_minutes IS NULL OR
    (pre_reminder_minutes >= 0 AND pre_reminder_minutes <= 240)),
  channels text[],
  -- §10A.4: "respect quiet hours and the telecaller's Do Not Disturb. Missed-
  -- callback rules still apply during DND." The second sentence is enforced in
  -- the sweep, not here - this column only ever silences a REMINDER.
  dnd_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

ALTER TABLE callback_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE callback_preferences FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON callback_preferences
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;
GRANT SELECT, INSERT, UPDATE, DELETE ON callback_preferences TO aura_app;

-- ══════════════════════════════════════════════════════════════════════════
--  §10A.3 - the permission object
-- ══════════════════════════════════════════════════════════════════════════
--
-- §10A.9: "all endpoints enforce the feature gate and role permissions;
-- telecallers see only their own list."
--
-- A new `callback` object in the permission grid (0039), and the seeding below
-- is the step that must never be skipped: `CrmPermissionsGuard` DENIES whatever
-- it finds no grant for, so widening `PermissionObjectType` without seeding
-- locks every user out of the new object on deploy day. `permissions.ts`'s own
-- header says so, and 0136 is the precedent.
--
-- ── SCOPES, AND WHY `callback` IS NOT ALL-SCOPE-ONLY ───────────────────────
--
-- `owned` is the MOST meaningful scope on it - the whole product is "a
-- telecaller's own to-call list". So it carries a real owner column
-- (`assigned_user_id`) and a telecaller gets `view`/`edit` at `owned`, exactly
-- as `appointment` does.
-- No CHECK to widen: `role_permissions.object_type` is an open string (0039's
-- decision, app-validated by a zod enum) and view/create/edit are already in
-- `role_permissions_action_check`. Only rows are needed - the same note 0158,
-- 0159 and 0161 carry.
--
-- CUSTOM roles are deliberately NOT touched - 0041's choice, repeated by 0158
-- and 0159: somebody defined those by hand and silently widening them is not a
-- migration's call. Nobody has ever held `callback`, so there is nothing to
-- preserve.
--
-- NEW orgs are already covered: `seedCrmDefaults` cross-joins
-- `PermissionObjectType.options`, so an org provisioned after this deploy gets
-- the grid without another backfill. These statements are for the orgs that
-- exist today.

-- `callback:view` at `owned` for the telecaller, `all` for everybody above.
--
-- Two statements and not one, because the SCOPE is the whole point of this
-- object: a telecaller must see their own to-call list, and `owned` is the
-- grant that says so. `viewer` is included at `all` on the same test 0159
-- applied - what does reading this disclose? A due time, a reason and a quote.
-- The customer's NUMBER is not in it: that is `contact_numbers` behind
-- `contact_number:view`, which 0158 withholds from `viewer`. So a viewer can
-- see how the floor is doing and cannot ring anybody.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'callback', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin', 'viewer')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'callback', 'view', 'owned'
  FROM roles r
 WHERE r.is_system AND r.key = 'workspace_member'
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `callback:create` - the three admin roles AND `workspace_member`.
--
-- Wider than 0159's `dial_campaign:create`, and the reason is that creating a
-- callback is not a whole-org decision: it is a telecaller writing down a
-- promise they just made on a call. Withholding it would mean the one person
-- who knows the customer asked cannot record it, which is the failure §20
-- forbids arriving by way of a permission.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'callback', 'create',
       CASE WHEN r.key = 'workspace_member' THEN 'owned' ELSE 'all' END
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin', 'workspace_member')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `callback:edit` - snooze, reschedule, complete, record an attempt.
--
-- Same four roles and the same scope split. A telecaller editing their own
-- callback IS the product; a telecaller editing somebody else's is what the
-- `owned` scope refuses. REASSIGNMENT is deliberately not this cell - it is
-- gated on the manager's `all` scope in the controller, because handing work
-- to another person is a decision about somebody else's day.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'callback', 'edit',
       CASE WHEN r.key = 'workspace_member' THEN 'owned' ELSE 'all' END
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin', 'workspace_member')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- No `delete`. A callback is CANCELLED, never deleted: it is the record of a
-- promise a business made to a person, and a delete cell would be a way to
-- make that record disappear. Same reasoning 0158 gives for `dnc`.

-- ══════════════════════════════════════════════════════════════════════════
--  THE SECOND RLS AXIS: the partner wall (0163)
-- ══════════════════════════════════════════════════════════════════════════
--
-- A channel partner runs inside `withPartnerContext`, which sets `app.org_id`
-- to the tenant's own id - so `org_isolation` admits them and the RESTRICTIVE
-- `partner_wall` is the only thing that does not. `callbacks` carries the
-- customer's own words and a phone-number link; a partner reading the floor's
-- to-call list would be reading the tenant's pipeline.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['callbacks', 'callback_reminders', 'callback_escalations',
                           'callback_policies', 'callback_preferences'] LOOP
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END LOOP;
END $do$;

DO $do$
DECLARE t text; missing text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['callbacks', 'callback_reminders', 'callback_escalations',
                           'callback_policies', 'callback_preferences'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = t
         AND policyname = 'partner_wall' AND permissive = 'RESTRICTIVE'
    ) THEN
      missing := missing || ' ' || t;
    END IF;
  END LOOP;
  IF missing <> '' THEN
    RAISE EXCEPTION '0186: partner_wall missing or not RESTRICTIVE on:%', missing;
  END IF;
END $do$;

-- ══════════════════════════════════════════════════════════════════════════
--  The Supabase API roles hold nothing here
-- ══════════════════════════════════════════════════════════════════════════
DO $do$
DECLARE api_role text; t text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN CONTINUE; END IF;
    FOREACH t IN ARRAY ARRAY['callbacks', 'callback_reminders', 'callback_escalations',
                             'callback_policies', 'callback_preferences'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
    END LOOP;
  END LOOP;
END $do$;

-- ══════════════════════════════════════════════════════════════════════════
--  Prove the one index this file cannot do without
-- ══════════════════════════════════════════════════════════════════════════
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE tablename = 'callbacks' AND indexname = 'callbacks_one_active_per_contact'
  ) THEN
    RAISE EXCEPTION '0186: the one-active-callback index is missing - a repeated transcript would create a second callback';
  END IF;
  RAISE NOTICE '0186: callbacks ready - lifecycle, reminders, escalations, effective-dated policy.';
END $do$;
