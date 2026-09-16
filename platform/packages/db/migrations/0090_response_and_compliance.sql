-- 0090_response_and_compliance.sql - how fast the floor reacts, and whether it
-- keeps the promises it made. Tier 1 of the Hawcus gap analysis (Build docs/
-- 21_HAWCUS_CRM_GAP_ANALYSIS.md, gaps G1-G3).
--
-- ── WHY THIS IS ONE MIGRATION AND MOSTLY NOT A SCHEMA CHANGE ────────────────
--
-- Three reports come out of this: lead response time, follow-up compliance,
-- and lead aging. Two of them need NOTHING new - `tasks` already carries
-- due_on/status/completed_at/assignee_user_id, and `leads` already carries
-- created_at. They are queries, and they live in reports.service.ts.
--
-- Exactly one number cannot be derived from what we store: WHEN somebody first
-- responded to a lead. `leads.last_activity_at` is overwritten on every touch,
-- so by the time you ask, the first touch is gone. That is the single column
-- below, plus the trigger that maintains it and a backfill that recovers the
-- history we can still see.
--
-- ── WHAT first_responded_at MEANS, AND WHAT IT DOES NOT ─────────────────────
--
-- It is the first HUMAN touch on the lead after it arrived. Today the only
-- touch that is recorded against a lead with a real foreign key is a row in
-- `lead_stage_transitions`, so that is what feeds it.
--
-- Sources 'console' and 'device' count; 'automation', 'pipeline', 'reshape'
-- and 'backfill' do not. That split is not new here - 0078 already wrote it
-- down on the `source` column: "`device` ranks with `console`, NOT with
-- `automation`: a telecaller on a phone is a human". A response-time report
-- that counted an automation moving a card would report that the floor
-- answered instantly while nobody had picked up the phone.
--
-- THE HONEST LIMITATION, stated here because the number is about to appear on
-- a manager's screen next to a person's name: a telecaller who RINGS a lead
-- and does not move its stage is not captured. `calls` has no lead_id (the
-- link runs the other way, leads.first_call_id), so there is no join to make.
-- Closing that means having the worker's lead upsert call
-- mark_lead_first_response() when it attaches an outbound call - which is why
-- the logic below is a callable FUNCTION and not inlined in the trigger.
-- Until then the metric under-reports responsiveness; it never over-reports
-- it, which is the safer direction for a coaching number.
--
-- ── PER-STAFF MEANS TWO DIFFERENT STAFF ─────────────────────────────────────
--
-- Not enforced by this file, but it governs the reports that read it, and
-- reports.service.ts already documents the trap: a lead is assigned to a
-- `telecallers` row, a task is assigned to a `users` row, and nothing maps
-- between them. So response time breaks down by TELECALLER and follow-up
-- compliance breaks down by USER, and the two are never joined into one
-- "staff scorecard" row. An invented mapping would put one person's calls
-- next to another person's tasks.

-- ── The column ──────────────────────────────────────────────────────────────
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS first_responded_at timestamptz;

COMMENT ON COLUMN leads.first_responded_at IS
  'First human touch after the lead arrived (console/device stage move, or an '
  'outbound call once the worker calls mark_lead_first_response). NULL means '
  'nobody has worked this lead yet - which is the point of the column.';

-- ── The write path, as a function so more than the trigger can use it ───────
--
-- Monotonic and idempotent: it only ever moves the timestamp EARLIER, so
-- replaying history in any order converges on the same answer, and a backfill
-- cannot make a lead look slower than it was. The WHERE clause does the
-- comparison rather than a LEAST() over the whole table so that a re-run
-- updates nothing and takes no row locks.
CREATE OR REPLACE FUNCTION mark_lead_first_response(p_lead_id uuid, p_at timestamptz)
RETURNS void AS $$
BEGIN
  IF p_lead_id IS NULL OR p_at IS NULL THEN RETURN; END IF;
  UPDATE leads
     SET first_responded_at = p_at
   WHERE id = p_lead_id
     AND (first_responded_at IS NULL OR first_responded_at > p_at)
     -- Never before the lead existed. A clock-skewed device or a backdated
     -- import would otherwise produce a negative response time, and "-3
     -- minutes" on a report is worse than no number at all.
     AND p_at >= created_at;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION leads_first_response_from_transition() RETURNS trigger AS $$
BEGIN
  -- See the header: only a human's move is a response.
  IF NEW.source IN ('console', 'device') THEN
    PERFORM mark_lead_first_response(NEW.lead_id, NEW.occurred_at);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER lead_stage_transitions_mark_response
    AFTER INSERT ON lead_stage_transitions
    FOR EACH ROW EXECUTE FUNCTION leads_first_response_from_transition();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Backfill from the history we already have ───────────────────────────────
--
-- Every human stage move ever recorded, oldest first, per lead. Without this
-- the report reads "no data" for every lead created before today, and a
-- reporting surface that starts empty gets read as "we have never responded to
-- anyone" on the day it ships.
--
-- Written as one set-based UPDATE rather than a loop over
-- mark_lead_first_response(): the function's guard is per-row, and at backfill
-- size that is a round trip per lead.
UPDATE leads l
   SET first_responded_at = t.first_human_touch
  FROM (
    SELECT lead_id, min(occurred_at) AS first_human_touch
      FROM lead_stage_transitions
     WHERE source IN ('console', 'device')
     GROUP BY lead_id
  ) t
 WHERE l.id = t.lead_id
   AND t.first_human_touch >= l.created_at
   AND (l.first_responded_at IS NULL OR l.first_responded_at > t.first_human_touch);

-- ── Indexes for the three reports ───────────────────────────────────────────
--
-- Aging and response time both scan "this org's leads by when they arrived",
-- which is the same access path; one index serves both. Not partial on
-- status: the aging report deliberately counts won and lost leads too, so a
-- WHERE status = 'open' index would send the planner back to a seq scan for
-- half the page.
CREATE INDEX IF NOT EXISTS leads_org_created_at ON leads (org_id, created_at);

-- "Who has NOBODY touched yet" - the queue the response-time page exists to
-- empty, and the one query where a partial index earns its keep, because the
-- answer should be a small slice of a large table.
CREATE INDEX IF NOT EXISTS leads_org_unresponded
  ON leads (org_id, created_at)
  WHERE first_responded_at IS NULL AND status = 'open';

-- Compliance reads every task in a date window regardless of status, so the
-- existing `tasks_org_due` (partial on status = 'open') cannot serve it.
CREATE INDEX IF NOT EXISTS tasks_org_due_all
  ON tasks (org_id, due_on) WHERE due_on IS NOT NULL;
