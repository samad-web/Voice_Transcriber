-- 0097_call_dispositions.sql - the tenant's own words for how a call ended.
--
-- ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
--
-- Aura already reads an outcome off every call: the analyze stage writes
-- `transcripts.intelligence->>'outcome'` and the console shows it as a chip.
-- That is a machine's reading, in a vocabulary we chose, and it is right often
-- enough to be useful and wrong often enough that nobody treats it as a
-- record.
--
-- The Hawcus teardown found the other half (§3.5): a per-tenant list of call
-- outcomes, each carrying a LEAD-QUALITY weight, so a disposition feeds lead
-- scoring directly. Their version has no AI at all - a human picks from a
-- dropdown - and ours has no dropdown. Neither alone is the right product.
--
-- So: the tenant defines the vocabulary, the AI proposes from it, and a person
-- confirms. That is the same shape the SOP scoring (0091) and the WhatsApp
-- qualification (0080) already take, and for the same reason - a machine's
-- read is a proposal, and the record is what a person agreed to.
--
-- ── WHY lead_quality IS A TEMPERATURE AND NOT A NUMBER ──────────────────────
--
-- Hawcus stores `lead_quality` as a weight. A number invites arithmetic, and
-- the arithmetic would land on `leads.score` - which is the EXTRACTION's
-- confidence (0010), not a rating, and reusing it as one would make a
-- confidently-read rejection outrank a hesitantly-read buyer.
--
-- 0083 already built the rating this belongs to: `leads.temperature`, hot /
-- medium / cold, with `temperature_source` recording whether a person or the
-- pipeline decided. A disposition therefore maps to a TEMPERATURE, and
-- applying one is a human decision, so it writes `temperature_source = 'user'`
-- - which 0083's own rule then makes permanent against the pipeline. No new
-- rating concept, no second scale to reconcile.
--
-- 'none' is a real and necessary option: "wrong number" and "call back later"
-- say nothing about how good the lead is, and forcing every outcome to imply a
-- temperature would have the busiest dispositions on the floor quietly
-- re-rating leads nobody assessed.

CREATE TABLE IF NOT EXISTS call_dispositions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- The stable identifier a call points at. Set once from the label and never
  -- editable afterwards - the same rule call_sops step keys follow (0091), and
  -- for the same reason: every call ever dispositioned is filed under it, and
  -- renaming it would orphan them. The LABEL is freely editable and is what
  -- anybody actually reads.
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label      text NOT NULL CHECK (length(btrim(label)) > 0),

  -- How good a lead this outcome implies. NULL means "says nothing" - see the
  -- header. Deliberately the same vocabulary as leads.temperature, not a
  -- parallel one.
  lead_quality text CHECK (lead_quality IS NULL OR lead_quality IN ('hot', 'medium', 'cold')),

  -- Presentation, so the console's chips look like the tenant's own process
  -- rather than like a generic list. Validated app-side against the console's
  -- palette; free text here for the same reason marketing_sources.channel is.
  color      text,
  icon       text,

  sort_order int  NOT NULL DEFAULT 0,
  is_active  bool NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One key per org. A second "not_interested" would make the call's stored key
-- ambiguous, which is the one thing this table cannot afford.
CREATE UNIQUE INDEX IF NOT EXISTS call_dispositions_org_key
  ON call_dispositions (org_id, key);

CREATE INDEX IF NOT EXISTS call_dispositions_org_order
  ON call_dispositions (org_id, sort_order) WHERE is_active;

ALTER TABLE call_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_dispositions FORCE  ROW LEVEL SECURITY;
DO $do$ BEGIN
  CREATE POLICY org_isolation ON call_dispositions
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

GRANT SELECT, INSERT, UPDATE, DELETE ON call_dispositions TO aura_app;
DO $do$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON call_dispositions FROM %I', api_role);
    END IF;
  END LOOP;
END $do$;

-- ── What a call was dispositioned as ────────────────────────────────────────
--
-- The KEY and not a foreign key to the row. A disposition can be retired -
-- `is_active = false` - and a call dispositioned last March must still report
-- what it was marked as, exactly the way `call_sop_results` keeps the step
-- keys it was judged against. A FK with ON DELETE SET NULL would erase the
-- record; a FK without one would stop anybody ever tidying the list.
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS disposition_key   text,
  ADD COLUMN IF NOT EXISTS disposition_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS disposition_at    timestamptz;

COMMENT ON COLUMN calls.disposition_key IS
  'What a PERSON said this call was, from call_dispositions. Distinct from the '
  'AI outcome on transcripts.intelligence, which is a proposal - this is the '
  'record. Stored as the key, not a FK, so a retired disposition still reads '
  'back on the calls that carried it.';

CREATE INDEX IF NOT EXISTS calls_org_disposition
  ON calls (org_id, disposition_key, started_at DESC) WHERE disposition_key IS NOT NULL;

-- The queue the console works: complete calls nobody has judged yet.
CREATE INDEX IF NOT EXISTS calls_org_undispositioned
  ON calls (org_id, started_at DESC)
  WHERE disposition_key IS NULL AND status = 'COMPLETE';

-- ── A starting set, per org ─────────────────────────────────────────────────
--
-- Seeded rather than left empty, because an empty list makes the feature
-- invisible: nobody opens a settings page to define a vocabulary for a control
-- they have never seen. These seven are the ones the reference product's own
-- tenant had, which is a better starting point than anything invented here,
-- and every one of them is editable and removable.
--
-- The quality mapping is deliberately conservative. Only two outcomes assert a
-- temperature at all: a call that went well and a flat rejection. "Call back
-- later", "no answer" and "wrong number" say nothing about the lead, and a
-- floor's most-used disposition silently re-rating every lead it touches is
-- the failure this column has to avoid.
INSERT INTO call_dispositions (org_id, key, label, lead_quality, color, sort_order)
SELECT o.id, d.key, d.label, d.lead_quality, d.color, d.sort_order
  FROM organizations o
 CROSS JOIN (VALUES
   ('interested',      'Interested',        'hot',    'green',  1),
   ('follow_up',       'Call back later',    NULL,    'blue',   2),
   ('not_interested',  'Not interested',    'cold',   'red',    3),
   ('no_answer',       'No answer',          NULL,    'grey',   4),
   ('wrong_number',    'Wrong number',       NULL,    'grey',   5),
   ('already_bought',  'Bought elsewhere',  'cold',   'red',    6),
   ('busy',            'Busy - try again',   NULL,    'grey',   7)
 ) AS d(key, label, lead_quality, color, sort_order)
 WHERE o.status = 'active'
   ON CONFLICT (org_id, key) DO NOTHING;
