------------------------------------------------------------------------------
-- 0024 - the follow-up outbox, and rejecting a lead
--
-- TWO THINGS THAT BELONG TOGETHER
--
-- Rejecting a lead is not just a status change: the point of pressing the
-- button is that the person hears back. So this adds the rejection state AND
-- the outbox row that carries the message, in one migration, because either
-- alone is half a feature.
--
-- ── The outbox ─────────────────────────────────────────────────────────────
--
-- apps/worker/src/pipeline/funnel-followup-outbox.ts has been written against
-- this table since slice 4 and has been no-oping ever since, guarded by a
-- `to_regclass` check, because the table lived only as a comment in that file.
-- The DDL below is that comment, VERBATIM apart from the added template - the
-- module says "it must land verbatim, or this must be updated to match", and
-- the drain re-checks for the table every tick, so it starts working the
-- moment this runs. No restart.
------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS marketing.funnel_followups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id       uuid NOT NULL
                      REFERENCES marketing.funnel_submissions(id) ON DELETE CASCADE,
  template            text NOT NULL
                      CHECK (template IN ('disqualified_neutral', 'custom_crm_info', 'rejected')),
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sent', 'dead')),
  attempts            int  NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,      -- NULL = terminal, mirrors crm_sync_log
  last_attempt_at     timestamptz,
  error               text,
  provider_message_id text,             -- 'log-only:...' when nothing was sent
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One follow-up of each kind per person, ever. The funnel dedupes repeat
-- submitters onto a single submission row, and a third form fill must not
-- produce a third identical email.
CREATE UNIQUE INDEX IF NOT EXISTS funnel_followups_once
  ON marketing.funnel_followups (submission_id, template);

CREATE INDEX IF NOT EXISTS funnel_followups_due
  ON marketing.funnel_followups (status, next_attempt_at)
  WHERE status = 'pending';

------------------------------------------------------------------------------
-- Rejection
--
-- A separate state from 'disqualified'. They are not the same thing and
-- collapsing them would destroy the distinction that matters:
--
--   disqualified  the FUNNEL's automatic answer from the budget/intent rules.
--                 Nobody looked at it. The person may still be worth a call.
--   rejected      a HUMAN looked at this lead and decided no.
--
-- Reporting "how many did the qualifier get wrong" needs both, and a single
-- flag cannot answer it.
------------------------------------------------------------------------------

ALTER TABLE marketing.funnel_submissions
  ADD COLUMN IF NOT EXISTS rejected_at     timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by     text,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

ALTER TABLE marketing.funnel_submissions
  DROP CONSTRAINT IF EXISTS funnel_submissions_status_check;

ALTER TABLE marketing.funnel_submissions
  ADD CONSTRAINT funnel_submissions_status_check
  CHECK (status IN ('contact_captured', 'qualified', 'disqualified', 'converted', 'rejected'));

------------------------------------------------------------------------------
-- Grants
--
-- apps/api and apps/worker both reach this schema through the admin pool, which
-- connects as the role that OWNS it, so no grant is needed for either.
--
-- `aura_marketing` - the public website - is given NOTHING on funnel_followups.
-- 0020 set ALTER DEFAULT PRIVILEGES granting SELECT/INSERT/UPDATE on future
-- tables in this schema, so it would otherwise inherit all three, and a public
-- unauthenticated server that can INSERT into an outbox is a public server that
-- can make the platform send mail to an address of its choosing.
------------------------------------------------------------------------------

REVOKE ALL ON marketing.funnel_followups FROM aura_marketing;

DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON marketing.funnel_followups FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
