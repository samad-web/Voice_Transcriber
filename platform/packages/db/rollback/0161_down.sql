-- 0161_down.sql - reverse the web form builder.
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0161_down.sql
--
-- ── READ THIS FIRST: THIS BREAKS PUBLISHED LINKS ───────────────────────────
--
-- Every `/f/<slug>` a tenant has put in an email signature, a Google Ads
-- landing page, a WhatsApp broadcast or a printed card stops answering the
-- moment this runs. There is no redirect and nothing to fall back on - the
-- route resolves a row in `web_forms` and there will be no table.
--
-- Keep the definitions before dropping them. They are small, they are the only
-- copy, and re-authoring a twenty-field form by hand is an afternoon:
--
--   \copy (SELECT w.slug, w.name, w.status, w.definition, w.field_map,
--                 w.consent_required, w.consent_text, w.theme, w.redirect_url,
--                 w.thank_you_text, w.submit_count, s.name AS source_name,
--                 s.intake_token
--            FROM web_forms w JOIN lead_sources s ON s.id = w.source_id)
--     TO 'web-forms.csv' CSV HEADER
--
-- ── WHAT IS DELIBERATELY NOT UNDONE ────────────────────────────────────────
--
-- The `lead_sources` rows the builder created are LEFT IN PLACE, and so is
-- every lead, `lead_intake_events` row and `contact_numbers` row that came
-- through them.
--
-- Deleting them is the obvious-looking move and it is wrong twice over. The
-- leads are real customers who really did fill a form in; removing their source
-- would re-point every attribution report at nothing and leave the ledger
-- referring to a source id that no longer exists. And a vault row carries a
-- consent basis with evidence - "they ticked this sentence on this date" is a
-- record that outlives the form it was collected on, which is the entire reason
-- 0157 stores the evidence rather than a boolean.
--
-- A source whose form is gone shows up in the console as an ordinary web-form
-- source with a token, which is what it is. Retire it there with
-- `status = 'disabled'` if that is what you want.
--
-- Find them afterwards:
--
--   SELECT id, name, created_at FROM lead_sources
--    WHERE kind = 'web_form' AND config ? 'honeypotField'
--    ORDER BY created_at DESC;

BEGIN;

-- 1. The table. Its indexes, its CHECK and its trigger go with it.
DROP TABLE IF EXISTS web_forms;

-- 2. The permission grants. Custom roles are included even though 0161 never
--    seeded them: a row for this object type can only have come from 0161 or
--    from somebody editing the grid afterwards, and leaving orphan grants for
--    an object the API no longer knows is worse than losing a hand edit.
--
--    Check for hand edits first if you care about them:
--      SELECT r.key, rp.action, rp.scope FROM role_permissions rp
--        JOIN roles r ON r.id = rp.role_id
--       WHERE rp.object_type = 'web_form' AND NOT r.is_system;
DELETE FROM role_permissions WHERE object_type = 'web_form';

DELETE FROM schema_migrations WHERE name = '0161_web_form_builder.sql';

COMMIT;
