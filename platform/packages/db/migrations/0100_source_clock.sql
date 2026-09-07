-- 0100_source_clock.sql - when the enquiry actually happened, as distinct from
-- when Aura heard about it.
--
-- ── THE BUG THIS FIXES IS ALREADY LIVE ──────────────────────────────────────
--
-- The response-time report (0093) measures `first_responded_at - created_at`,
-- and `created_at` is when the ROW was written. For a lead that arrived on a
-- webhook the moment somebody submitted a form, those are the same instant and
-- the number is right.
--
-- For everything else they are not. A Google Sheet connected on Monday (0096)
-- imports rows a partner typed last Tuesday, all stamped Monday. A Meta lead
-- ad delivery retried for two hours arrives two hours late. A CSV import of
-- three hundred leads stamps every one of them with the minute the file was
-- uploaded. In each case the report measures from the import clock, and the
-- floor either looks slower than it was or - much more often - looks instant,
-- because somebody worked the lead five minutes after it was imported and
-- three days after the customer actually asked.
--
-- The Hawcus teardown recorded `meta_created_at` alongside `created_at` (§3.1)
-- and called it a genuinely good schema decision. It is, and this is it: the
-- source's own clock, kept separately, never overwriting ours.
--
-- ── WHY BOTH AND NOT A CORRECTED created_at ─────────────────────────────────
--
-- Overwriting `created_at` with the source's timestamp would be simpler and
-- wrong twice over. It is the row's own audit fact - when this database
-- learned about this lead - and half the platform's paging and pagination
-- order by it. And a source clock is not ours: it comes from a spreadsheet
-- cell somebody typed, a vendor's payload, or a CSV column, any of which can
-- be missing, malformed, or set to 2019 by a typo. Keeping it separate means a
-- bad one degrades a metric rather than corrupting the record.

ALTER TABLE leads
  -- When the enquiry happened, according to whoever sent it. NULL means the
  -- source did not say, which is the honest and common case - and the reports
  -- fall back to created_at for exactly those.
  ADD COLUMN IF NOT EXISTS source_created_at timestamptz,
  -- The source's own identifier for it: the sheet row's key, the Meta lead id,
  -- the CRM record it came from. Kept so a lead can be traced back without
  -- reading the intake ledger, which is prunable.
  ADD COLUMN IF NOT EXISTS source_ref text;

COMMENT ON COLUMN leads.source_created_at IS
  'When the enquiry happened per the SOURCE, not when Aura wrote the row. '
  'Response time measures from COALESCE(source_created_at, created_at). Never '
  'in the future and never before 2015 - the trigger below drops values that '
  'are, because a clock-skewed vendor or a mistyped spreadsheet cell would '
  'otherwise produce a negative or a decade-long response time.';

-- ── The sanity trigger ──────────────────────────────────────────────────────
--
-- A CHECK cannot do this: `now()` is not immutable, so a constraint comparing
-- against it is rejected, and one that used a literal date would need a
-- migration every year.
--
-- Silently dropping an impossible value rather than rejecting the write is
-- deliberate. This arrives on an ingest path with no person watching, and a
-- lead REFUSED because a spreadsheet cell said 01/01/1970 is a customer nobody
-- ever calls. A lead accepted with an unknown source time is a customer
-- somebody calls, measured slightly wrong.
CREATE OR REPLACE FUNCTION leads_sane_source_time() RETURNS trigger AS $fn$
BEGIN
  IF NEW.source_created_at IS NULL THEN RETURN NEW; END IF;
  -- One hour of tolerance forward, for a vendor whose clock is a little fast.
  IF NEW.source_created_at > now() + interval '1 hour'
     OR NEW.source_created_at < timestamptz '2015-01-01'
  THEN
    NEW.source_created_at := NULL;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DO $do$ BEGIN
  CREATE TRIGGER leads_sane_source_time_check
    BEFORE INSERT OR UPDATE OF source_created_at ON leads
    FOR EACH ROW EXECUTE FUNCTION leads_sane_source_time();
EXCEPTION WHEN duplicate_object THEN NULL; END $do$;

-- ── Backfill from the intake ledger ─────────────────────────────────────────
--
-- `lead_intake_events` (0078) keeps the raw payload of every arrival, and the
-- normaliser already extracted an `occurredAt` from it where the provider sent
-- one. That is the same value this column wants, and for leads that arrived
-- through intake it is recoverable rather than lost.
--
-- Only where the event actually produced the lead, and only where the parsed
-- time is not after the row was written: an occurredAt later than created_at
-- means the payload's clock disagreed with ours in the direction that produces
-- a negative response time, and the report is better off with the fallback.
UPDATE leads l
   SET source_created_at = e.occurred_at,
       source_ref        = COALESCE(l.source_ref, e.external_id)
  FROM (
    SELECT DISTINCT ON (lead_id)
           lead_id,
           external_id,
           (payload ->> 'occurredAt')::timestamptz AS occurred_at
      FROM lead_intake_events
     WHERE lead_id IS NOT NULL
       AND payload ? 'occurredAt'
       -- A malformed timestamp in the payload would abort the whole statement
       -- on the cast. Filtered to what parses, rather than trusting it.
       AND (payload ->> 'occurredAt') ~ '^\d{4}-\d{2}-\d{2}'
     ORDER BY lead_id, received_at ASC
  ) e
 WHERE l.id = e.lead_id
   AND l.source_created_at IS NULL
   AND e.occurred_at IS NOT NULL
   AND e.occurred_at <= l.created_at;

-- The response-time report reads this alongside created_at, so the index it
-- already uses (leads_org_created_at, 0093) needs a sibling.
CREATE INDEX IF NOT EXISTS leads_org_source_created
  ON leads (org_id, source_created_at) WHERE source_created_at IS NOT NULL;
