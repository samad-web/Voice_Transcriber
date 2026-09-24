-- 0138_email_sync_message_ids.sql - find an email on the timeline by its
-- RFC 5322 Message-ID.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- Every email sent from the console through Outlook appeared twice on the
-- timeline. The console wrote its row with no external_id, because Graph's
-- send hands back no id it could use: Graph ids change when an item changes
-- folder, and a sent draft moves to Sent Items. The mail sync then read the
-- Sent copy under its new id, and the unique index on (org, type,
-- external_id) (0044) had nothing to collapse.
--
-- The Message-ID is the one key both sides share. Both now record it in
-- `metadata.internet_message_id`, and each checks for it before writing:
-- the sync (apps/worker email-sync.ts) before inserting a synced copy, the
-- console (outbound-mail.controller.ts) before inserting its own row, which
-- covers the sync having read the Sent copy first.
--
-- ── WHY AN INDEX AND NOT A CONSTRAINT ──────────────────────────────────────
--
-- A unique index would make the rule absolute, but the same Message-ID can
-- legitimately sit on two rows: two colleagues who were both sent one
-- customer email each keep their own row, as they always have. Both checks
-- are scoped to one connection for that reason, and this index serves
-- exactly that lookup - without it each check is a scan of the org's whole
-- timeline, once per send and once per synced Outlook message.
--
-- Partial, so it holds only the rows that carry the key: Outlook syncs and
-- console sends, not calls, notes or Gmail mail. `connection_id = $1 AND
-- metadata->>'internet_message_id' = $2` implies both predicates, so the
-- planner can use it for those queries as written.
--
-- No backfill. Rows written before this carry no Message-ID, and the
-- duplicates they already produced stay as they are - deciding which of two
-- existing rows to delete is a data fix for a person, not a migration.

CREATE INDEX IF NOT EXISTS interactions_connection_message_id
  ON interactions (connection_id, (metadata->>'internet_message_id'))
  WHERE connection_id IS NOT NULL AND (metadata->>'internet_message_id') IS NOT NULL;
