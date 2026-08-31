-- 0058_outreach_cadences.sql - the follow-up ladder.
--
-- ── WHAT THIS IS FOR ────────────────────────────────────────────────────
--
-- "Message them within five minutes. Call an hour later. If they still have
-- not booked by the afternoon, message again, then stop." Every sales team
-- runs some version of that, and until now Aura had nowhere to put it:
-- `tasks` holds one follow-up with one due date, and `automation_rules` fire
-- once on an event. Neither models a SEQUENCE with a stopping condition.
--
-- ── HOW THIS DIFFERS FROM THE SCHEMA IT IS BORROWED FROM ────────────────
--
-- B2 Consultants' outreach ladder is the direct ancestor: a journey row with
-- a phase, a per-step ledger, a unique key stopping a step firing twice. Two
-- things are deliberately NOT copied.
--
-- 1. THEIR STEPS ARE AN ENUM. `OutreachStep` there names 23 specific steps -
--    INTRO_WHATSAPP, DISCO_CONFIRM_1, SSS_CANCEL - because that schema serves
--    one business running one SOP. Aura is multi-tenant, and baking one
--    tenant's process into a CHECK constraint would make every other tenant's
--    cadence a migration. So the steps are ROWS a tenant defines.
--
-- 2. THEIR LADDER SENDS. Each step there dispatches a WhatsApp message on a
--    timer. Aura's third safety rule is that nothing automated can send, and
--    this migration does not weaken it: a step here becomes DUE WORK FOR A
--    PERSON. The sweep moves a step from 'waiting' to 'due' and stops. What
--    happens next is somebody opening the console and acting, exactly as with
--    a task. There is no dispatcher, no outbox, no send column.
--
-- ── WHY A SEPARATE LEDGER RATHER THAN JUST CREATING TASKS ───────────────
--
-- Because the ladder has to be able to STOP. The whole value of a cadence is
-- "chase until they book, then stop chasing" - and a fistful of independent
-- task rows cannot be stopped as a unit, cannot tell you which attempt this
-- is, and cannot answer "how far down the ladder do people usually get".

-- ── the template ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_cadences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,

  -- What ends a journey early, checked by the sweep before it advances.
  -- 'booked'    - the contact has a held booking slot
  -- 'replied'   - an inbound message arrived (migration 0055)
  -- 'won'       - a deal for this contact reached a won status
  -- 'none'      - runs to the end regardless
  -- App-validated against a shared zod enum rather than a CHECK, so adding a
  -- condition is a release rather than a migration - the same call 0049 made
  -- for automation triggers.
  stop_on     text NOT NULL DEFAULT 'booked',

  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS outreach_cadences_org_name_unique
  ON outreach_cadences (org_id, lower(btrim(name)));

ALTER TABLE outreach_cadences ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_cadences FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON outreach_cadences
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_cadences TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON outreach_cadences FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON outreach_cadences FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER outreach_cadences_set_updated_at BEFORE UPDATE ON outreach_cadences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the steps of the template ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_cadence_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  cadence_id  uuid NOT NULL REFERENCES outreach_cadences(id) ON DELETE CASCADE,

  -- Position in the ladder, 0-based. UNIQUE per cadence so two steps cannot
  -- claim the same rung and leave the order undefined.
  step_index  int  NOT NULL CHECK (step_index >= 0),
  label       text NOT NULL CHECK (length(btrim(label)) > 0),
  -- What the person should do: 'call' | 'whatsapp' | 'email' | 'other'.
  channel     text NOT NULL DEFAULT 'call',

  -- Hours after the JOURNEY STARTED, not after the previous step. Anchoring
  -- to the start is what makes the schedule stable: if somebody acts on step
  -- 2 three days late, steps 3 and 4 do not slide three days with it - they
  -- were due relative to the enquiry, and being late does not move the
  -- enquiry.
  delay_hours numeric(8, 2) NOT NULL DEFAULT 0 CHECK (delay_hours >= 0),

  -- Guidance shown next to the due item. Not a template to send - see header.
  guidance    text,

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outreach_cadence_steps_order UNIQUE (cadence_id, step_index)
);

CREATE INDEX IF NOT EXISTS outreach_cadence_steps_cadence
  ON outreach_cadence_steps (cadence_id, step_index);

ALTER TABLE outreach_cadence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_cadence_steps FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON outreach_cadence_steps
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_cadence_steps TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON outreach_cadence_steps FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON outreach_cadence_steps FROM PUBLIC;

-- ── an enrolment ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_journeys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  cadence_id   uuid NOT NULL REFERENCES outreach_cadences(id) ON DELETE CASCADE,

  -- CASCADE: a journey is chasing a person, and has no meaning once that
  -- person's record is gone. Unlike merge_log this is not an audit trail.
  contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id      uuid REFERENCES deals(id) ON DELETE SET NULL,

  -- Who is doing the chasing. Steps inherit it as their default owner.
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'completed', 'stopped')),
  -- Why it ended. Free text from a small set the app writes ('booked',
  -- 'replied', 'won', 'finished', 'stopped by <user>') - kept readable
  -- because the answer to "why did we stop chasing them" is usually being
  -- read by a person, not a query.
  stop_reason  text,

  -- The clock every step's delay_hours is measured from.
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One ACTIVE journey per contact per cadence. A partial unique index rather
-- than a plain one, so the same person can be run through the same cadence
-- again next quarter - but cannot be enrolled twice at once and receive every
-- step in duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_journeys_one_active
  ON outreach_journeys (contact_id, cadence_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS outreach_journeys_active
  ON outreach_journeys (org_id, status, started_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS outreach_journeys_contact
  ON outreach_journeys (contact_id);

ALTER TABLE outreach_journeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_journeys FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON outreach_journeys
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_journeys TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON outreach_journeys FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON outreach_journeys FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER outreach_journeys_set_updated_at BEFORE UPDATE ON outreach_journeys
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── the ledger ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_journey_steps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  journey_id  uuid NOT NULL REFERENCES outreach_journeys(id) ON DELETE CASCADE,

  -- SET NULL, not CASCADE: editing a cadence must not erase the record of
  -- what was actually done to somebody under the old version of it.
  cadence_step_id uuid REFERENCES outreach_cadence_steps(id) ON DELETE SET NULL,

  -- Denormalised from the cadence step AT ENROLMENT. The whole point: a
  -- cadence edited next month must not rewrite what step 2 said when this
  -- person was being chased. Same reasoning funnel_submissions.consent_text
  -- uses for consent wording.
  step_index  int  NOT NULL CHECK (step_index >= 0),
  label       text NOT NULL,
  channel     text NOT NULL DEFAULT 'call',
  guidance    text,

  status      text NOT NULL DEFAULT 'waiting'
              CHECK (status IN ('waiting', 'due', 'done', 'skipped', 'cancelled')),

  due_at      timestamptz NOT NULL,
  acted_at    timestamptz,
  acted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  -- What happened: "no answer", "asked to call Friday". The outcome of a
  -- chase is the part worth reading later.
  note        text,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- The double-fire guard, and the reason this table exists rather than a
  -- pile of tasks: one row per rung per journey, enforced by the database.
  CONSTRAINT outreach_journey_steps_once UNIQUE (journey_id, step_index)
);

-- "What is due right now, oldest first" - the sweep's query and the console's.
CREATE INDEX IF NOT EXISTS outreach_journey_steps_due
  ON outreach_journey_steps (org_id, due_at) WHERE status IN ('waiting', 'due');
CREATE INDEX IF NOT EXISTS outreach_journey_steps_journey
  ON outreach_journey_steps (journey_id, step_index);

ALTER TABLE outreach_journey_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_journey_steps FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON outreach_journey_steps
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON outreach_journey_steps TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON outreach_journey_steps FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON outreach_journey_steps FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER outreach_journey_steps_set_updated_at BEFORE UPDATE ON outreach_journey_steps
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
