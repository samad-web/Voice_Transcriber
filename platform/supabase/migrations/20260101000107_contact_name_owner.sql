-- 0107_contact_name_owner.sql - a name a person typed outranks a name a call
-- extracted (the human-owns-it rule, Track A safety rule 2).
--
-- The Lead -> Contact projection (packages/db/src/crm-projection.ts) upgrades a
-- phone-matched contact's display_name on every follow-up call, from whatever
-- the AI read off that call. That was right while nobody else wrote the column.
-- It stopped being right the moment PATCH /v1/contacts accepted a displayName:
-- a rep corrects "Daniel Gautham, Sir" to "Daniel Gautham", the next call
-- quietly writes the extraction back, and nothing anywhere explains why.
--
-- NULL means the name is still the machine's to improve. A timestamp means a
-- person set it, and the projection must leave it alone. A timestamp rather
-- than a boolean so "since when is this name a human's" is answerable.
--
-- Additive only. Existing rows stay NULL, which is honest: until now nothing
-- recorded who set a name, so every existing name is treated as the machine's.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS display_name_set_by_human_at timestamptz;
