-- 0082_qualification_privacy.sql - the `personal` verdict, and the retention
-- rules that follow from it.
--
-- ── WHY 0080 WAS NOT ENOUGH ─────────────────────────────────────────────
--
-- 0080 shipped a disposition vocabulary with no name for the most sensitive
-- thing a business WhatsApp number receives: a private message to the human
-- who owns the handset.
--
-- That is not a hypothetical in this market. A business WhatsApp number here
-- is very often somebody's own phone, so their brother, their landlord and
-- their doctor's receptionist all write to the same inbox the enquiries land
-- in. With no category of its own such a message could only be scored
-- `unclear` - and `unclear` means "a human should look at this", which puts
-- the owner's private life into a review queue for their office staff to read.
-- Worse, a friend asking "how much did the car end up costing?" matches every
-- buying keyword the qualifier has.
--
-- ── WHAT THIS ADDS ──────────────────────────────────────────────────────
--
-- 1. `personal` as a disposition.
-- 2. A CHECK that a non-business verdict CANNOT carry extracted content, so the
--    rule survives a future writer that forgets to redact.
-- 3. `qualification_retention_days` on organizations, so verdicts age out
--    rather than accumulating forever.

-- ── the vocabulary ──────────────────────────────────────────────────────
DO $$
DECLARE con text;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
     WHERE t.relname = 'conversation_qualifications'
       AND c.contype = 'c'
       AND a.attname = 'disposition'
       AND c.conkey = ARRAY[a.attnum]
  LOOP
    EXECUTE format('ALTER TABLE conversation_qualifications DROP CONSTRAINT %I', con);
  END LOOP;
  ALTER TABLE conversation_qualifications
    ADD CONSTRAINT conversation_qualifications_disposition_check
    CHECK (disposition IN ('prospect', 'existing_customer', 'support', 'vendor',
                           'wrong_number', 'spam', 'personal', 'unclear'));
END $$;

-- ── the retention rule, as a constraint ─────────────────────────────────
--
-- `redactForRetention()` in packages/shared strips these fields before the row
-- is written. This makes that structural rather than a courtesy: a personal
-- message, a wrong number or spam may record THAT it was judged, and may not
-- keep who said it or what they said.
--
-- Deliberately NOT covering `rationale`: a one-line reason is what stops the
-- queue being a black box, and the prompt forbids quoting content for these
-- categories. A CHECK cannot tell a category name from a quotation, so this
-- constrains the fields that are unambiguously content.
ALTER TABLE conversation_qualifications
  DROP CONSTRAINT IF EXISTS qualification_private_threads_keep_nothing;
ALTER TABLE conversation_qualifications
  ADD CONSTRAINT qualification_private_threads_keep_nothing CHECK (
    disposition NOT IN ('personal', 'wrong_number', 'spam')
    OR (extracted_name IS NULL AND extracted_email IS NULL
        AND extracted_company IS NULL AND extracted_budget IS NULL
        AND extracted_notes IS NULL)
  );

-- ── ageing verdicts out ─────────────────────────────────────────────────
--
-- Separate from `retention_days`, which governs call recordings and the leads
-- they produce. A verdict is a much smaller thing with a much shorter useful
-- life: once a thread has been approved or rejected, the row's only remaining
-- job is to stop the sweep re-reading and re-billing that thread, and to answer
-- "why did this enquiry never reach the board" for as long as anyone might ask.
--
-- 90 days rather than the recording default, because these rows sit on
-- conversations the tenant did NOT choose to turn into customers - including,
-- by construction, every message the qualifier decided was private.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS qualification_retention_days int NOT NULL DEFAULT 90
    CHECK (qualification_retention_days BETWEEN 1 AND 3650);

-- The reaper scans by age within an org.
CREATE INDEX IF NOT EXISTS conversation_qualifications_reap
  ON conversation_qualifications (org_id, created_at);

-- ── DELETE, which 0080 deliberately withheld ────────────────────────────
--
-- 0080's reasoning was: "a rejected verdict is the audit trail explaining why a
-- thread the tenant later decides was a real lead never reached the board."
-- That argument is still right about the API - no route deletes one of these,
-- and none should.
--
-- It is wrong as a rule for the DATABASE, because it has no end. "Keep the
-- audit trail" and "keep it forever" are different claims, and the second one
-- cannot be defended for rows that, by construction, include a record of every
-- private message sent to the handset owner. Retention beats indefinite audit
-- here.
--
-- So: DELETE is granted, and the only thing that uses it is the retention
-- reaper, on the org's own qualification_retention_days clock.
GRANT DELETE ON conversation_qualifications TO aura_app;
