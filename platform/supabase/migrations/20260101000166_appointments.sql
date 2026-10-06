------------------------------------------------------------------------------
-- 0166_appointments.sql - the second vertical primitive (Build docs/39 §25).
--
-- ── THIS IS A PORT, NOT A NEW BUILD ─────────────────────────────────────────
--
-- `marketing.booking_slots` (0023) plus 0027/0029/0030/0032/0047/0053 is a
-- COMPLETE appointment lifecycle already running in production on Aura's own
-- funnel: slots as first-class data, Google Calendar as an optional mirror
-- rather than the source, a WhatsApp confirmation on booking, reminders at
-- 24h/1h/5min each carrying a reschedule link, reschedule bearer tokens,
-- attendance ("did it happen"), and a no-show nurture drip gated on the lead
-- not having converted.
--
-- Everything below is that design copied into tenant-scoped `public`. What was
-- taken and what was left is listed at the bottom of this header.
--
-- ── THE MARKETING TABLE IS NOT MOVED, WIDENED OR MULTI-TENANTED ─────────────
--
-- Two reasons, both load-bearing.
--
-- 1. The `marketing` schema is reachable by a PUBLIC WEB ROLE (`aura_marketing`,
--    the unauthenticated site), and 0020 ends with
--
--        ALTER DEFAULT PRIVILEGES IN SCHEMA marketing
--          GRANT SELECT, INSERT, UPDATE ON TABLES TO aura_marketing;
--
--    so a GRANT-ONLY migration in that schema NARROWS NOTHING - the GRANT is a
--    no-op on top of something wider and the file reads as though it worked.
--    `REVOKE ALL` must come first. 0023 gets this right today (it revokes, then
--    grants SELECT and a four-column UPDATE); 0031 and 0033 did not, and 0053's
--    closing block is the record of finding that out against a real database.
--    A careless widening of booking_slots would undo 0023's revoke and hand the
--    public site INSERT on a tenant's clinic diary. This file touches NOTHING
--    in the `marketing` schema - there is not one `marketing.` reference below
--    this header.
--
-- 2. The funnel genuinely IS single-tenant and should stay so. `grep -c org_id`
--    on 0023 returns 0. Aura's own demo booking flow is not a customer's clinic
--    diary, and fusing them would couple a customer-facing feature to our own
--    sales site - every change to one becoming a change to the other.
--
-- ── WHAT CARRIED OVER ───────────────────────────────────────────────────────
--
--   · the slot/booking split, as `resources` (0165) + `appointments` here: a
--     test drive is OF a vehicle, a counselling call is of nothing, so the
--     resource is optional rather than the appointment being a row ON it;
--   · the reminder outbox KEYED ON THE BOOKING rather than on the person
--     (0053's reasoning holds exactly - see appointment_notifications below);
--   · the token shape (hash only, revocable, keyed on the booking);
--   · attendance, kept SEPARATE from status - 0053's finding;
--   · the no-show nurture drip, with the conversion gate re-checked at send
--     time rather than trusted from queue time;
--   · calendar-as-mirror: `calendar_event_id` / `calendar_error` from 0027, so
--     a tenant with no Google connection has a fully working diary.
--
-- ── WHAT WAS LEFT BEHIND, AND WHY ───────────────────────────────────────────
--
--   · `marketing.message_templates` and its seeded copy. A tenant's reminder
--     wording is theirs, and `public.message_templates` (0098) already holds
--     per-org bodies with Meta's approval state inline. Seeding our funnel's
--     prose into every tenant would put Aura's voice in a clinic's WhatsApp.
--   · the funnel's unapproved-testimonial nurture copy (0053's nurture_1/2/3
--     carry a ⚠ warning about wording the quoted customers never signed off).
--     Only the SHAPE of the drip is ported; not one word of it.
--   · `external_busy_at` (0030). That column exists because the funnel offers
--     slots to strangers and must stop offering an hour the team is busy for.
--     A tenant's diary is entered by the tenant, so the question does not
--     arise until there is a public booking page (a later wave).
--   · `booked_name` (0023). The funnel has no contact records; a tenant has
--     `leads` and `contacts`, so a denormalised name here would be a second
--     copy that goes stale the first time somebody fixes a spelling.
--
-- ── THE ONE REAL DIFFERENCE FROM 0053: reminder_sequence ────────────────────
--
-- 0053's outbox is unique on (booking_slot_id, template, channel) and that key
-- is the feature: it makes "never message the same person twice for the same
-- stage" a database guarantee while still allowing a SECOND 24h/1h/5m sequence
-- after a reschedule - because in the funnel a reschedule RELEASES one slot and
-- BOOKS ANOTHER, so the booking identity changes and the key is naturally
-- fresh.
--
-- A tenant appointment is rescheduled IN PLACE. The id does not change, so the
-- same key would make the second sequence ON CONFLICT DO NOTHING into oblivion
-- - the worst kind of bug, because it looks like the feature working. Hence
-- `appointments.reminder_sequence`, bumped by the reschedule path, and a
-- four-column unique key. This is the only place the port diverges from 0053,
-- and it diverges in order to preserve 0053's property rather than to change
-- it.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS appointments (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,

  -- Tenant-configured, same reasoning as `resources.resource_type` and the
  -- same shape rule: consultation, site_visit, test_drive, demo_class,
  -- counselling, survey, delivery, service. No CHECK on the VALUE - the ninth
  -- tenant must not need a migration to book a thing the list had not imagined.
  appointment_type text NOT NULL CHECK (appointment_type ~ '^[a-z][a-z0-9_]*$'),

  -- CASCADE on the lead, SET NULL on the contact: a lead IS the enquiry, so
  -- erasing it takes the appointment made about it, while a contact is a person
  -- who may be erased independently of a booking that still happened. 0023
  -- makes the same split for the same reason.
  lead_id    uuid REFERENCES leads(id)    ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Optional: a test drive is OF a vehicle; a counselling call is of nothing.
  resource_id uuid REFERENCES resources(id) ON DELETE SET NULL,

  -- The owner column. `appointment` is deliberately NOT in
  -- ALL_SCOPE_ONLY_OBJECTS: a telecaller scoped to `owned` should see their own
  -- diary and not the whole clinic's, and crm-scope.ts already points at this
  -- column. An UNASSIGNED appointment is therefore invisible to an owned-scoped
  -- role, which is the intended reading - a booking nobody has been given
  -- belongs to whoever can see all of them.
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  -- timestamptz, an absolute instant - never a naive `time`. 0023's own comment
  -- on this is the one to read: a wall-clock column breaks silently the first
  -- time the team travels or the server moves region. The console composes the
  -- instant from the org's zone (0132) and everything downstream compares
  -- instants.
  starts_at timestamptz NOT NULL,
  ends_at   timestamptz NOT NULL,
  location  text,
  meeting_url text,

  status    text NOT NULL DEFAULT 'scheduled' CHECK (status IN
              ('scheduled','confirmed','rescheduled','completed',
               'no_show','cancelled')),

  -- DELIBERATELY SEPARATE FROM status. 0053 learned that "did it happen" is a
  -- different question from "what state is the booking in", and conflating them
  -- makes no-show reporting unanswerable: a cancelled appointment is not a
  -- no-show, a completed one that nobody turned up to is, and a booking can sit
  -- in any status with attendance still unknown.
  --
  -- NULL = it has not happened yet, or it has and nobody has recorded the
  -- outcome. Recorded by a person from the console, so who and when are kept
  -- for the same reason 0053 keeps attendance_recorded_by/at.
  attended     boolean,
  attended_at  timestamptz,
  -- Nullable even when `attended_at` is set, unlike 0111's release-has-actor
  -- pair: the admin-key path has no `users` row and the FK would refuse the
  -- literal "admin-key". The audit_log row carries the actor in that case.
  attended_by  uuid REFERENCES users(id) ON DELETE SET NULL,

  outcome   text,
  -- Feedback capture is a form keyed to the appointment type, so one renderer
  -- serves a site-visit sheet, a post-consultation note and a test-drive form
  -- with no new UI (§25).
  feedback  jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- See the header. Bumped by the reschedule path; the outbox's unique key
  -- includes it so a moved appointment gets a FRESH reminder sequence instead
  -- of silently getting none.
  reminder_sequence int NOT NULL DEFAULT 1 CHECK (reminder_sequence > 0),

  -- Calendar as a MIRROR, not the source (0027). A tenant with no Google
  -- connection has a complete diary; `calendar_error` is why the mirror is
  -- behind, and is never a reason to refuse a booking.
  calendar_event_id text,
  calendar_error    text,

  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT appointments_ends_after_starts CHECK (ends_at > starts_at),
  -- An attendance verdict must know when it was recorded, and a recorded-at
  -- with no verdict is a half-written row. Same shape as 0023's
  -- booking_slots_booked_has_booker.
  CONSTRAINT appointments_attendance_recorded
    CHECK ((attended IS NULL) = (attended_at IS NULL))
);

-- The diary: "what is coming up", which is every console read of this table.
CREATE INDEX IF NOT EXISTS appointments_org_upcoming
  ON appointments (org_id, starts_at) WHERE status IN ('scheduled','confirmed');
CREATE INDEX IF NOT EXISTS appointments_resource
  ON appointments (resource_id, starts_at) WHERE resource_id IS NOT NULL;
-- The `owned` scope's predicate, and the lead/contact timelines. Each of these
-- is a column crm-scope.ts or a detail page filters on; an un-indexed one turns
-- a telecaller's own diary into a scan of the clinic's.
CREATE INDEX IF NOT EXISTS appointments_assigned
  ON appointments (org_id, assigned_user_id, starts_at) WHERE assigned_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS appointments_lead
  ON appointments (lead_id, starts_at) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS appointments_contact
  ON appointments (contact_id, starts_at) WHERE contact_id IS NOT NULL;
-- The no-show report, which is the pitch (§25): a dead chair nobody can resell.
CREATE INDEX IF NOT EXISTS appointments_attendance
  ON appointments (org_id, attended, starts_at) WHERE attended IS NOT NULL;

COMMENT ON TABLE appointments IS
  'A time-based commitment with a lifecycle (doc 39 §25): consultation, site visit, test drive, '
  'demo class, survey. Ported from the funnel''s booking_slots lifecycle (0023 + 0027/0029/0032/'
  '0047/0053) into tenant scope. That single-tenant table is NOT moved or widened - see this '
  'migration''s header for the public-web-role grant trap that makes widening it dangerous.';
COMMENT ON COLUMN appointments.attended IS
  'Deliberately separate from `status`. 0053: "did it happen" is a different question from '
  '"what state is the booking in", and conflating them makes no-show reporting unanswerable.';
COMMENT ON COLUMN appointments.reminder_sequence IS
  'Bumped on every reschedule. The funnel got a fresh reminder sequence for free because a '
  'reschedule there released one slot and booked another; an appointment moves in place, so the '
  'sequence has to be explicit or the second set of reminders ON CONFLICT DO NOTHING into nothing.';

DO $$ BEGIN
  CREATE TRIGGER appointments_set_updated_at BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- The reminder outbox - 0053's second outbox, ported
--
-- ── WHY AN OUTBOX AND NOT A SWEEP THAT ASKS "IS ANYTHING DUE SOON" ──────────
--
-- The obvious design is a sweep that runs every minute and asks "is any
-- appointment starting in roughly an hour". It is wrong in a way that only
-- shows up in production: "roughly" has to be a window, the window has to be at
-- least as wide as the sweep interval, and if the worker is down across that
-- window the reminder is lost forever with nothing recording that it was owed.
--
-- So the schedule lives in the ROW. The API notices a booking once, works out
-- the three instants from `starts_at`, and inserts rows already stamped with
-- them. A drain's ordinary `next_attempt_at <= now()` check then fires each one
-- at its hour - no window, no tolerance constant, and a worker down for six
-- hours sends what it owes on its next tick, subject to the overdue expiry that
-- stops a reminder arriving after the appointment it was reminding about.
--
-- Everything else is `marketing.booking_notifications` unchanged: the queue is
-- the table, attempts and exponential backoff, a terminal state, and a restart
-- loses nothing.
--
-- ── 'skipped' IS A FOURTH STATUS 0053 DID NOT HAVE ──────────────────────────
--
-- Taken from the attendance outbox (0140) rather than invented. A row held back
-- because a switch was off AT SEND TIME has not failed and must never be
-- retried - otherwise turning the switch on later releases a burst of stale
-- reminders for appointments that have already been and gone. 'dead' would
-- conflate "we gave up" with "we were told not to".
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS appointment_notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Redundant against appointment_id and required twice over: verify-rls.js's
  -- closure check wants every public table org-scoped, and the tenant's own
  -- reads run inside withOrg() where RLS needs a column on THIS table to filter
  -- on. `dnc_entries` and `recordings` carry both for the same two reasons.
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  -- The appointment's `reminder_sequence` at the moment this row was queued.
  -- See the file header.
  sequence       int  NOT NULL DEFAULT 1 CHECK (sequence > 0),

  -- The twin of `AppointmentNotificationTemplate` in
  -- packages/shared/src/appointments.ts. BOTH MOVE IN THE SAME COMMIT:
  -- a CHECK and a zod enum drift silently, in both directions, and the failure
  -- is a bare 23514 that reads like a bug in the caller. That has already
  -- happened on this codebase with `notifications.kind` - in both directions at
  -- once - and it broke lead routing while every typecheck stayed green.
  -- appointments.test.ts pins the two sets equal, once as a transcribed literal
  -- and once read out of this file, because those two fail in opposite
  -- directions.
  template       text NOT NULL CHECK (template IN (
                   'appointment_confirmed',
                   'appointment_reminder_24h',
                   'appointment_reminder_1h',
                   'appointment_reminder_5m',
                   'appointment_attended',
                   'appointment_no_show',
                   'appointment_nurture_1',
                   'appointment_nurture_2',
                   'appointment_nurture_3'
                 )),
  channel        text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'sent', 'dead', 'skipped')),
  attempts       int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- NULL = terminal, the same convention funnel_followups and
  -- booking_notifications use.
  next_attempt_at     timestamptz,
  last_attempt_at     timestamptz,
  error               text,
  provider_message_id text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Idempotent enqueue. Four columns rather than 0053's three - see the header on
-- `reminder_sequence`.
CREATE UNIQUE INDEX IF NOT EXISTS appointment_notifications_once
  ON appointment_notifications (appointment_id, sequence, template, channel);
CREATE INDEX IF NOT EXISTS appointment_notifications_due
  ON appointment_notifications (org_id, next_attempt_at)
  WHERE status = 'pending';

COMMENT ON TABLE appointment_notifications IS
  'Reminders, outcome messages and the no-show drip for an appointment (ported from '
  'the funnel''s booking_notifications, 0053). Keyed on the BOOKING and not the person: a '
  'rescheduled appointment needs a fresh sequence, so the person is the wrong key. '
  'NOTHING IN THIS TABLE SENDS BY ITSELF - see organizations.appointment_reminders_enabled.';

DO $$ BEGIN
  CREATE TRIGGER appointment_notifications_set_updated_at BEFORE UPDATE ON appointment_notifications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

------------------------------------------------------------------------------
-- The reschedule token - 0053's shape, unchanged
--
-- A table and not a signed URL, for 0033's two reasons: it is minted by one
-- process and verified by another (sharing a signing secret across both would
-- be a second copy of a security primitive), and it must be REVOCABLE - it
-- grants write access to somebody's place in a diary and it travels over
-- WhatsApp.
--
-- Only the hash is stored, for the reason a password hash is. Keyed on the
-- appointment, because a reschedule link is a link to move THIS booking.
--
-- ── DELIBERATELY NOT WIRED YET, AND THAT IS NOT AN OVERSIGHT ────────────────
--
-- Nothing in this wave mints or verifies one: both halves need a PUBLIC route
-- (an unauthenticated person following a link from a message), which belongs to
-- the portal shell in §17-§19 and brings a second RLS axis with it. The table
-- is created here rather than retrofitted because the reminder copy the drain
-- will render carries `{{reschedule_link}}`, and a token table added later
-- would mean a second migration against a live outbox.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS appointment_reschedule_tokens (
  token_hash     text PRIMARY KEY,
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointment_reschedule_tokens_appointment
  ON appointment_reschedule_tokens (appointment_id);

COMMENT ON TABLE appointment_reschedule_tokens IS
  'Bearer tokens for a self-service reschedule link (ported from the funnel''s reschedule_tokens, '
  '0053). Hash only, revocable, keyed on the appointment. Minting and verification arrive with '
  'the portal (doc 39 §17-§19); nothing writes this table today.';

------------------------------------------------------------------------------
-- The switch that keeps "nothing automated sends" true
--
-- A reminder for an appointment the CUSTOMER THEMSELVES booked is
-- customer-initiated and so sits on the safe side of this product's rule. That
-- is the argument §25 makes and it is a good one - but it is an argument about
-- a CLASS of message, and the person who gets to accept it is the owner of the
-- business whose number it goes out from, not this migration.
--
-- So: default FALSE. The outbox fills from the moment appointments exist (the
-- rows are a record of what is owed, which is useful on its own), and the drain
-- that will send them marks every row `skipped` until an owner turns this on.
-- 0033's lesson is the precedent - it shipped enabled once, and three real
-- people were messaged before the owner had read the wording.
--
-- Three further gates sit in front of a send and none of them is this column:
-- the deployment-wide WHATSAPP_SENDING_ENABLED, the opt-out check, and quiet
-- hours. See packages/shared/src/appointments.ts, which holds the predicate so
-- the console's preview and the drain cannot disagree about who is suppressed.
--
-- Added ahead of its consumer, exactly as 0157 added
-- `dialer_allows_unknown_consent`: the safe default has to be IN THE DATABASE
-- before the sender exists, or the sender's first deploy is the moment the
-- policy gets decided.
------------------------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS appointment_reminders_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN organizations.appointment_reminders_enabled IS
  'Owner-set: may queued appointment reminders actually be SENT (doc 39 §25). Default false - '
  'the outbox fills regardless, and every row is skipped until this is on. Not a replacement for '
  'the opt-out check or quiet hours, both of which apply on top.';

------------------------------------------------------------------------------
-- Row-level security and grants - the tenant pattern
--
-- All three tables are org-scoped, so verify-rls.js passes with no allowlist
-- entry. REVOKE BEFORE GRANT (0147, 0150, and the marketing-schema trap this
-- file's header opens with).
------------------------------------------------------------------------------

DO $$
DECLARE t text; api_role text;
BEGIN
  FOREACH t IN ARRAY ARRAY['appointments', 'appointment_notifications',
                           'appointment_reschedule_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    BEGIN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I
           USING (org_id = current_setting(''app.org_id'', true)::uuid)
           WITH CHECK (org_id = current_setting(''app.org_id'', true)::uuid)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    -- The partner wall, which 0163 CANNOT add for us: its enumeration runs once,
    -- at 0163, and these three tables did not exist yet. 0163's own closing
    -- assertion ("not three, not five") is correct and still passed, because it
    -- can only ask the catalog about the past.
    --
    -- This one matters more than most. Unwalled, a partner principal reads the
    -- tenant's entire diary - every patient, viewing and service slot - and
    -- `appointment_reschedule_tokens` is worse still: those are bearer tokens,
    -- so reading the table is the power to move somebody else's appointment.
    -- verify-rls.js now fails the deploy if an org-scoped table has no wall.
    BEGIN
      EXECUTE format(
        'CREATE POLICY partner_wall ON %I AS RESTRICTIVE
           USING (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)
           WITH CHECK (NULLIF(current_setting(''app.partner_id'', true), '''') IS NULL)', t);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'aura_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aura_app', t);
    END IF;
  END LOOP;
END $$;

------------------------------------------------------------------------------
-- Permission grants for `appointment`
--
-- `appointment` is already in `PermissionObjectType` and `CrmPermissionsGuard`
-- DENIES whatever it finds no grant for, so mounting the controller without
-- seeding these first would 403 every user in every tenant on the first
-- container restart. 0041 (`task`), 0059/0060, 0103 (`lead`) and 0158 (`dnc`)
-- each record this; it is skipped once per object because the enum is the easy
-- half.
--
-- ── SCOPE IS SEEDED 'all', INCLUDING FOR workspace_member ───────────────────
--
-- `appointment` is deliberately NOT in ALL_SCOPE_ONLY_OBJECTS: it carries
-- `assigned_user_id` and "my own diary" is the most meaningful scope on it. So
-- the temptation is to seed `workspace_member` at `owned` and be done.
--
-- That would be wrong on deploy day. A clinic receptionist and a coaching
-- centre's front desk are both `workspace_member`, and the whole of their job
-- is the WHOLE diary. Seeding `owned` would empty their screen the morning this
-- ships, with no error and nothing to click. 0103's rule applies exactly:
-- narrowing is a deliberate act by an owner on a screen that finally does
-- something, not a surprise delivered by a deploy. The `owned` switch is there,
-- wired, and one click away.
--
-- THERE IS NO `delete`. A booking is CANCELLED (`status = 'cancelled'`), which
-- is a fact about the customer's day worth keeping and the row the no-show
-- report counts against. Deleting one would make "how many did we lose last
-- month" unanswerable, which is the number this primitive exists to produce.

-- `appointment:view` - every system role including `viewer`. A diary is the
-- most ordinary read in a clinic or a coaching centre.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'appointment', 'view', 'all'
  FROM roles r
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin',
                 'workspace_member', 'viewer')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- `appointment:create` and `appointment:edit` - everybody except `viewer`.
-- Unlike `resource:create`, booking IS floor work: the telecaller on the phone
-- is the person who books the site visit, moves it when the customer asks, and
-- records that nobody turned up. A role that may view a diary but not write to
-- it is a role that cannot do the job this primitive exists for.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'appointment', a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('create'), ('edit')) AS a(action)
 WHERE r.is_system
   AND r.key IN ('platform_admin', 'org_admin', 'workspace_admin', 'workspace_member')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

------------------------------------------------------------------------------
-- Prove it, rather than assume it. Same block and same reasoning as 0165's.
------------------------------------------------------------------------------
DO $do$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
    FROM memberships m
    JOIN organizations o ON o.id = m.org_id AND 'crm' = ANY(o.enabled_modules)
   WHERE m.status = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM roles r
         JOIN role_permissions rp
           ON rp.role_id = r.id AND rp.object_type = 'appointment' AND rp.action = 'view'
        WHERE r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
     );

  IF stranded > 0 THEN
    RAISE WARNING '0166: % membership(s) resolve to no appointment:view grant (custom roles are not seeded) - grant it on Team & permissions', stranded;
  ELSE
    RAISE NOTICE '0166: every active CRM membership resolves to an appointment:view grant';
  END IF;
END $do$;
