-- 0105_lead_routing.sql - automated lead distribution: rules that hand an
-- incoming lead to a telecaller, by rotation or by a percentage split.
--
-- ── WHAT THIS REVERSES, AND WHY ─────────────────────────────────────────────
--
-- 0078 wrote, at `lead_sources.assigned_telecaller_id`:
--
--     "Round-robin is deliberately NOT here. One named owner is a decision a
--      person made; a rotation is a scheduling policy, and this table is not a
--      scheduler."
--
-- That reasoning still holds and this migration does not contradict it: the
-- scheduler is NOT on `lead_sources`. It is its own three tables, and a source
-- pinned to one named owner still wins outright over every rule here. What has
-- changed is that the platform now has somewhere for a scheduling policy to
-- live, which is what that comment was declining to invent inline.
--
-- CRM_STATUS.md §3.1 named the gap in the same words - "no round-robin
-- assignment, no lead routing rules" - and this closes it.
--
-- ── THE THREE TABLES ────────────────────────────────────────────────────────
--
--   lead_routing_rules       which leads, and by what policy
--   lead_routing_targets     who is on the rotation, and for how much of it
--   lead_routing_assignments what the engine actually decided, and why
--
-- The same split `automation_rules` / `automation_runs` draws, for the same
-- reason: a rule is configuration a person edits, a decision is history that
-- must survive the rule being edited. A manager asking "why did Ravi get that
-- one" is asking about the state the engine saw at the time, not about the
-- rule as it reads today.
--
-- ── WHAT ROUTING MAY AND MAY NOT TOUCH ──────────────────────────────────────
--
-- It only ever fills a NULL `leads.assigned_telecaller_id`. It never moves a
-- lead off somebody, never overrides a source's named owner, and never fires on
-- a lead that already exists - only on creation, and on an explicit backfill an
-- owner asked for.
--
-- This is HUMAN-OWNS-IT, the same rule 0073 applies to `project_source` and
-- 0078 applies to attribution, and it is the single most important property
-- here. A distribution engine that can reassign live leads is one bad rule away
-- from moving a whole floor's work overnight, and the person it happened to
-- cannot tell it from data loss.
--
-- ── WHY CALL LEADS ARE NOT ROUTED BY DEFAULT ────────────────────────────────
--
-- A lead created by the handset pipeline already has a human on it: whoever
-- made or answered the call (`leads.telecaller_id`, write-once since 0017).
-- Routing it to somebody else would take a conversation off the person who had
-- it. So the worker's `upsertLead` is deliberately NOT wired to this engine.
-- 'call' is still in the `sourceChannels` vocabulary a rule can match on,
-- because the backfill path can reach an old call lead nobody was ever bound
-- to - but the live call path does not call the router.
--
-- ── WHERE THE ENGINE RUNS ───────────────────────────────────────────────────
--
-- Inside the intake transaction, not on a queue. Unlike `automation_events`,
-- which is deliberately asynchronous, an assignment cannot wait: 0093 measures
-- `leads.first_responded_at`, and a lead that sits unassigned for a minute is a
-- lead nobody has been told about. The cost of doing it inline is one locked
-- row per rule, held for the tail of a transaction that was already short.
--
-- It is wrapped in a SAVEPOINT by the caller (packages/db/src/lead-routing.ts),
-- so a routing failure loses the assignment and NEVER the lead. That direction
-- is not negotiable - an unassigned lead on the board is a visible problem, a
-- lost lead is not a problem anybody ever sees.

-- ── 1. The rules ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_routing_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL routes leads from every desk in the org. A tenant running two sales
  -- floors out of one org gets one rule each; most tenants leave it null.
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,

  name        text NOT NULL,
  description text,

  -- 'round_robin' - strict rotation over the target list, driven by `cursor`.
  -- 'percentage'  - each target holds a share of the volume, driven by the
  --                 per-target `delivered` counts.
  -- A CHECK rather than an app-validated open set, unlike automation.trigger:
  -- the two strategies read DIFFERENT state columns, so a third value would
  -- not be a rule that quietly does nothing, it would be a rule that reads
  -- uninitialised state. See @aura/shared's lead-routing.ts for the algorithms.
  strategy text NOT NULL CHECK (strategy IN ('round_robin', 'percentage')),

  -- Which leads this is about: sourceChannels / leadSourceIds / projectIds /
  -- minValue, validated against LeadRoutingMatch. Field comparisons as data,
  -- never an expression language - the same call automation_rules.conditions
  -- makes. `{}` matches every lead, which is how a catch-all is expressed:
  -- not a special row type, just a rule with no criteria and a high priority
  -- number.
  match jsonb NOT NULL DEFAULT '{}'::jsonb,

  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),

  -- Lower runs first. FIRST MATCH WINS - a lead has one owner, so running
  -- every matching rule would mean the last one silently overwrote the rest
  -- and precedence would depend on row order. This makes it something the
  -- tenant SET rather than something they discovered.
  priority int NOT NULL DEFAULT 100,

  -- ── Rotation state ────────────────────────────────────────────────────────
  -- An INDEX into the ordered target list, taken modulo its length, not a
  -- telecaller id. A departing target would leave an id dangling and need a
  -- "what if that person left" branch, and that branch is where rotations
  -- quietly become "always the first person".
  cursor bigint NOT NULL DEFAULT 0,

  -- When the percentage accounting last restarted. Editing the split resets
  -- the window, and it has to: somebody moved from 50% to 20% carries a
  -- delivered count that would starve them for weeks under the new ratio.
  -- "The split restarts when you change it" is both correct and explainable.
  window_started_at timestamptz NOT NULL DEFAULT now(),

  assigned_count   bigint NOT NULL DEFAULT 0,
  last_assigned_at timestamptz,

  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The engine's only read: this org's active rules, in precedence order.
CREATE INDEX IF NOT EXISTS lead_routing_rules_org_priority
  ON lead_routing_rules (org_id, priority, created_at)
  WHERE status = 'active';

COMMENT ON COLUMN lead_routing_rules.cursor IS
  'Round-robin position as an INDEX into the ordered target list, modulo its '
  'length - never a telecaller id, so adding or removing a target cannot '
  'leave it dangling.';

-- ── 2. Who is on the rotation ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_routing_targets (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES lead_routing_rules(id) ON DELETE CASCADE,

  -- CASCADE, not SET NULL: a target with no telecaller is not a historical
  -- fact worth keeping, it is a hole in a rotation that would silently shrink
  -- everybody else's share. The DECISIONS that person took keep their own
  -- reference in lead_routing_assignments, which is SET NULL for exactly the
  -- opposite reason - see below.
  telecaller_id uuid NOT NULL REFERENCES telecallers(id) ON DELETE CASCADE,

  -- Percentage strategy only. Whole-ish percents, validated in the app to sum
  -- to 100 across the rule - see sharesProblem() for why 100 and not free
  -- weights. Kept (not cleared) on a round-robin rule so switching strategies
  -- back and forth does not lose the split somebody typed.
  --
  -- 0 is a real, useful state: "on this rule, keeping their counters, not
  -- currently receiving". The engine treats it as ineligible rather than as a
  -- tie-breaking zero deficit.
  share_pct numeric(6,3) NOT NULL DEFAULT 0 CHECK (share_pct >= 0 AND share_pct <= 100),

  -- Round robin's sequence IS this order. Ties fall back to id so the order is
  -- total - an unstable sort here would make the rotation depend on row
  -- layout, which is the kind of bug that only shows up after a VACUUM.
  position int NOT NULL DEFAULT 0,

  -- Off the rotation without being removed from it: leave, training, a bad
  -- week. Distinct from a 0% share, which is a deliberate long-term bench.
  paused boolean NOT NULL DEFAULT false,

  -- Refuse more than this many leads in one day. Applies to BOTH strategies -
  -- a rotation that keeps feeding somebody who cannot work the leads is not
  -- fairer than one that skips them.
  daily_cap int CHECK (daily_cap IS NULL OR daily_cap > 0),

  -- ── Counters ──────────────────────────────────────────────────────────────
  -- `delivered` is scoped to the rule's allocation WINDOW, not to all time -
  -- it is the number the percentage deficit is computed against, and it is
  -- zeroed when the split is edited.
  delivered bigint NOT NULL DEFAULT 0,

  -- Today's count, for the cap. Stored rather than counted from
  -- lead_routing_assignments so the hot path stays two index lookups instead
  -- of an aggregate over a table that grows forever. `counter_day` is the
  -- date IN THE ORG'S REPORTING TIMEZONE (0090) that `assigned_today` belongs
  -- to; the engine zeroes the pair when it rolls over. A stored counter with
  -- no date beside it is how a daily cap becomes a lifetime cap.
  assigned_today int  NOT NULL DEFAULT 0,
  counter_day    date,

  last_assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One row per person per rule. Two rows would be a hidden double share, and
  -- the console has no way to render it.
  UNIQUE (rule_id, telecaller_id)
);

-- The engine's second read: this rule's targets, in rotation order.
CREATE INDEX IF NOT EXISTS lead_routing_targets_rule
  ON lead_routing_targets (rule_id, position, id);

-- "Which rotations is this person on?" - the team page's answer when somebody
-- is about to be archived.
CREATE INDEX IF NOT EXISTS lead_routing_targets_telecaller
  ON lead_routing_targets (org_id, telecaller_id);

COMMENT ON COLUMN lead_routing_targets.delivered IS
  'Leads taken since lead_routing_rules.window_started_at - NOT an all-time '
  'total. Editing a percentage split zeroes it, because a share that changed '
  'cannot be reconciled against volume delivered under the old one.';

-- ── 3. What the engine decided ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lead_routing_assignments (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- SET NULL on both, and deliberately not CASCADE: "this lead went to Ravi on
  -- the 4th under the Meta rule" stays true after the rule is deleted and
  -- after Ravi's telecaller row is archived away. A decision log that
  -- disappears when the thing it describes is edited cannot answer the only
  -- question it exists for.
  rule_id       uuid REFERENCES lead_routing_rules(id) ON DELETE SET NULL,
  telecaller_id uuid REFERENCES telecallers(id)        ON DELETE SET NULL,

  -- CASCADE here, unlike the two above: this row names a specific lead, and
  -- the tenancy erasure path (0043) deletes leads outright. A log row pointing
  -- at an erased person is exactly what erasure is meant to remove.
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,

  -- Denormalised from the rule ON PURPOSE. The rule's strategy and the
  -- telecaller's name at the time are what make an old decision readable; both
  -- are editable, and re-deriving them from today's rows would silently
  -- rewrite history. Same argument call_sop_results makes for storing the SOP
  -- version it judged against.
  strategy       text NOT NULL,
  telecaller_name text,

  outcome text NOT NULL CHECK (outcome IN ('assigned', 'unassigned')),
  -- The engine's own sentence: "Priya was 1.4 leads below their 50% share",
  -- "every telecaller on this rule is paused". Prose rather than a code
  -- because this is read by the person deciding whether the rule is right, not
  -- branched on by software - the machine-readable half is `outcome`.
  reason  text,

  -- 'intake' - a lead arrived. 'backfill' - an owner pressed Distribute now.
  trigger text NOT NULL CHECK (trigger IN ('intake', 'backfill')),

  created_at timestamptz NOT NULL DEFAULT now()
);

-- The console's decision log: this org's most recent decisions, newest first.
CREATE INDEX IF NOT EXISTS lead_routing_assignments_org_recent
  ON lead_routing_assignments (org_id, created_at DESC);

-- "Show me this rule's history" and "how many did this rule refuse".
CREATE INDEX IF NOT EXISTS lead_routing_assignments_rule_recent
  ON lead_routing_assignments (rule_id, created_at DESC)
  WHERE rule_id IS NOT NULL;

-- One decision per lead per outcome is not enforced, deliberately: a lead can
-- legitimately be refused by a rule at intake (everybody capped) and assigned
-- by a backfill the next morning. Both are true and both must be readable.

-- ── 4. Notifications learn a new kind ───────────────────────────────────────
--
-- `notifications.kind` is app-validated against NotificationKind (0048) rather
-- than CHECKed, so widening it needs no DDL - this comment is here so the
-- vocabulary is discoverable from the schema, which is where somebody reading
-- an unfamiliar `kind` value will look first.
--
--   lead_assigned - the routing engine gave you a lead.
--
-- Only ever reaches a telecaller BOUND TO A USER (`telecallers.user_id`).
-- An unbound telecaller is a name on a handset with no console login, and
-- there is nobody to tell. That is a silent no-op by design, surfaced on the
-- rules page as "N of your targets have no login" rather than as an error at
-- assignment time.

-- ── Tenancy ─────────────────────────────────────────────────────────────────
-- verify-rls.js fails the deploy by table name on any org_id table missing
-- either of these.
ALTER TABLE lead_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_routing_rules FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON lead_routing_rules
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE lead_routing_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_routing_targets FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON lead_routing_targets
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE lead_routing_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_routing_assignments FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON lead_routing_assignments
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON lead_routing_rules       TO aura_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_routing_targets     TO aura_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_routing_assignments TO aura_app;

-- 0007 revoked Supabase's default privileges for future tables, but only for
-- the role that ran it. Re-assert here so a table created under a different
-- owner can never be reachable with the public anon key.
DO $$
DECLARE api_role text; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_routing_rules', 'lead_routing_targets',
                           'lead_routing_assignments'] LOOP
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', t, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
  END LOOP;
END $$;

-- 0001's trigger loop only saw the tables that existed then.
DO $$ BEGIN
  CREATE TRIGGER lead_routing_rules_set_updated_at BEFORE UPDATE ON lead_routing_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER lead_routing_targets_set_updated_at BEFORE UPDATE ON lead_routing_targets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
