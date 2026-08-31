------------------------------------------------------------------------------
-- 0021 - converting a funnel lead into a client
--
-- 0020 captures enquiries into `marketing.funnel_submissions`. This adds the
-- other end of that journey: the record that a given enquiry became a paying
-- customer, and which organization it became.
--
-- WHY converted_org_id IS NOT A FOREIGN KEY
--
-- It points at public.organizations, and a real FK would make the marketing
-- schema depend on the tenant schema. Two consequences we do not want:
--
--   · `aura_marketing` has no USAGE on `public` at all (0020, deliberately), and
--     a FK requires REFERENCES on the target. Granting that would hand the
--     public marketing server a readable pointer into the tenant table it was
--     specifically walled off from.
--   · ON DELETE would couple the two lifecycles. Erasing a customer's org must
--     not silently rewrite the marketing record of how they arrived - that
--     record is pre-contract sales history, kept under its own retention rule.
--
-- So it is a plain uuid, resolved with a LEFT JOIN by the operator API, which
-- connects as the schema owner and can see both. A converted org that is later
-- deleted leaves a dangling id, and the join simply reports no name - which is
-- the honest answer, not a broken row.
------------------------------------------------------------------------------

ALTER TABLE marketing.funnel_submissions
  ADD COLUMN IF NOT EXISTS converted_org_id uuid,
  ADD COLUMN IF NOT EXISTS converted_at     timestamptz,
  ADD COLUMN IF NOT EXISTS converted_by     text;

------------------------------------------------------------------------------
-- `status` gains a fourth value.
--
-- 0020 wrote the CHECK inline, so Postgres named it funnel_submissions_status_check.
-- Dropped and re-added rather than altered because a CHECK constraint cannot be
-- widened in place. DROP IF EXISTS keeps this migration safe to re-run.
------------------------------------------------------------------------------

ALTER TABLE marketing.funnel_submissions
  DROP CONSTRAINT IF EXISTS funnel_submissions_status_check;

ALTER TABLE marketing.funnel_submissions
  ADD CONSTRAINT funnel_submissions_status_check
  CHECK (status IN ('contact_captured', 'qualified', 'disqualified', 'converted'));

------------------------------------------------------------------------------
-- One org, one lead.
--
-- A partial unique index rather than a plain one: the column is NULL for every
-- unconverted enquiry, and there will be far more of those than converted ones.
-- This stops the same organization being credited to two different enquiries,
-- which is what would happen the first time an operator converts a duplicate
-- record for a company that enquired twice.
------------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS funnel_submissions_converted_org_uniq
  ON marketing.funnel_submissions (converted_org_id)
  WHERE converted_org_id IS NOT NULL;

-- The console lists newest-first and filters on conversion state.
CREATE INDEX IF NOT EXISTS funnel_submissions_status_created
  ON marketing.funnel_submissions (status, created_at DESC);

------------------------------------------------------------------------------
-- Grants
--
-- Nothing new. apps/api reaches this schema through the admin pool, which
-- connects on DATABASE_URL as the role that OWNS the marketing schema, so it
-- already has full access and an explicit grant would be noise.
--
-- FOLLOW-UP worth doing: `aura_marketing` holds table-wide UPDATE from 0020,
-- so the public form's role can technically write these three columns. It has
-- no read access to `public` and cannot discover a valid org id, so this is
-- untidy rather than exploitable. The fix is column-scoped UPDATE on the
-- dedupe columns only, which needs the funnel's write path enumerated first.
------------------------------------------------------------------------------
