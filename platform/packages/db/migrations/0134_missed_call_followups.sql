-- 0134_missed_call_followups.sql - the four things 0133 left as follow-ups.
--
-- ── WHAT THIS ADDS, AND WHY IT IS ONE FILE ──────────────────────────────────
--
-- 0133 made a missed call a real row and deliberately stopped at the edge of
-- the CRM: an unknown caller sat in the triage queue for a person to act on,
-- nothing told anybody a known customer had gone unanswered, and an outbound
-- attempt that rang out left no trace at all. All three are the same shape of
-- gap - a call happened and the pipeline did not react to it - so they are one
-- migration rather than three, in the order the worker will apply them.
--
--   1. Outbound attempts. `calls_missed_reason_shape_check` only ever allowed
--      an INCOMING zero-duration NO_AUDIO row. A telecaller who dials a lead
--      and nobody picks up produces exactly that shape in the other
--      direction, and it was invisible - not billed, not queued (both already
--      true of NO_AUDIO), but also not distinguishable from a call that simply
--      never got made. 'no_answer' is the one new reason, scoped to outgoing
--      the same way unanswered/declined/voicemail are scoped to incoming.
--   2. A notification kind so a missed call can tell somebody: 'missed_call'.
--   3. 'missed_call' joins `source_channel`'s vocabulary, so a lead the worker
--      creates from an unknown missed caller can say where it came from - the
--      same closed list 0078 gave 'call' for the triage queue's Create button.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
--
-- It does not add a pipeline stage. Three independent places already decide
-- where a call-sourced lead lands - upsertLead (leads.ts), the triage queue's
-- createLead, and the intake engine's ingestIntakeLead - and all three call
-- entryStage(lead_stages) rather than naming one of their own, because
-- lead_stages is tenant data (0010) and STAGE_PACKS.ts is explicit that the
-- column names are "a moment somebody would describe out loud", not a
-- vocabulary this platform gets to impose on every business it runs for. A
-- missed-call lead gets the same treatment: entryStage, plus temperature =
-- 'hot' (0083) and a due-today task, which is how this codebase already makes
-- a card stand out inside whatever column it lands in without touching the
-- board's own shape.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_missed_reason_check;
ALTER TABLE calls ADD CONSTRAINT calls_missed_reason_check
  CHECK (missed_reason IS NULL
         OR missed_reason IN ('unanswered', 'declined', 'voicemail', 'no_answer'));

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_missed_reason_shape_check;
ALTER TABLE calls ADD CONSTRAINT calls_missed_reason_shape_check
  CHECK (missed_reason IS NULL
         OR (duration_s = 0 AND status = 'NO_AUDIO'
             AND ((direction = 'incoming' AND missed_reason IN ('unanswered', 'declined', 'voicemail'))
                  OR (direction = 'outgoing' AND missed_reason = 'no_answer'))));

-- ── The notification ─────────────────────────────────────────────────────────
--
-- Name-agnostic drop, same reasoning 0080/0096 already applied to
-- source_channel: this CHECK has been renamed once already (0111) and finding
-- it by the column it constrains works regardless of what it is called today.
DO $do$
DECLARE con text;
BEGIN
  SELECT c.conname INTO con
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
   WHERE t.relname = 'notifications' AND c.contype = 'c' AND a.attname = 'kind'
     AND c.conkey = ARRAY[a.attnum];
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', con);
  END IF;
END $do$;

ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'task_due', 'deal_stage_changed', 'deal_idle',
                  'automation', 'report_ready', 'lead_assigned',
                  'opt_out_requested', 'channel_needs_attention',
                  'sla_breach', 'review_pending',
                  'call_access_requested',
                  'storage_quota',
                  -- 0134: a missed call reached an existing lead's owner, or
                  -- was the callback task on one the worker just created.
                  'missed_call'));

-- ── source_channel ───────────────────────────────────────────────────────────
--
-- Not reusing 'call': that value already means "a person pressed Create Lead
-- on the triage queue" (call-triage.controller.ts), and a report asking "how
-- much business did we nearly lose to missed calls" needs to tell the two
-- apart from a person who created leads by hand.
DO $do$
DECLARE
  tbl text;
  con text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['leads', 'contacts', 'deals'] LOOP
    FOR con IN
      SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
       WHERE t.relname = tbl
         AND c.contype = 'c'
         AND a.attname = 'source_channel'
         AND c.conkey = ARRAY[a.attnum]
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, con);
    END LOOP;
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (source_channel IN (
         ''call'', ''web_form'', ''email'', ''telephony'', ''meta_ads'',
         ''linkedin_ads'', ''whatsapp'', ''sheets'', ''api'', ''import'',
         ''manual'', ''missed_call''))',
      tbl, tbl || '_source_channel_check');
  END LOOP;
END $do$;

-- ── Index: leads created from a missed call that has not been worked yet ────
--
-- The worker's sweep (missed-call-leads.ts) re-derives this same predicate
-- every tick to find what it has not yet handled, and the leads list joins on
-- calls.lead_id per row for the "Callback" column - both partial scans over an
-- otherwise-full table without this.
CREATE INDEX IF NOT EXISTS calls_org_missed_unlinked
  ON calls (org_id, started_at ASC)
  WHERE direction = 'incoming' AND duration_s = 0 AND status = 'NO_AUDIO'
    AND lead_id IS NULL AND lead_link_dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS calls_lead_started_asc
  ON calls (lead_id, started_at) WHERE lead_id IS NOT NULL;
