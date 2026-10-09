------------------------------------------------------------------------------
-- 0170_stage_pack_persisted.sql - remember which business this is.
--
-- ── THE ONE COLUMN THAT MAKES THE VERTICALS REAL (Build docs/40 §D, F8) ─────
--
-- `packages/shared/src/stage-packs.ts` ships seven industry packs - clinic,
-- property, services, education, retail, finance, general - and applying one
-- renames six pipeline columns and stops. An audit called that the single
-- genuinely cosmetic thing in the product, and doc 39 §1289 had already said so
-- in its own words: "And then the pack renames six pipeline columns and stops.
-- That is the real gap."
--
-- The reason it stops is this column's absence. `resources.controller.ts` says
-- it outright: "NOTHING PERSISTS THE CHOICE - there is no column anywhere that
-- says a tenant is a clinic. Persisting the pack is a one-column migration
-- somebody should do; it is not this wave's." This is that wave.
--
-- With the choice recorded, three things that already exist start working:
--
--   * `resourceTypeSuggestions(packId)` has a packId. A clinic's resource
--     picker offers chair / room / scanner / station / class instead of the
--     general pack's item / slot / date.
--   * `GET /resources/types` stops needing the caller to tell it who the tenant
--     is - a question no caller could answer, which is why every call passed
--     nothing and got the general fallback.
--   * `packSlotMinutes(packId)` gives the diary a sensible default length: 30
--     minutes for a clinic room, 45 for a salon station, 2 hours for a property
--     site visit (doc 39 §1387 names these).
--
-- ── WHY THERE IS NO CHECK LISTING THE SEVEN PACKS ──────────────────────────
--
-- Same reasoning `org_feature_settings.feature_key` gives in 0101, and it has
-- already been tested by events: the catalogue is TypeScript read by both
-- tiers, and a CHECK here would be a third copy of it that only fails at write
-- time, in production, after the code that writes it shipped. `notifications.kind`
-- drifted in both directions at once that way.
--
-- The shape IS constrained, because a value that is not a pack id is a bug in
-- the caller rather than a pack nobody has heard of. And an unknown id stays
-- SAFE to hold: `resourceTypeSuggestions` falls back to the general pack rather
-- than throwing, precisely so a tenant whose pack was renamed still gets a
-- picker instead of an empty screen.
--
-- ── NULL IS NOT "general" ──────────────────────────────────────────────────
--
-- NULL means nobody has chosen, which is every tenant that exists on the day
-- this runs. It reads the same as `general` through
-- `resourceTypeSuggestions(null)`, deliberately - but the two are different
-- facts, and only the column can tell "they looked at the packs and picked the
-- plain one" from "they have never been asked". The onboarding prompt needs
-- that difference; a DEFAULT would destroy it.
------------------------------------------------------------------------------

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS stage_pack text;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_stage_pack_shape;
ALTER TABLE organizations ADD CONSTRAINT organizations_stage_pack_shape
  CHECK (stage_pack IS NULL OR stage_pack ~ '^[a-z][a-z0-9_]{0,47}$');

COMMENT ON COLUMN organizations.stage_pack IS
  'Which industry pack this workspace applied (packages/shared/src/stage-packs.ts). '
  'Written by POST /pipelines/:id/apply-stage-pack. Drives the resource-type '
  'picker and the diary''s default slot length. NULL means never chosen, which '
  'is NOT the same fact as the general pack. No enumerating CHECK on purpose - '
  'see 0101 on feature_key, and notifications.kind for what drift costs.';
