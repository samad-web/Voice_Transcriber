-- 0044_email_sync.sql - PRD Layer 1, part 2: what inbound mail sync needs.
--
-- Two additive columns, no new table. The timeline that emails land on
-- already exists (0040); this gives it an idempotency key, and gives each
-- connection somewhere to remember how far it has read.

-- ── The idempotency key for anything synced from a provider ───────────────
--
-- Calls already have one: `interactions(call_id)`. An email has no call, so
-- without this a sync that overlaps its own window - which every date-based
-- cursor does, deliberately, to avoid dropping messages that arrive during a
-- poll - would post the same message to the timeline repeatedly.
--
-- Scoped by (org, type, external_id) rather than external_id alone: message
-- ids are only unique within a provider's own namespace, and a Gmail id and a
-- Graph id could in principle collide.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS external_id text;

CREATE UNIQUE INDEX IF NOT EXISTS interactions_external
  ON interactions (org_id, type, external_id) WHERE external_id IS NOT NULL;

-- Which connection produced a synced row. Lets a disconnect take its imported
-- history with it if that is ever wanted, and makes "where did this come
-- from" answerable. SET NULL rather than CASCADE: disconnecting a mailbox
-- should not silently delete the record of conversations that happened.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS connection_id uuid
  REFERENCES connected_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS interactions_connection
  ON interactions (connection_id) WHERE connection_id IS NOT NULL;


-- ── How far each connection has read ──────────────────────────────────────
--
-- Opaque and provider-defined: Gmail hands back a historyId, Graph a delta
-- link, IMAP a UID. Storing it as text keeps this column from caring which,
-- exactly as `external_ids` on contacts does not care whose id it holds.
--
-- `last_synced_at` (0043) stays the human-facing "when did this last run";
-- this is the machine's place, and the two are not interchangeable - a sync
-- that ran and found nothing advances the first but not necessarily this.
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS sync_cursor text;

-- Consecutive failures, so a mailbox that is permanently broken (revoked
-- token, deleted account) can be backed off rather than retried every minute
-- forever.
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS sync_failures int NOT NULL DEFAULT 0;
