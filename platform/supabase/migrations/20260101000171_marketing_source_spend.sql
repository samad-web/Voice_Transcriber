-- 0171_marketing_source_spend.sql - what a campaign cost IN A PERIOD, so a
-- window's return can be computed against the window's spend.
--
-- ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
--
-- `marketing_sources.spend_amount` (0057) is a campaign's recorded TOTAL. The
-- command centre's campaign table therefore divides leads from a seven-day
-- window by a spend that may cover eight months, and understates the return of
-- every long-running campaign by however long it has been running.
--
-- That has been stated on the page rather than hidden - CampaignsPanel's header
-- comment and the note under the table both say so - which was the honest move
-- while there was nothing to divide by. This table is the thing to divide by.
-- Build docs/41 Part E4.
--
-- ── WHY A MONTH AND NOT AN ARBITRARY PERIOD ─────────────────────────────────
--
-- Doc 41 specifies `(period_start, period_end)`. A free period is the wrong
-- shape, for one reason that outweighs the flexibility: two periods that
-- overlap double-count the overlap, silently, in a figure somebody moves a
-- budget on. Preventing that needs an exclusion constraint over a daterange,
-- which needs btree_gist - and 0042 records that this platform cannot assume
-- CREATE EXTENSION is permitted to the migration role on a hosted Postgres.
--
-- A month grain makes the overlap unrepresentable instead of merely forbidden:
-- `month` is the first of a month (enforced), one row per campaign per month
-- (enforced), so there is no pair of rows whose periods can intersect. No
-- extension, no trigger, nothing to get wrong later.
--
-- It also matches where the numbers come from. Meta, Google and every agency
-- invoice report spend by calendar month; a tenant typing in a figure is
-- reading it off a monthly statement. A period grain finer than the source
-- data would be precision this platform does not actually have.
--
-- ── PARTIAL WINDOWS PRO-RATE BY DAY ─────────────────────────────────────────
--
-- A report for the 5th to the 12th covers 8 of October's 31 days, so October's
-- spend contributes 8/31 of itself. This is an assumption - ad spend is not
-- uniform across a month - and it is a far smaller one than dividing a week's
-- leads by a year's spend. The read states the basis it used (`spend_basis`),
-- and the page prints it, so nobody has to guess which of the two they are
-- looking at.
--
-- ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
--
-- Not an accounting record. Nothing here is invoiced, reconciled or approved;
-- it is an input to a ratio, in the same spirit as `commission_plans` (0071),
-- whose header draws the same line. numeric and never float, for the reason
-- 0057 gives: money that has been through a float no longer reconciles.

CREATE TABLE IF NOT EXISTS marketing_source_spend (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- CASCADE, unlike the attribution columns 0057 adds to contacts and deals.
  -- Those are write-once attributions worth keeping after a campaign is
  -- retired; a spend row keyed on no campaign is a number about nothing.
  source_id uuid NOT NULL REFERENCES marketing_sources(id) ON DELETE CASCADE,

  -- The first day of the month this spend belongs to. The CHECK is what makes
  -- the unique index below a guarantee of non-overlap rather than a guarantee
  -- of non-duplication.
  month     date NOT NULL CHECK (month = date_trunc('month', month)::date),

  -- Zero is allowed and meaningful: "this campaign ran and cost nothing this
  -- month" is a fact, and it is different from no row, which means nobody has
  -- said. Negative is not - a refund belongs in the month it reduces, not as
  -- a row of its own.
  amount    numeric(14, 2) NOT NULL CHECK (amount >= 0),
  -- Null means "the campaign's own spend_currency", rather than defaulting to
  -- a currency this table guessed.
  currency  text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One row per campaign per month. With the CHECK above, this is the whole
  -- integrity story for this table.
  UNIQUE (org_id, source_id, month)
);

-- "Every campaign's spend across these months" - the command centre's read,
-- which scans the window and joins back to campaigns rather than walking one
-- campaign at a time.
CREATE INDEX IF NOT EXISTS marketing_source_spend_org_month
  ON marketing_source_spend (org_id, month);

COMMENT ON COLUMN marketing_source_spend.month IS
  'First day of the calendar month this spend covers. The month grain is what '
  'makes overlapping periods - and therefore double-counted spend - '
  'unrepresentable. A partial reporting window pro-rates by overlapping days.';

ALTER TABLE marketing_source_spend ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_source_spend FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON marketing_source_spend
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── The second axis: the partner wall (0163) ────────────────────────────────
--
-- 0163 walled every org-scoped table that existed WHEN IT RAN, and it can only
-- ask the catalog about the past - so every table created afterwards has to
-- carry its own wall, exactly as 0165 and 0166 do. `verify-rls.js` fails the
-- deploy without it, which is how this one was caught rather than shipped.
--
-- What it stops here: a channel partner reading what the business pays per
-- month to acquire the leads they are quoting against. `org_isolation` alone
-- does not stop it - a partner principal is INSIDE the org, and its whole
-- purpose is that being in the tenant is not the same as being staff.
--
-- RESTRICTIVE, never permissive: a permissive policy ORs with org_isolation,
-- admits every row it was meant to deny, and reads in pg_policies exactly like
-- the thing that was supposed to be there.
DO $$ BEGIN
  CREATE POLICY partner_wall ON marketing_source_spend AS RESTRICTIVE
    USING (NULLIF(current_setting('app.partner_id', true), '') IS NULL)
    WITH CHECK (NULLIF(current_setting('app.partner_id', true), '') IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON marketing_source_spend TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON marketing_source_spend FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON marketing_source_spend FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER marketing_source_spend_set_updated_at
    BEFORE UPDATE ON marketing_source_spend
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
