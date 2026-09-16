-- 0106_org_setup_checklist.sql - the new-client setup checklist: one column,
-- and the reason it is a column rather than a computed answer.
--
-- ── WHAT THE FEATURE IS ─────────────────────────────────────────────────────
--
-- A newly provisioned client lands in a console with nothing in it. The
-- checklist gives them a banner and a modal listing what is left to do - add
-- telecallers, upload a logo, connect a payment account, plus the optional
-- connectors their entitlement includes. The catalogue itself is in
-- @aura/shared's onboarding.ts, deliberately NOT in this schema: which steps
-- exist is product copy that changes with the product, and a step list in a
-- table would need a migration every time somebody rewrote a sentence.
--
-- ── WHY A STORED FLAG AND NOT A LIVE CHECK ──────────────────────────────────
--
-- "Is this client set up?" is answerable from existing rows: a device exists, a
-- telecaller exists, branding has a logo, a gateway is configured. The console
-- needs that answer in its LAYOUT, on every single navigation, because that is
-- where the banner lives.
--
-- This deployment runs the API in Mumbai against a database in Seoul, ~125ms
-- per round trip (DB_LATENCY_MIGRATION.md). Asking the question on every page
-- load would add that to every navigation in the product, forever, to render
-- nothing at all for the ~100% of a client's lifetime that comes after
-- onboarding.
--
-- So the flag rides on `organizations`, which `AuthService.contextFor` already
-- reads to turn a session into an org - the same free ride `branding` (0065)
-- and `enabled_modules` (0072) take. Once it is set,
-- the console skips the checklist entirely and costs nothing. While it is
-- NULL - only during onboarding, which is exactly when it is worth paying for -
-- the console spends one round trip on `GET /v1/owner/setup`, and that endpoint
-- stamps this column the moment the required steps are done.
--
-- ── WHY EVERY EXISTING ORG IS BACKFILLED AS DONE ────────────────────────────
--
-- This is for clients who sign up from now on. A tenant that has been running
-- for months and never uploaded a logo does not need a banner telling them
-- their account is unfinished - they finished; they just skipped a step nobody
-- had asked for yet. Backfilling them as complete is what keeps this feature
-- invisible to everyone it was not built for.
--
-- The consequence, stated plainly: an existing org will never see the
-- checklist, even if it is genuinely missing a step. Clearing the column for
-- one org is a one-line UPDATE if somebody wants to re-run it for them.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS setup_completed_at timestamptz;

COMMENT ON COLUMN organizations.setup_completed_at IS
  'When this client finished the required setup steps (@aura/shared onboarding.ts). '
  'NULL means the console shows the setup banner and spends one extra round trip '
  'per page on GET /v1/owner/setup; non-NULL means it skips the checklist entirely. '
  'Stamped by that endpoint, never by hand.';

-- Every org that exists when this migration runs is, by definition, not a new
-- signup. `created_at` rather than `now()` so the timestamp does not claim they
-- completed setup at deploy time - they were complete before this column
-- existed, and the honest date is the one we have.
UPDATE organizations
   SET setup_completed_at = created_at
 WHERE setup_completed_at IS NULL;

-- No index. The only reads are by primary key, through the org row
-- `contextFor` already fetches, and a partial index on a column that is NULL
-- for a handful of rows at a time would never be chosen.
