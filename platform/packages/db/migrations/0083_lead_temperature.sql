-- 0083_lead_temperature.sql - a Hot / Medium / Cold rating on every lead, and
-- the one-time nudge that gets the board unstuck.
--
-- ── WHY A NEW COLUMN AND NOT `leads.score` ────────────────────────────────
--
-- `leads.score` already looks like a rating and is not one. It is
-- `confidenceScore(validation_status, factsFilled, factsTotal)` from
-- apps/worker/src/pipeline/crm-dispatch.ts: how COMPLETE and how trustworthy
-- the AI's extraction was, on 0.5..1.0. A call where the customer said "never
-- contact me again" in fluent, fully-extractable detail scores 1.0. Reusing it
-- as buying temperature would rank the clearest rejections as the hottest
-- leads, so temperature gets its own column.
--
-- ── WHY `temperature_source` EXISTS ───────────────────────────────────────
--
-- The rating is set automatically from what the call analysis heard, and a
-- human can override it on the board. Without a marker for which of those
-- happened, the next call to that number would silently undo the person's
-- judgement - the failure mode that makes people stop trusting a field
-- altogether. So: 'auto' rows are the worker's to keep updating, 'user' rows
-- are nobody's but the person who set them. Clearing the rating in the console
-- returns the row to 'auto' and lets the worker have it back.
--
-- Default 'auto' (not NULL) so the worker's upsert has a single unambiguous
-- rule to check, and so a row written by anything that predates this migration
-- is treated as automatic rather than as a human decision to be preserved.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS temperature text;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_temperature_check;
ALTER TABLE leads ADD CONSTRAINT leads_temperature_check
  CHECK (temperature IS NULL OR temperature IN ('hot', 'medium', 'cold'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS temperature_source text NOT NULL DEFAULT 'auto';

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_temperature_source_check;
ALTER TABLE leads ADD CONSTRAINT leads_temperature_source_check
  CHECK (temperature_source IN ('auto', 'user'));

-- The board filters open leads by rating; the partial index matches the way
-- every board query already reads (org + open), so it stays small.
CREATE INDEX IF NOT EXISTS leads_org_temperature
  ON leads (org_id, temperature)
  WHERE status = 'open';

-- ── THE ONE-TIME STAGE BACKFILL ───────────────────────────────────────────
--
-- Nothing has ever moved a lead's stage except a person dragging the card, so
-- boards bank up in the entry column: at the time of writing one tenant had
-- 303 of its 305 leads still sitting in New. From this release the worker
-- advances a lead out of the entry stage the second time a call to that number
-- qualifies (apps/worker/src/pipeline/leads.ts) - but that only fires on the
-- NEXT call, which for a lead last touched months ago may be never.
--
-- So this moves the ones that already meet the rule, once. Deliberately
-- narrow, and every clause is load-bearing:
--
--   * `stage = 'new'` only. A card someone has already worked is theirs; this
--     must never pull a lead BACK from Qualified or Negotiation.
--   * `status = 'open'` only. Won and lost leads are finished.
--   * `call_count > 1`. One call is what created the lead; a second means the
--     conversation actually ran.
--   * the org must still have BOTH stage keys. `lead_stages` is tenant-
--     editable, so a tenant that renamed or removed either column would
--     otherwise get a stage value its own board cannot render, and the card
--     would vanish from every column.
--
-- `updated_at` is deliberately left alone: this is a correction to a value
-- that was always meant to be derived, not a fresh edit by anybody, and
-- last_activity_at drives every "stale lead" report on the console.

UPDATE leads l
   SET stage = 'contacted'
  FROM organizations o
 WHERE o.id = l.org_id
   AND l.stage = 'new'
   AND l.status = 'open'
   AND l.call_count > 1
   AND o.lead_stages @> '[{"key": "new"}]'::jsonb
   AND o.lead_stages @> '[{"key": "contacted"}]'::jsonb;
