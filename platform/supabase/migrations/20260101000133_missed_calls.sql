-- 0133_missed_calls.sql - calls nobody picked up, from the handset's call log.
--
-- ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────
--
-- The console has a "missed" state (state.tsx's callState): an inbound call
-- with no talk time, painted red, counted on the KPI row, the heatmap, call
-- insights and the per-person table. Nothing ever fed it. The
-- handset records on OFFHOOK and never on RINGING, and POST /v1/calls demands
-- audio (bytes > 0, a sha256), so an unanswered call produced no row at all.
-- The only rows the red number ever counted were answered calls whose
-- recording rounded down to zero seconds - noise, not missed business.
--
-- From app build 1.1.5 the handset reads its own call log for MISSED,
-- REJECTED and VOICEMAIL entries and posts them to POST /v1/calls/missed.
-- Each one lands here as an ordinary `calls` row - direction 'incoming',
-- duration_s 0, no `recordings` row - so every surface that already derives
-- "missed" from those two columns starts telling the truth without a change,
-- and the lead-link sweep (0094) and the unmatched-call queue pick them up
-- like any other call.
--
-- ── NO_AUDIO: A PIPELINE STATE, NOT AN OUTCOME ──────────────────────────────
--
-- `calls.status` is the processing pipeline and stays that way (state.tsx,
-- 0014). A missed call has nothing to transcode, transcribe or analyse, so it
-- is born terminal: NO_AUDIO says "there is nothing to process", the same way
-- TRANSCRIPTION_OFF says "processing was switched off". It is never published
-- to the queue, never reprocessable, and no sweep reads it. Missed-ness itself
-- stays derived from direction + duration, so the dashboard's one definition
-- does not fork.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_status_check CHECK (status IN (
  'AWAITING_AUDIO', 'UPLOADED', 'TRANSCODING', 'TRANSCRIBING',
  'ANALYZING', 'SYNCING', 'COMPLETE', 'TRANSCRIPTION_OFF',
  'FAILED_TRANSCODE', 'FAILED_ASR', 'FAILED_ANALYZE', 'FAILED_CRM',
  'FAILED_UPLOAD', 'NO_AUDIO'));

-- ── WHY IT WAS MISSED ───────────────────────────────────────────────────────
--
-- What the call log said, kept because an owner reads them differently:
-- `unanswered` rang out, `declined` was rejected on the handset by whoever held
-- it, `voicemail` went to voicemail. A declined customer call is a coaching
-- conversation; a ring-out at 1 PM is a staffing one.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS missed_reason text;

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_missed_reason_check;
ALTER TABLE calls ADD CONSTRAINT calls_missed_reason_check
  CHECK (missed_reason IS NULL OR missed_reason IN ('unanswered', 'declined', 'voicemail'));

-- A reason only ever sits on the row shape the console reads as missed. If a
-- later write made one of these calls look answered, the reason would be a
-- lie about it - so the pair is held together here rather than trusted to
-- every writer.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_missed_reason_shape_check;
ALTER TABLE calls ADD CONSTRAINT calls_missed_reason_shape_check
  CHECK (missed_reason IS NULL
         OR (direction = 'incoming' AND duration_s = 0 AND status = 'NO_AUDIO'));

-- ── A NUMBER KEY THAT SURVIVES THE DIALLER'S FORMATTING ─────────────────────
--
-- `remote_number_hash` hashes whatever digits the handset reported, and the
-- call log is not consistent about them: an incoming call usually arrives as
-- "+919876543210", the same person dialled back from the keypad as
-- "9876543210" or "09876543210". Three digests, one customer. conversations
-- .service.ts already documents this limit for WhatsApp.
--
-- For "did anybody ring this missed caller back" that is fatal - the missed
-- call and the callback are exactly the incoming/outgoing pair that formats
-- differently. So calls also carry `remote_number_key`: a SHA-256 of the last
-- ten digits (or, for a shorter number, its digits without a trunk zero),
-- computed by `phoneMatchDigits` in @aura/shared. It is used ONLY to match a
-- call to a call. `remote_number_hash` is untouched, because leads
-- (contact_number_hash), the lead-link sweep and the triage queue all join on
-- it, and changing it would un-link every existing lead from its calls.
ALTER TABLE calls ADD COLUMN IF NOT EXISTS remote_number_key text;

COMMENT ON COLUMN calls.remote_number_key IS
  'SHA-256 hex of phoneMatchDigits(number): the last 10 digits, so +91 98765 43210 '
  'and 098765 43210 match. Call-to-call matching only (missed-call callbacks); '
  'leads and the lead-link sweep keep using remote_number_hash.';

-- Backfill where the digits still exist: orgs that opted into keeping the full
-- number (0011). Everyone else's older calls keep a NULL key and fall back to
-- the exact hash, which is no worse than before. The CASE is phoneMatchDigits
-- written in SQL - keep the two in step (missed-calls.test.ts pins the
-- TypeScript half against the same cases).
UPDATE calls c
   SET remote_number_key = encode(sha256(convert_to(k.key, 'UTF8')), 'hex')
  FROM (
    SELECT id,
           CASE WHEN length(d) >= 10 THEN right(d, 10)
                WHEN length(d) >= 6  THEN ltrim(d, '0')
           END AS key
      FROM (
        SELECT id, regexp_replace(remote_number_full, '\D', '', 'g') AS d
          FROM calls
         WHERE remote_number_full IS NOT NULL AND remote_number_key IS NULL
      ) s
  ) k
 WHERE c.id = k.id
   AND length(k.key) >= 6;

-- ── Indexes ─────────────────────────────────────────────────────────────────
--
-- The callback lookup: "the first call after this one, to or from the same
-- person". One per key, because older rows only have the hash. Leading on
-- org_id because RLS puts it in every predicate.
CREATE INDEX IF NOT EXISTS calls_number_key_started
  ON calls (org_id, remote_number_key, started_at)
  WHERE remote_number_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS calls_number_hash_started
  ON calls (org_id, remote_number_hash, started_at)
  WHERE remote_number_hash IS NOT NULL;

-- The missed calls themselves - the call log's Missed filter and the insights
-- callback section. Partial on the derived definition, so it holds exactly the
-- rows those predicates select.
CREATE INDEX IF NOT EXISTS calls_org_missed
  ON calls (org_id, started_at DESC)
  WHERE direction = 'incoming' AND duration_s <= 0;
