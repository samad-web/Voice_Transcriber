-- 0121_agent_studio.sql - every tenant gets its own AI Agent Studio.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--
-- Since 0001 an `agents` row has meant exactly one thing: "read a call's
-- transcript and pull these fields out of it". Only the platform operator
-- could write one, from the operator console, and a tenant whose operator had
-- not got round to it produced no leads at all - silently.
--
-- The owner console now carries a studio of its own, and an agent can be one
-- of three KINDS:
--
--   call_extractor  the original: fields from a call transcript, which decide
--                   whether the call becomes a lead (agents.lead_rules).
--   chat_qualifier  the tenant's own criteria and extra fields for qualifying
--                   a WhatsApp thread (0080). It shapes the verdict; a person
--                   still approves every lead - that CHECK is untouched.
--   reply_drafter   writes a suggested follow-up for a call or a thread when a
--                   person asks for one. It stores nothing and sends nothing:
--                   the person edits the text and sends it themselves.
--
-- None of the three can send a message. That is not an omission to fill in
-- later - see crm-track-a's third safety rule.
--
-- ── WHY `kind` IS A CHECK HERE ──────────────────────────────────────────────
--
-- The worker's extraction query must only ever pick a call_extractor. A kind
-- the database accepted but no code knew about would be a row that silently
-- never runs, so the list is closed at the write. It is kept in step with
-- `AgentKind` in packages/shared/src/agent-kinds.ts, and agent-kinds.test.ts
-- reads THIS file to fail when the two drift - the notification-kind CHECK
-- drifted from its zod enum once already and threw 23514 in production.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'call_extractor';
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_kind_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_kind_check
  CHECK (kind IN ('call_extractor', 'chat_qualifier', 'reply_drafter'));

-- What the agent is FOR, in the owner's own words. Shown on the studio card so
-- a manager opening the page next month can tell three agents apart without
-- reading their instructions.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT '';
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_purpose_length;
ALTER TABLE agents
  ADD CONSTRAINT agents_purpose_length CHECK (char_length(purpose) <= 1000);

-- Kind-specific settings (a drafter's tone and length, for instance). Validated
-- by the API against `AgentConfig` in the same shared file; unconstrained here
-- for the reason 0101 gives for feature keys - the shape grows, and a CHECK
-- that cannot import TypeScript is a copy that fails at write time.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ── ARCHIVING, NOT DELETING ─────────────────────────────────────────────────
--
-- `calls.agent_id/agent_version`, `ai_outputs` and `leads` all record which
-- version read a call, with no foreign key (0001). Deleting an agent would
-- leave those pointing at nothing, and "which rules made this a lead" would
-- stop being answerable. Archiving hides it from the studio and stops it being
-- activated; the rows stay. Set on every version of the id at once.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_archived_is_inactive;
ALTER TABLE agents
  ADD CONSTRAINT agents_archived_is_inactive CHECK (archived_at IS NULL OR NOT is_active);

-- ── WORKSPACE BELONGS TO CALLS ONLY ─────────────────────────────────────────
--
-- A call lives in a workspace and the worker resolves its extractor through
-- `calls.workspace_id`, so an extractor must name one. A WhatsApp thread's
-- workspace is nullable (0055) and qualification runs per ORGANISATION, so a
-- chat qualifier or drafter pinned to a workspace would be a second, invisible
-- dimension along which "is my agent running?" could be answered no.
ALTER TABLE agents ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_workspace_matches_kind;
ALTER TABLE agents
  ADD CONSTRAINT agents_workspace_matches_kind
  CHECK ((kind = 'call_extractor') = (workspace_id IS NOT NULL));

-- ── ONE ACTIVE AGENT PER KIND ───────────────────────────────────────────────
--
-- Until now "one active agent per workspace" was the API's promise alone
-- (deactivate-all-then-activate), and the worker's `ORDER BY version DESC
-- LIMIT 1` quietly picked between several when a script had left more than one
-- on. The index makes it structural.
--
-- Before it can be built, any workspace holding several active extractors is
-- reduced to the ONE the worker was already using - highest version first,
-- newest row on a tie - so no call is read differently the day this deploys.
DO $$
DECLARE
  demoted int;
BEGIN
  WITH ranked AS (
    SELECT id, version,
           row_number() OVER (PARTITION BY workspace_id
                              ORDER BY version DESC, created_at DESC) AS rn
      FROM agents
     WHERE is_active AND kind = 'call_extractor'
  )
  UPDATE agents a
     SET is_active = false
    FROM ranked r
   WHERE a.id = r.id AND a.version = r.version AND r.rn > 1;
  GET DIAGNOSTICS demoted = ROW_COUNT;
  IF demoted > 0 THEN
    RAISE WARNING '0121: deactivated % duplicate active call extractor row(s), keeping the one the worker already used', demoted;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS agents_one_active_extractor_per_workspace
  ON agents (workspace_id)
  WHERE is_active AND kind = 'call_extractor';

CREATE UNIQUE INDEX IF NOT EXISTS agents_one_active_per_org_kind
  ON agents (org_id, kind)
  WHERE is_active AND kind <> 'call_extractor';

-- The studio lists by org and kind on every open.
CREATE INDEX IF NOT EXISTS agents_org_kind ON agents (org_id, kind, name);

-- ── CHAT QUALIFIER PROVENANCE AND PRIVACY ───────────────────────────────────
--
-- Which agent version judged a thread, the same provenance `ai_outputs` keeps
-- for calls. NULL = the built-in prompt, which is what every row written
-- before this migration used. No foreign key, for the reason archiving exists.
ALTER TABLE conversation_qualifications ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE conversation_qualifications ADD COLUMN IF NOT EXISTS agent_version int;

-- A tenant's extra fields land in `facts` (0080 created it; nothing wrote it
-- until now). 0082's rule - a personal message, a wrong number or spam may
-- record THAT it was judged and may not keep what was said - has to cover
-- them too, or a qualifier asking for "what they want to buy" would store a
-- private message's content in the one column the CHECK does not look at.
-- Every existing row is '{}' (nothing wrote the column), so this validates.
ALTER TABLE conversation_qualifications
  DROP CONSTRAINT IF EXISTS qualification_private_threads_keep_nothing;
ALTER TABLE conversation_qualifications
  ADD CONSTRAINT qualification_private_threads_keep_nothing CHECK (
    disposition NOT IN ('personal', 'wrong_number', 'spam')
    OR (extracted_name IS NULL AND extracted_email IS NULL
        AND extracted_company IS NULL AND extracted_budget IS NULL
        AND extracted_notes IS NULL AND facts = '{}'::jsonb)
  );
