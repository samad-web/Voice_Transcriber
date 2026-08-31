-- 0055_conversations.sql - the inbound side of messaging.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────
--
-- Aura can already SEND on WhatsApp (message_templates, the booking outbox,
-- the funnel handoff link). It could not RECEIVE. There was no inbound
-- webhook anywhere in apps/api, so when a lead replied to the message that
-- asked them to book, the reply went nowhere: not to a person, not to the
-- timeline, not to a queue. The enquiry simply stopped.
--
-- ── HOW THIS SITS WITH SAFETY RULE 1 ────────────────────────────────────
--
-- Track A's first safety rule says a synced message enters the CRM only once
-- its other side is already a contact, and that only subject/snippet are
-- stored, never bodies. That rule protects a REP'S OWN MAILBOX, which holds
-- their doctor, their payslips and their job applications, and it still
-- stands unchanged for connected_accounts/email_sync.
--
-- This table is the other thing. A message sent TO the business's own
-- WhatsApp/SMS number is business correspondence by construction - someone
-- deliberately wrote to the company. There is no private third-party traffic
-- to protect, and an inbox that hides the body is not an inbox. So bodies are
-- stored here and only here.
--
-- The contact-match half of the rule IS kept, in the form that fits an inbox:
-- contact_id is nullable and the peer address is always retained, so an
-- inbound message from an unrecognised number lands in an unmatched queue for
-- a human to claim. It is never dropped, and it never silently auto-creates a
-- contact - the same "human owns it" line rule 2 draws.
--
-- Rule 3 is untouched: nothing here sends. This migration adds storage and a
-- receive path. Outbound rows exist so a thread reads as a conversation, and
-- they are written by the existing human-composed send path, never by a rule.

-- ── conversations: the thread ───────────────────────────────────────────
--
-- Thread-level rather than per-message assignment. B2 Consultants' schema,
-- which this borrows from, put read-state and assignee on every message row;
-- that makes "who owns this conversation" a question you answer by looking at
-- the newest row and hoping, and it makes marking a thread read an UPDATE
-- over N rows. Ownership and read-state belong to the thread.
CREATE TABLE IF NOT EXISTS conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id   uuid REFERENCES workspaces(id) ON DELETE SET NULL,

  channel        text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),

  -- The normalised peer address: E.164 for phone channels, lower-cased
  -- address for email. This is what threads a reply onto the right
  -- conversation, and it is NOT NULL because a message with no identifiable
  -- sender cannot be threaded or replied to at all.
  peer_address   text NOT NULL,
  -- The display name the provider gave us, when it gave one. Advisory only:
  -- never used for matching (see UNMATCHABLE_DISPLAY_NAMES - a provider that
  -- reports "WhatsApp User" would otherwise match everybody).
  peer_label     text,

  -- SET NULL, not CASCADE: erasing a contact must not delete the record that
  -- a conversation happened. The thread survives, detached, the same way
  -- booking_slots keeps the appointment when its enquirer is erased.
  contact_id     uuid REFERENCES contacts(id) ON DELETE SET NULL,

  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'pending', 'closed')),
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  -- Denormalised for the inbox list, which orders by recency and badges
  -- unread. Maintained by the API on write; a COUNT(*) per row would be a
  -- query per thread on the one screen that shows every thread.
  last_message_at  timestamptz,
  last_inbound_at  timestamptz,
  unread_count     int NOT NULL DEFAULT 0 CHECK (unread_count >= 0),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  -- One thread per peer per channel per org. This is the idempotency anchor
  -- for the webhook: two replies arriving at once resolve to the same row.
  CONSTRAINT conversations_peer_unique UNIQUE (org_id, channel, peer_address)
);

-- The inbox opens on "newest first, unclosed" and filters by assignee.
CREATE INDEX IF NOT EXISTS conversations_org_recent
  ON conversations (org_id, last_message_at DESC NULLS LAST) WHERE status <> 'closed';
CREATE INDEX IF NOT EXISTS conversations_assignee
  ON conversations (org_id, assigned_user_id, last_message_at DESC NULLS LAST)
  WHERE status <> 'closed';
-- "Everything that came in from this person", for the contact timeline.
CREATE INDEX IF NOT EXISTS conversations_contact
  ON conversations (contact_id) WHERE contact_id IS NOT NULL;
-- The unmatched queue: inbound traffic nobody has claimed onto a contact.
CREATE INDEX IF NOT EXISTS conversations_unmatched
  ON conversations (org_id, last_inbound_at DESC) WHERE contact_id IS NULL;

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON conversations
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON conversations FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON conversations FROM PUBLIC;

DO $$ BEGIN
  CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── conversation_messages: the turns ────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

  -- 'incoming' / 'outgoing', spelled exactly as interactions.direction spells
  -- them (0040). Two vocabularies for one concept is how a JOIN starts
  -- silently returning nothing.
  direction       text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  channel         text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),

  -- 'received' is the only terminal state an inbound message has; the rest
  -- describe an outbound one's journey. Kept as one column because the inbox
  -- renders one ticker per row regardless of which way it went.
  status          text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'received')),

  from_address    text,
  to_address      text,
  subject         text,
  body            text,

  -- Provider provenance + the webhook idempotency key. Providers retry, and
  -- WATI in particular replays on any non-2xx, so the same reply can arrive
  -- three times; the partial unique index below makes the second and third
  -- arrivals no-ops instead of duplicate bubbles in the thread.
  provider        text,
  external_id     text,
  error           text,

  -- Null for inbound and for anything the outbox sent. Set only when a person
  -- composed it, which is the only way an outgoing row is ever created.
  sent_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,

  -- When the provider says it happened, not when we wrote the row: a webhook
  -- delivered late must not reorder the thread.
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The thread view: one conversation, oldest to newest.
CREATE INDEX IF NOT EXISTS conversation_messages_thread
  ON conversation_messages (conversation_id, occurred_at);
-- Idempotency. Partial because external_id is null for rows we originated
-- before a provider has acknowledged them, and a UNIQUE over nulls would
-- permit exactly the duplicates this is here to stop.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_external
  ON conversation_messages (org_id, provider, external_id)
  WHERE provider IS NOT NULL AND external_id IS NOT NULL;

ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON conversation_messages
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_messages TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON conversation_messages FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON conversation_messages FROM PUBLIC;

-- ── Permission grants for the new object type ───────────────────────────
-- Same predicate 0039/0041 used, so a role's conversation grants match its
-- contact grants. CrmPermissionsGuard denies anything ungranted, so without
-- this every existing user is locked out of the inbox the day it ships.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'conversation', a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete'), ('export')) AS a(action)
 WHERE r.is_system
   AND (
     r.key IN ('platform_admin', 'org_admin', 'workspace_admin')
     OR (r.key = 'workspace_member' AND a.action IN ('view', 'create', 'edit'))
     OR (r.key = 'viewer' AND a.action = 'view')
   )
   AND NOT EXISTS (
     SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.object_type = 'conversation' AND rp.action = a.action
   );
