-- 0080_whatsapp_qualification.sql - WhatsApp as a lead channel, via a verdict
-- a human approves.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────
--
-- 0055 gave the business an inbox: a message sent to the company's own
-- WhatsApp number lands in `conversations` with its body intact, and an
-- unrecognised number lands in the unmatched queue. What 0055 deliberately
-- did NOT do is turn that message into anything. Read its header: it "never
-- silently auto-creates a contact". So the enquiry arrives, sits, and dies
-- there unless a person happens to open the inbox, recognise a prospect, and
-- hand-build the lead somewhere else.
--
-- Meanwhile 0078 built a four-channel intake engine - web form, email,
-- telephony, Meta/LinkedIn ads - all of which write a `leads` row stamped with
-- where it came from. WhatsApp was not one of them, and `source_channel`'s
-- CHECK did not even have a value for it. So the single channel where a
-- prospect actually TALKS to the business was the one channel that could not
-- produce a lead, and could not be credited for one.
--
-- ── WHY A VERDICT TABLE AND NOT A WRITER ────────────────────────────────
--
-- The obvious build is a sweep that reads a thread, decides it looks like a
-- prospect, and inserts a lead. That is the build this migration refuses.
--
-- Safety rule 2 - a human's edit outranks every machine - is why. WhatsApp
-- inbound is not a lead-gen form; it is whoever has the number. It is the
-- delivery driver, the courier asking which gate, a wrong number, the
-- supplier, a one-word "hi" that never went anywhere, and the actual buyer,
-- all in the same queue and all indistinguishable to a phone-number match. A
-- machine that writes leads from that fills the board with rubbish nobody can
-- retract, and every acquisition report downstream inherits it.
--
-- So the sweep's output is a PROPOSAL: a score, the fields it thinks it read,
-- and one sentence saying why. It writes here and stops. A `leads` row appears
-- only when a person presses approve, and `reviewed_by_user_id` records which
-- person - enforced below, not merely by convention. That keeps rule 2 exactly
-- where 0055 drew it while removing the dead end.
--
-- Rule 3 is untouched. Nothing here sends; qualification reads a conversation
-- that already happened.

-- ── the channel vocabulary ──────────────────────────────────────────────
--
-- 0078's comment on lead_sources.kind is the standing rule: "a channel here is
-- a code path - a route, a parser, a sweep - so a new one is a deployment, and
-- a CHECK is the honest expression of that." This is that deployment.
--
-- The CHECKs on leads/contacts/deals were added unnamed by 0078, so Postgres
-- auto-named them. Rather than trust the generated name, find them by the
-- COLUMN they constrain: every CHECK whose attribute list is exactly
-- source_channel is the one being replaced. Matching on the definition text
-- instead would be a substring search that could catch an unrelated
-- constraint mentioning the word. Re-running this migration is then a no-op
-- rather than an error.
DO $$
DECLARE
  tbl  text;
  con  text;
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
         -- exactly this one column, not a multi-column CHECK that happens to
         -- involve it
         AND c.conkey = ARRAY[a.attnum]
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, con);
    END LOOP;
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (source_channel IN (
         ''call'', ''web_form'', ''email'', ''telephony'', ''meta_ads'',
         ''linkedin_ads'', ''whatsapp'', ''api'', ''import'', ''manual''))',
      tbl, tbl || '_source_channel_check');
  END LOOP;
END $$;

-- `lead_sources.kind` is deliberately NOT extended.
--
-- 0078 already draws this line: "'call', 'import' and 'manual' are in this
-- CHECK but not in lead_sources.kind". A `lead_sources` row is a configured
-- front door - an endpoint token, a field map, provider presets, a rotation
-- schedule. WhatsApp has none of those. The message arrives through the
-- messaging webhook that 0056/0061 already built, and the "field map" is an
-- LLM reading prose. Adding a kind here would advertise a
-- `/v1/intake/whatsapp/:token` endpoint that does not exist and force a
-- catalogue entry with no providers to put in it.
--
-- So a qualified WhatsApp lead carries `source_channel = 'whatsapp'` with
-- `lead_source_id` NULL, exactly like a lead from a handset call. The board
-- filters on source_channel, which is the column that answers "which channel
-- is worth the money".

-- ── conversation_qualifications: the proposal ───────────────────────────
CREATE TABLE IF NOT EXISTS conversation_qualifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- CASCADE, unlike conversations.contact_id's SET NULL. A verdict about a
  -- thread has no meaning once the thread is gone - it is derived data, not
  -- the record that something happened. The `leads` row it produced survives
  -- independently, which is the row that actually matters.
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

  -- ── the watermark ─────────────────────────────────────────────────────
  --
  -- Which message the verdict was computed from. A thread is not a fixed
  -- object: "hi" scores as junk, and the same thread three messages later is a
  -- ₹4L enquiry. Pinning the verdict to a message means a reviewer is never
  -- shown a stale score for a conversation that has since moved on, and it is
  -- the idempotency key that stops the sweep re-scoring an unchanged thread
  -- every tick and paying an LLM call to do it.
  --
  -- SET NULL rather than CASCADE: erasing one message must not delete the
  -- verdict, for the same reason 0055 keeps the thread when a contact is
  -- erased. A NULL watermark simply means the sweep will re-qualify.
  last_message_id uuid REFERENCES conversation_messages(id) ON DELETE SET NULL,
  message_count   int NOT NULL DEFAULT 0 CHECK (message_count >= 0),

  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),

  -- WHAT KIND of conversation this is, which is the axis a score alone cannot
  -- carry. A 90-confidence "wrong number" and a 90-confidence buyer are both
  -- high scores and only one is a lead. Closed vocabulary, kept in step with
  -- QualificationDisposition in packages/shared/src/whatsapp-qualification.ts.
  --
  -- 'unclear' is the default because it is the honest verdict on a thread
  -- nothing has read yet, and because a default of 'prospect' would make a
  -- failed write look like a lead.
  disposition     text NOT NULL DEFAULT 'unclear'
                  CHECK (disposition IN ('prospect', 'existing_customer', 'support',
                                         'vendor', 'wrong_number', 'spam', 'unclear')),

  -- 0-100, same scale as calls.quality_score, so the console renders warmth
  -- one way across the product rather than inventing a second scale.
  score           int NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  -- A short label: "price enquiry", "wrong number", "delivery agent".
  intent          text,
  -- One sentence saying WHY this score. A reviewer approving a machine's
  -- judgment needs the reason, or the queue is a slot machine.
  rationale       text,

  -- ── what the model believes it read ───────────────────────────────────
  --
  -- All nullable, on purpose. Most WhatsApp threads name nobody and state no
  -- budget, and a qualifier that invents them to fill the columns is worse
  -- than one that admits it found nothing. These are PROPOSED values: they are
  -- shown to the reviewer, who may edit any of them before approving, and it
  -- is the reviewer's edited version that reaches the CRM.
  extracted_name    text,
  extracted_email   text,
  extracted_company text,
  -- numeric, never a bare cast of the model's string. 0078 shipped a bug where
  -- Number("") is 0 and a budget reading "lots" became a zero-value deal that
  -- counted as a real figure in every revenue report. NULL is the honest value
  -- for "they did not say", and the CHECK refuses the zero that bug produced.
  extracted_budget  numeric(14, 2) CHECK (extracted_budget IS NULL OR extracted_budget > 0),
  extracted_notes   text,
  facts             jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Provenance for the verdict itself. When a tenant asks why their queue got
  -- worse, "the model changed under us" has to be answerable from the row.
  provider        text,
  model           text,
  tokens_in       int,
  tokens_out      int,

  -- ── the human half ────────────────────────────────────────────────────
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  -- What approval produced. SET NULL so deleting a lead does not delete the
  -- record that it was approved from this thread.
  lead_id             uuid REFERENCES leads(id) ON DELETE SET NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Safety rule 2, as a constraint rather than a convention.
  --
  -- A decided row must name the person who decided it and when. Without this
  -- the table would happily record a machine-approved lead - the exact thing
  -- this whole design exists to prevent - and the API is one refactor away
  -- from doing it by accident. `reviewed_at` is deliberately NOT defaulted, so
  -- omitting it fails loudly here instead of silently stamping now().
  CONSTRAINT qualification_decided_by_a_human CHECK (
    status IN ('pending', 'superseded')
    OR (reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

-- The idempotency anchor: one verdict per thread-state. Two sweep ticks
-- overlapping, or a re-run after a crash, converge on the same row instead of
-- paying for a second LLM call and showing the reviewer a duplicate card.
--
-- Partial, because last_message_id goes NULL when a message is erased and
-- NULLs are all distinct to a unique index anyway - saying so explicitly keeps
-- the intent readable.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_qualifications_watermark
  ON conversation_qualifications (conversation_id, last_message_id)
  WHERE last_message_id IS NOT NULL;

-- At most ONE live proposal per conversation. When new messages arrive the
-- sweep supersedes the old row before inserting the new one; this index is
-- what makes that ordering mandatory rather than hopeful, so a reviewer can
-- never be shown two open cards for the same thread that disagree.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_qualifications_one_pending
  ON conversation_qualifications (conversation_id)
  WHERE status = 'pending';

-- The review queue itself: highest score first, which is the order a person
-- with twenty minutes should work it in.
CREATE INDEX IF NOT EXISTS conversation_qualifications_queue
  ON conversation_qualifications (org_id, score DESC, created_at DESC)
  WHERE status = 'pending';

-- "What did this thread ever get judged as", for the conversation view.
CREATE INDEX IF NOT EXISTS conversation_qualifications_conversation
  ON conversation_qualifications (conversation_id, created_at DESC);

ALTER TABLE conversation_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_qualifications FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON conversation_qualifications
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE ON conversation_qualifications TO aura_app;
-- No DELETE: a rejected verdict is the audit trail explaining why a thread the
-- tenant later decides was a real lead never reached the board. Superseding
-- and rejecting both keep the row.
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON conversation_qualifications FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON conversation_qualifications FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER conversation_qualifications_set_updated_at
    BEFORE UPDATE ON conversation_qualifications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── org-level switch ────────────────────────────────────────────────────
--
-- Off by default, and that is the point. Qualification sends a tenant's
-- customer conversations to an LLM provider. That is a decision a tenant makes
-- deliberately, not one inherited by every org on the platform because a
-- migration ran - the same posture EMAIL_SENDING_ENABLED and
-- WHATSAPP_SENDING_ENABLED already take for sending.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS whatsapp_qualification_enabled boolean NOT NULL DEFAULT false;
