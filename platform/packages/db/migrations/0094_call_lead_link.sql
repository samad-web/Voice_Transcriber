-- 0094_call_lead_link.sql - attach a call to the lead it was about.
--
-- ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────
--
-- `calls` has never pointed at `leads`. The link only ever ran the other way:
-- a lead records the call that CREATED it (leads.first_call_id, 0010). So a
-- lead that arrived from a web form, a Meta ad or an import has no connection
-- to the eleven times somebody rang it.
--
-- Three things were wrong because of that, and this file is the prerequisite
-- for all three:
--
--   1. Response time (0093) counts a lead as answered only when a human MOVES
--      ITS STAGE. A telecaller who rings a lead and does not touch the board -
--      which is most of them - reads as "never responded". 0093's own header
--      says so and exposes mark_lead_first_response() for exactly this.
--   2. A lead's page cannot show its calls, so the recording of the
--      conversation and the record of the customer are two separate products.
--   3. There is no way to ask "which calls went to nobody in the CRM", which
--      is the reconciliation queue the Hawcus teardown found (§3.5, gap G6):
--      Create / Link / Dismiss, with the outstanding count on the tab.
--
-- ── WHY THE MATCH IS EXACT RATHER THAN FUZZY ────────────────────────────────
--
-- `calls.remote_number_hash` and `leads.contact_number_hash` are the SAME
-- value: an HMAC of the counterparty number under the org's key (0001, 0006).
-- The full number is stored nowhere, so there is nothing to normalise, fuzzy
-- match or get subtly wrong - two rows are about the same person or they are
-- not. And leads_workspace_contact_hash is UNIQUE on
-- (workspace_id, contact_number_hash), so a hash matches at most one lead in a
-- workspace. The match is therefore a deterministic equijoin with no
-- tie-breaking rule to argue about, which is why this ships as a backfill plus
-- a sweep rather than as a scoring model.
--
-- The residue is genuinely ambiguous and stays a person's decision: a call
-- whose handset had no call-log permission has no hash at all (leads.ts
-- already handles that case for its own dedup), and a call to a number nobody
-- has ever qualified matches nothing. Those are the queue.
--
-- ── DISMISSAL IS A STATE, NOT A DELETION ────────────────────────────────────
--
-- Without a third verb the queue only ever grows: a wrong number, a personal
-- call and a supplier ringing back are all permanently unmatched and would sit
-- at the top of the list forever, which is how a work queue becomes wallpaper.
-- `lead_link_dismissed_at` takes them out of it while keeping the row and who
-- decided - the same reasoning call_crm_integrity_flags (0070) uses for its
-- own review queue.

-- ── The columns ─────────────────────────────────────────────────────────────
--
-- ON DELETE SET NULL, not CASCADE: the retention reaper removes calls on the
-- org's clock and a lead outlives its recordings (0010 makes the same choice
-- for first_call_id). Deleting a lead must not delete the call log.
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS lead_id                uuid REFERENCES leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_link_source       text,
  ADD COLUMN IF NOT EXISTS lead_linked_at         timestamptz,
  ADD COLUMN IF NOT EXISTS lead_link_dismissed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lead_link_dismissed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_link_dismiss_note text;

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_lead_link_source_check;
ALTER TABLE calls ADD CONSTRAINT calls_lead_link_source_check
  CHECK (lead_link_source IS NULL OR lead_link_source IN ('qualified', 'auto', 'console'));

COMMENT ON COLUMN calls.lead_link_source IS
  'How the link was made. qualified = this call is what produced the lead '
  '(leads.first_call_id/last_call_id). auto = exact hash match, made by the '
  'sweep. console = a person pressed Link or Create on the triage queue.';

-- A call is linked or it is dismissed. Both at once is not a state anybody can
-- describe, and it would let the same row appear in the queue and on a lead.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_lead_link_exclusive_check;
ALTER TABLE calls ADD CONSTRAINT calls_lead_link_exclusive_check
  CHECK (lead_id IS NULL OR lead_link_dismissed_at IS NULL);

-- ── An outbound call IS a response ──────────────────────────────────────────
--
-- The rule the reports needed, written once as a trigger so that every path
-- that links a call - the backfill below, the sweep, the console's Link and
-- Create buttons - produces the same answer without any of them remembering
-- to. mark_lead_first_response() (0093) is monotonic and idempotent, so a
-- re-link or a replayed backfill converges rather than drifting.
--
-- OUTGOING ONLY, and this is the whole distinction the report is about. A lead
-- that rings US has not been responded to - the customer chased. Counting an
-- inbound call as a response would make the worst-served leads, the ones that
-- had to call back, look like the fastest-answered.
--
-- A lead created BY an outbound call gets ~0 minutes, which is honest: the
-- arrival and the response were the same event. A lead created by an INBOUND
-- call gets nothing until somebody rings back, which is also honest.
CREATE OR REPLACE FUNCTION calls_mark_lead_first_response() RETURNS trigger AS $fn$
BEGIN
  IF NEW.lead_id IS NOT NULL
     AND NEW.direction = 'outgoing'
     AND (TG_OP = 'INSERT' OR OLD.lead_id IS DISTINCT FROM NEW.lead_id)
  THEN
    PERFORM mark_lead_first_response(NEW.lead_id, NEW.started_at);
  END IF;
  RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;

DO $do$ BEGIN
  CREATE TRIGGER calls_lead_link_marks_response
    AFTER INSERT OR UPDATE OF lead_id ON calls
    FOR EACH ROW EXECUTE FUNCTION calls_mark_lead_first_response();
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

-- ── Backfill 1: the links that already existed, in the other direction ──────
--
-- DISTINCT ON because a lead points at two calls (first and last) and both are
-- 'qualified'; the union would otherwise be free to produce either lead for a
-- call that two leads somehow both reference. Ordered so the outcome is
-- deterministic rather than whatever the planner returns first.
UPDATE calls c
   SET lead_id          = m.lead_id,
       lead_link_source = 'qualified',
       lead_linked_at   = c.started_at
  FROM (
    SELECT DISTINCT ON (call_id) call_id, lead_id
      FROM (
        SELECT first_call_id AS call_id, id AS lead_id, created_at FROM leads
         WHERE first_call_id IS NOT NULL
        UNION ALL
        SELECT last_call_id  AS call_id, id AS lead_id, created_at FROM leads
         WHERE last_call_id IS NOT NULL
      ) s
     ORDER BY call_id, created_at ASC
  ) m
 WHERE c.id = m.call_id
   AND c.lead_id IS NULL;

-- ── Backfill 2: every other call, by exact hash ─────────────────────────────
--
-- Joined on workspace_id and not merely org_id: the hash is unique per
-- WORKSPACE (leads_workspace_contact_hash), and two workspaces in one org are
-- two separate books of business. Matching across them would put another
-- team's calls on this team's lead.
UPDATE calls c
   SET lead_id          = l.id,
       lead_link_source = 'auto',
       lead_linked_at   = now()
  FROM leads l
 WHERE c.lead_id IS NULL
   AND c.lead_link_dismissed_at IS NULL
   AND c.remote_number_hash IS NOT NULL
   AND l.workspace_id        = c.workspace_id
   AND l.contact_number_hash = c.remote_number_hash;

-- ── Backfill 3: the response times those links now make knowable ────────────
--
-- The trigger above fires per row on UPDATE OF lead_id, so backfills 1 and 2
-- have in fact already marked these. This statement is the set-based
-- equivalent, kept deliberately: it is the same shape 0093 used for stage
-- moves, it is idempotent, and it makes the report's whole input legible to
-- someone reading this file instead of hiding it inside a trigger.
UPDATE leads l
   SET first_responded_at = t.first_outbound
  FROM (
    SELECT lead_id, min(started_at) AS first_outbound
      FROM calls
     WHERE lead_id IS NOT NULL AND direction = 'outgoing'
     GROUP BY lead_id
  ) t
 WHERE l.id = t.lead_id
   AND t.first_outbound >= l.created_at
   AND (l.first_responded_at IS NULL OR l.first_responded_at > t.first_outbound);

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- "This lead's calls", newest first - the lead page's own query.
CREATE INDEX IF NOT EXISTS calls_lead_started
  ON calls (org_id, lead_id, started_at DESC) WHERE lead_id IS NOT NULL;

-- The triage queue. Partial, because the answer should shrink as people work
-- it: an index over every call would be the table.
CREATE INDEX IF NOT EXISTS calls_org_unlinked
  ON calls (org_id, started_at DESC)
  WHERE lead_id IS NULL AND lead_link_dismissed_at IS NULL;

-- The sweep's own scan: unlinked, undismissed, and actually matchable.
CREATE INDEX IF NOT EXISTS calls_unlinked_hash
  ON calls (workspace_id, remote_number_hash)
  WHERE lead_id IS NULL AND lead_link_dismissed_at IS NULL AND remote_number_hash IS NOT NULL;
