-- 0047_calendar_sync.sql - PRD Layer 1, part 3: meetings on the timeline.
--
-- Calendar gets its OWN cursor and failure counter rather than sharing the
-- mail ones from 0044. A single connection can carry both capabilities (a
-- Google account is mail AND calendar), and one shared cursor would mean the
-- mail sweep advancing past events the calendar sweep had not read, or a
-- calendar 403 parking a mailbox that was working perfectly. Two capabilities
-- fail independently, so they count failures independently.

ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS calendar_cursor text;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS calendar_synced_at timestamptz;
ALTER TABLE connected_accounts ADD COLUMN IF NOT EXISTS calendar_failures int NOT NULL DEFAULT 0;

-- Which calendar events map to which timeline rows. `interactions.external_id`
-- (0044) is already scoped by (org_id, type, external_id), and a meeting's
-- type is 'meeting' where an email's is 'email' - so the two namespaces
-- cannot collide even if a provider reused an id across its APIs.
--
-- Nothing else is needed here: `interactions` already has `connection_id`,
-- `occurred_at`, `duration_s` and `metadata`, which is the whole shape a
-- meeting requires. A meeting is not a new kind of thing, it is a thing that
-- happened with a contact - which is what that table has always been for.

-- One index for the sweep's own "did I already write this" question. The
-- unique index from 0044 covers the write; this covers the cancellation path,
-- which looks a row up by connection to remove it.
CREATE INDEX IF NOT EXISTS interactions_connection_external
  ON interactions (connection_id, external_id)
  WHERE connection_id IS NOT NULL AND external_id IS NOT NULL;
