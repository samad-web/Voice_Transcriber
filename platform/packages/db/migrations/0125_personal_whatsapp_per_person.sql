-- 0125_personal_whatsapp_per_person.sql - a personal WhatsApp number belongs
-- to a PERSON, and its chats are theirs alone.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--
-- 0123 let an organisation link ONE ordinary WhatsApp number, from the owner's
-- WhatsApp Setup page, and its threads landed in the shared inbox like any
-- business number's. That is the wrong owner for the thing being linked. A
-- personal number is somebody's own phone: the telecaller's, the sales rep's.
-- They should be able to link it themselves, without asking anybody, and what
-- is said on it should be visible to them and nobody else - not a manager, not
-- the owner, not the platform operator.
--
-- So from here:
--   - `messaging_channels.owner_user_id` names the person a personal
--     (provider = 'evolution') channel belongs to, and a personal channel
--     cannot exist without one;
--   - `conversations.private_to_user_id` stamps every thread that arrives on
--     such a channel with that person;
--   - and the per-org "one thread per customer" rule becomes "one SHARED
--     thread per customer, plus one PRIVATE thread per customer per person".
--
-- ── WHY THE PRIVACY IS A COLUMN ON THE THREAD, NOT A JOIN TO THE CHANNEL ─────
--
-- Every read path has to filter on it, and there are a dozen: the inbox list,
-- the thread, sending, drafting, the qualification queue, the opt-out queue,
-- Agent Studio's samples, the contact timeline. A predicate on the thread's own
-- row is one clause each (apps/api/src/common/private-threads.ts). A join to
-- the channel is one more join in each, and the first one somebody forgets is
-- a disclosure. The column is written once, at ingest, from the channel.
--
-- ── WHY ON DELETE CASCADE, AGAINST THIS SCHEMA'S USUAL SET NULL ──────────────
--
-- Everywhere else here, losing a person must not lose the correspondence
-- (0055, 0056). This is the one place where SET NULL would be a disclosure: a
-- private thread whose owner is nulled becomes a SHARED thread, and a
-- telecaller's private chats would appear in everyone's inbox. Nothing in this
-- product deletes a `users` row today; if something ever does, the only
-- private-preserving outcome is that the person's private chats go with them.
-- Removing someone from a team deletes their MEMBERSHIP, not their user, and
-- the API disables their personal channel at that moment instead.
--
-- ── WHY RLS DOES NOT ENFORCE IT ─────────────────────────────────────────────
--
-- Row-level security here keys on `app.org_id` alone; nothing sets a per-user
-- setting, and the worker - which must still qualify and score these threads -
-- has no user at all. So the rule lives in the API, in one helper, and
-- `private-threads.spec.ts` fails the build when an API query reads
-- `conversations` without it (or without being on its reviewed allowlist).

-- 1 ── WHO A PERSONAL NUMBER BELONGS TO ─────────────────────────────────────

ALTER TABLE messaging_channels
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;

-- A personal number with no person is the org-wide shape this migration
-- retires. None exists in production (checked before writing this); a
-- development database that has one gets the reason in the log rather than a
-- bare constraint violation.
DO $$
DECLARE
  orphans int;
BEGIN
  SELECT count(*) INTO orphans
    FROM messaging_channels
   WHERE provider = 'evolution' AND owner_user_id IS NULL;
  IF orphans > 0 THEN
    RAISE WARNING '0125: % personal WhatsApp channel(s) have no owner. Unlink them from WhatsApp Setup (or delete the rows) and re-run; each person links their own number from their Inbox now.', orphans;
  END IF;
END $$;

ALTER TABLE messaging_channels
  DROP CONSTRAINT IF EXISTS messaging_channels_personal_has_owner;
ALTER TABLE messaging_channels
  ADD CONSTRAINT messaging_channels_personal_has_owner
  CHECK (provider <> 'evolution' OR owner_user_id IS NOT NULL);

-- And only personal numbers have one. A WABA belongs to the business; an
-- owner on it would read as "this business number is private to Priya".
ALTER TABLE messaging_channels
  DROP CONSTRAINT IF EXISTS messaging_channels_owner_only_personal;
ALTER TABLE messaging_channels
  ADD CONSTRAINT messaging_channels_owner_only_personal
  CHECK (owner_user_id IS NULL OR provider = 'evolution');

-- One personal number per person per organisation. The pairing controller
-- relinks the same row rather than adding a second, so a changed SIM keeps
-- the person's history in one place.
CREATE UNIQUE INDEX IF NOT EXISTS messaging_channels_one_personal_per_person
  ON messaging_channels (org_id, owner_user_id)
  WHERE owner_user_id IS NOT NULL;

-- 2 ── WHOSE A THREAD IS ────────────────────────────────────────────────────

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS private_to_user_id uuid REFERENCES users(id) ON DELETE CASCADE;

-- A private thread is always assigned to its owner. The permission grid's
-- "own records" scope reads `assigned_user_id`, so a telecaller whose grid
-- says "own" would otherwise be unable to see their own private chat.
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_private_is_assigned_to_owner;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_private_is_assigned_to_owner
  CHECK (private_to_user_id IS NULL OR assigned_user_id = private_to_user_id);

-- 3 ── ONE SHARED THREAD PER CUSTOMER, ONE PRIVATE THREAD PER PERSON ─────────
--
-- The old key was (org, channel, peer): a customer who messaged two reps'
-- personal numbers would have been folded into ONE thread, and each rep would
-- have read the other's conversation. Two partial unique indexes replace it -
-- the ingest upsert names whichever one applies as its conflict target.

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_peer_unique;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_peer_shared
  ON conversations (org_id, channel, peer_address)
  WHERE private_to_user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_peer_private
  ON conversations (org_id, channel, peer_address, private_to_user_id)
  WHERE private_to_user_id IS NOT NULL;
