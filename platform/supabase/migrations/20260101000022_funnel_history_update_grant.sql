------------------------------------------------------------------------------
-- 0022 — let step 2 of the funnel finish
--
-- THE BUG THIS FIXES
--
-- 0020 granted `aura_marketing` only SELECT and INSERT on funnel_contact_history,
-- on the stated reasoning that history is append-only ("history APPENDs", 0020's
-- grants block). But the funnel does not append at step 2 — it UPDATEs the row
-- step 1 created, which is why the signed session cookie carries `hid` (the
-- history row id) alongside `sid` at all.
--
-- The result: step 1 saved, the visitor advanced to step 2, filled in six
-- questions, pressed Submit, and got "We couldn't save your answers." Every
-- time, for everyone. Server-side it was `permission denied for table
-- funnel_contact_history`.
--
-- It was invisible until the funnel ran against a database with the real grants
-- applied. Nothing in typecheck, lint or the unit tests can see a missing
-- GRANT — only executing it can.
--
-- WHY THIS IS A COLUMN-SCOPED GRANT
--
-- Table-wide UPDATE would fix the error and throw away the property 0020 was
-- protecting. The seven columns below are this fill's ANSWERS, which step 2
-- exists to write. The columns deliberately left out are the audit trail:
--
--   occurred_at      when this fill happened
--   submitted_email  what they typed, before normalisation
--   submitted_phone  ditto
--   match_reason     why this fill was matched to an existing submission
--   submission_id    which submission it belongs to
--   variant, utm     acquisition attribution
--
-- Those are written once at step 1 and must stay that way. A public web server
-- that can rewrite how a lead was attributed, or which enquiry a fill belongs
-- to, has an audit trail that proves nothing.
------------------------------------------------------------------------------

GRANT UPDATE (
  business_type,
  team_size,
  budget_inr,
  intent,
  has_crm,
  crm_name,
  wants_custom_crm
) ON marketing.funnel_contact_history TO aura_marketing;

------------------------------------------------------------------------------
-- 0020's ALTER DEFAULT PRIVILEGES grants table-wide SELECT/INSERT/UPDATE on any
-- FUTURE table in this schema, which is broader than anything above. Left as is
-- deliberately: narrowing it would silently break the next migration that adds
-- a funnel table, and the funnel role still cannot reach outside this schema.
-- Worth revisiting if the schema ever holds something the form should not write.
------------------------------------------------------------------------------
