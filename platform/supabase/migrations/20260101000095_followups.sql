-- 0095_followups.sql - turn a task into a promise to contact somebody.
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────
--
-- `tasks` (0041) is generic work: it hangs off a contact, an account or a
-- deal, and "prepare Monday's pipeline review" is a legitimate row. The
-- Hawcus teardown found the other thing (§3.2), and it is the single most
-- operationally-loaded object in that product: a FOLLOW-UP, meaning a promise
-- to contact THIS LEAD at THIS TIME, with a compliance report over whether the
-- promise was kept.
--
-- Three gaps stopped Aura expressing that, and this file closes all three:
--
--   1. No `lead_id`. The board is `leads`; the work list is `tasks`; nothing
--      joined them. A telecaller could not say "ring Priya back on Thursday"
--      against the lead they were looking at.
--   2. No time of day. `due_on` is a date, deliberately - 0041 argues that a
--      timestamp makes "overdue" depend on the reader's timezone, which was
--      right. But "call him at 3" is the actual promise on a telecalling
--      floor, and a date cannot hold it.
--   3. No `completed_by`. Whoever ticks a follow-up off is not necessarily
--      whoever owed it, and a compliance report that cannot tell them apart
--      credits the wrong person.
--
-- ── WHY due_on SURVIVES RATHER THAN BEING REPLACED ──────────────────────────
--
-- The obvious change is `due_on date` -> `due_at timestamptz`. It is wrong for
-- the reason 0041 already gave: "due Thursday" is what people mean most of the
-- time, and storing that as an instant forces a fake time-of-day that then
-- decides whether the task is late.
--
-- So both, with one authority: `due_at` is optional, and WHEN IT IS SET,
-- `due_on` is derived from it in the org's own reporting timezone. There is
-- exactly one source of truth for the day, and every query that already
-- filters on `due_on` - the compliance report (0093), the overdue count, the
-- tasks list - keeps working unchanged and gets the time for free.
--
-- ── THE TIMEZONE BUG THIS ALSO FIXES ────────────────────────────────────────
--
-- `tasks.controller.ts` computes overdue as `due_on < current_date`, which is
-- the DATABASE's date - UTC on this deployment. An Indian floor is UTC+5:30,
-- so between midnight and 05:30 IST the database still reads yesterday, and a
-- follow-up that went late at midnight is not reported late until half past
-- five in the morning. `org_reporting_today()` below is the fix, and it takes
-- no argument because RLS has already told the session which org it is.

-- ── Today, in the org's own timezone ────────────────────────────────────────
--
-- STABLE, so the planner evaluates it once per statement rather than per row -
-- which matters, because it is going into a WHERE clause over a whole table.
--
-- Reads `app.org_id` rather than taking an argument for two reasons: every
-- caller is already inside `withOrgContext` (RLS would reject it otherwise),
-- and a function taking an org id could be called with SOMEBODY ELSE'S org id
-- from inside a query the policy has already admitted. There is nothing here
-- to leak - a date is not tenant data - but a helper that quietly accepts a
-- foreign tenant's parameter is a shape worth not having.
--
-- Falls back to the deployment default when unset, so a superuser session or a
-- migration running outside org context gets a date rather than an error.
CREATE OR REPLACE FUNCTION org_reporting_today() RETURNS date AS $fn$
  SELECT (now() AT TIME ZONE COALESCE(
           (SELECT o.reporting_timezone
              FROM organizations o
             WHERE o.id = NULLIF(current_setting('app.org_id', true), '')::uuid),
           'Asia/Kolkata'
         ))::date;
$fn$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION org_reporting_today() IS
  'Today''s date in the current org''s reporting_timezone (0090). Use this and '
  'never current_date for anything a person reads as "today": the database '
  'runs in UTC and an Indian floor is five and a half hours ahead of it.';

-- ── The columns ─────────────────────────────────────────────────────────────
ALTER TABLE tasks
  -- CASCADE, matching the contact/account/deal links beside it: a follow-up is
  -- about the lead and means nothing once the lead is gone. Unlike
  -- calls.lead_id (0094), which is SET NULL, because a call happened whether
  -- or not the lead survives.
  ADD COLUMN IF NOT EXISTS lead_id          uuid REFERENCES leads(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS due_at           timestamptz,
  ADD COLUMN IF NOT EXISTS completed_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The escalation counter. Incremented by the reminder sweep, never reset:
  -- "we have told them four times" is the fact a manager needs, and zeroing it
  -- on completion would erase the only evidence that it took four.
  ADD COLUMN IF NOT EXISTS reminders_sent   int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz;

COMMENT ON COLUMN tasks.due_at IS
  'The promised time, when there is one. NULL means the promise is a day, not '
  'an hour. When set it is authoritative and due_on is derived from it in the '
  'org''s reporting timezone - never write both by hand.';

COMMENT ON COLUMN tasks.completed_by IS
  'Who ticked it off, which is not always who owed it. NULL on every row that '
  'predates this migration: that information was never recorded and inventing '
  'it from assignee_user_id would put a name on work nobody can show was done '
  'by that person.';

-- ── due_on follows due_at ───────────────────────────────────────────────────
--
-- A trigger and not a generated column, because the conversion needs the org's
-- timezone, and a GENERATED column may only use immutable expressions of the
-- row itself. It fires BEFORE so the derived value is what gets stored and
-- indexed, rather than something a later reader has to recompute.
--
-- Deliberately one-directional: setting `due_on` alone does not invent a
-- `due_at`. "Thursday" genuinely has no time, and manufacturing 00:00 would
-- make every dateless follow-up look like it was due at midnight.
CREATE OR REPLACE FUNCTION tasks_derive_due_on() RETURNS trigger AS $fn$
DECLARE
  tz text;
BEGIN
  IF NEW.due_at IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT reporting_timezone INTO tz FROM organizations WHERE id = NEW.org_id;
  NEW.due_on := (NEW.due_at AT TIME ZONE COALESCE(tz, 'Asia/Kolkata'))::date;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DO $do$ BEGIN
  CREATE TRIGGER tasks_due_on_from_due_at
    BEFORE INSERT OR UPDATE OF due_at, due_on ON tasks
    FOR EACH ROW EXECUTE FUNCTION tasks_derive_due_on();
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

-- ── Consistency, enforced rather than hoped for ─────────────────────────────
--
-- A completed task has a completion time. Nothing before this migration could
-- violate it (the controller writes both together) and nothing after it can
-- either, which is what makes `completed_at > due_on` - the "closed it, but
-- late" number on the compliance report - trustworthy rather than a heuristic
-- over rows that might be missing the timestamp.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_done_has_completed_at_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_done_has_completed_at_check
  CHECK (status <> 'done' OR completed_at IS NOT NULL) NOT VALID;

-- NOT VALID, then validated: an existing row with status='done' and a null
-- completed_at would abort the whole migration, and there is no honest value
-- to backfill it with. VALIDATE takes a SHARE UPDATE EXCLUSIVE lock rather
-- than blocking writes, and raises loudly if such a row exists, which is the
-- point - it should be looked at, not papered over.
DO $do$ BEGIN
  ALTER TABLE tasks VALIDATE CONSTRAINT tasks_done_has_completed_at_check;
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'tasks: % row(s) are done with no completed_at; constraint left NOT VALID',
    (SELECT count(*) FROM tasks WHERE status = 'done' AND completed_at IS NULL);
END $do$;

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- "This lead's follow-ups" - the lead page's query, and the board's badge.
CREATE INDEX IF NOT EXISTS tasks_org_lead
  ON tasks (org_id, lead_id, due_on) WHERE lead_id IS NOT NULL;

-- The five tab counts are all (status, due_on) slices of the same scan.
CREATE INDEX IF NOT EXISTS tasks_org_status_due
  ON tasks (org_id, status, due_on);

-- The reminder sweep's own row set: open, dated, and not yet nagged today.
CREATE INDEX IF NOT EXISTS tasks_reminder_due
  ON tasks (org_id, due_on)
  WHERE status = 'open' AND due_on IS NOT NULL;
