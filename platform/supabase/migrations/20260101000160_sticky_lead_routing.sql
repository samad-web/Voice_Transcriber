-- 0160_sticky_lead_routing.sql - a returning caller goes back to the person who
-- already knows them (Build docs/39 §14, Part C).
--
-- ── A THIRD STRATEGY, NOT A FEATURE BESIDE ROUTING ──────────────────────────
--
-- 0105 already owns "who gets the next lead": rules, targets, daily caps and a
-- decision ledger. Sticky ownership is a third value of `strategy`, so it
-- inherits all of that - the match criteria, the priority order, the daily
-- caps, the HUMAN-OWNS-IT guard that only ever fills a NULL
-- `assigned_telecaller_id`, and the assignment ledger that keeps `strategy`
-- denormalised so editing a rule never rewrites history.
--
-- Built as a second mechanism it would have needed its own copy of every one
-- of those, and the first divergence would be a sticky assignment that ignored
-- somebody's daily cap.
--
-- ── THE DRIFT TRAP, NAMED BEFORE IT HAPPENS ─────────────────────────────────
--
-- `strategy` has a zod twin: `LeadRoutingStrategy` in
-- packages/shared/src/lead-routing.ts. Widening one and not the other throws
-- 23514 at runtime and reads like a caller bug - which is exactly what
-- `notifications.kind` did, in both directions at once, while every type-check
-- and lint stayed green. Both are widened in this change, and
-- `lead-routing.test.ts` now parses THIS FILE and asserts the two sets are
-- equal, the technique opt-out.test.ts uses for messaging_opt_outs.channel.
--
-- Every CHECK below is therefore declared as a NAMED `ADD CONSTRAINT`, even
-- the two that could have been written inline on the ADD COLUMN: a named
-- constraint is droppable by the next widening and findable by the test that
-- pins it. 0105 declared the strategy CHECK inline, which is why the first
-- statement drops it by its auto-generated name.

-- ── 1. The third strategy ───────────────────────────────────────────────────

ALTER TABLE lead_routing_rules DROP CONSTRAINT IF EXISTS lead_routing_rules_strategy_check;
ALTER TABLE lead_routing_rules ADD CONSTRAINT lead_routing_rules_strategy_check
  CHECK (strategy IN ('round_robin', 'percentage', 'sticky'));

-- ── 2. Its two columns ──────────────────────────────────────────────────────
--
-- Nullable, and NOT back-filled onto the existing rules: a round-robin rule
-- has no window and no fallback, and giving every row a default would invent
-- configuration nobody chose. The constraint in §3 is what stops a STICKY rule
-- from being half-configured.

ALTER TABLE lead_routing_rules
  ADD COLUMN IF NOT EXISTS sticky_window_days int,
  ADD COLUMN IF NOT EXISTS sticky_fallback    text;

ALTER TABLE lead_routing_rules DROP CONSTRAINT IF EXISTS lead_routing_rules_sticky_window_days_check;
ALTER TABLE lead_routing_rules ADD CONSTRAINT lead_routing_rules_sticky_window_days_check
  CHECK (sticky_window_days IS NULL OR sticky_window_days > 0);

-- What happens when nobody is sticky, or the sticky owner has left or is off
-- shift. NULL would mean "leave unassigned", which silently kills a lead - so
-- "leave unassigned" is a VALUE somebody picks on purpose, and NULL on a
-- sticky rule is forbidden outright below.
ALTER TABLE lead_routing_rules DROP CONSTRAINT IF EXISTS lead_routing_rules_sticky_fallback_check;
ALTER TABLE lead_routing_rules ADD CONSTRAINT lead_routing_rules_sticky_fallback_check
  CHECK (sticky_fallback IN ('round_robin', 'percentage', 'unassigned'));

-- ── 3. A sticky rule cannot be half-configured ──────────────────────────────
--
-- The failure this prevents is not a crash, it is a rule that looks configured
-- on the page it was configured from and routes nothing - the same class of
-- bug 0105's own `match` comment is about. A sticky rule with no window cannot
-- say which prior leads count, and one with no fallback cannot say what to do
-- with the overwhelming majority of leads, which are from numbers nobody has
-- ever spoken to.
--
-- It validates against the existing rows without a rewrite and cannot fail:
-- no row can be 'sticky' yet, because the constraint in §1 only started
-- permitting that value four statements ago.
--
-- It also pins the API honest. `POST /owner/lead-routing/rules` fills both
-- from LeadRoutingRuleInput's defaults and `PATCH` carries them forward, so a
-- caller can neither create nor edit its way into this state - and if one ever
-- finds a path, it is a 23514 on the write rather than a rule that quietly
-- stops distributing.
ALTER TABLE lead_routing_rules DROP CONSTRAINT IF EXISTS lead_routing_rules_sticky_configured;
ALTER TABLE lead_routing_rules ADD CONSTRAINT lead_routing_rules_sticky_configured
  CHECK (
    strategy <> 'sticky'
    OR (sticky_window_days IS NOT NULL AND sticky_fallback IS NOT NULL)
  );

COMMENT ON COLUMN lead_routing_rules.sticky_window_days IS
  'How far back a prior lead from the same number still binds its owner. '
  'NULL on every non-sticky rule; required on a sticky one.';

COMMENT ON COLUMN lead_routing_rules.sticky_fallback IS
  'What a sticky rule does when nobody is sticky, when the sticky owner is '
  'off shift, capped or gone, or when two different people owned earlier '
  'leads from this number. ''unassigned'' is a deliberate choice, not the '
  'absence of one - NULL is forbidden on a sticky rule.';

-- ── 4. What the resolution reads, and what it deliberately does not ─────────
--
-- The match key is `leads.contact_number_key` (0146): sha256 of the last ten
-- digits, so a lead stored as +919876543210 and one logged as 09876543210 are
-- the same customer. 0146's header is the reason this phase exists in the
-- shape it does:
--
--     "Not UNIQUE, and that is the point rather than an omission. Two leads in
--      one workspace CAN legitimately share a key [...] That collision is
--      exactly the ambiguity lead_for_unlinked_call refuses to guess at."
--
-- Sticky routing makes the same refusal. TWO OR MORE DISTINCT PRIOR OWNERS IS
-- NOT A TIE TO BREAK BY RECENCY. Handing the lead to whoever spoke to them
-- most recently is right about half the time, and the half it is wrong about
-- is invisible: the prospect reaches the wrong person, and the right person
-- never learns the call happened. The fallback runs instead and the decision
-- row says why, which is a thing a manager can read and act on.
--
-- NO NEW INDEX. The lookup is `(workspace_id, contact_number_key)` filtered by
-- age and by having an owner, and 0146 already built
-- `leads_workspace_contact_key` for exactly that pair. The rows behind one key
-- number in the single digits, so the age and owner filters come off the heap
-- for free; a second, wider index would be paid for on every lead INSERT to
-- save nothing measurable on the read.
--
-- NO SCHEMA FOR THE DECISION. `lead_routing_assignments` already stores
-- `strategy` denormalised and a prose `reason`, which is where "two earlier
-- leads from this number belong to different people" lands. A sticky-specific
-- column would be a second place for the same fact to be wrong.

-- ── 5. Attendance is a real coupling ────────────────────────────────────────
--
-- A sticky owner who is absent must not accumulate leads all day while the
-- rest of the floor sits idle - that is the one way this feature is worse than
-- round robin rather than better. So the resolution reads 0140's
-- `attendance_live_state.state`, which is the platform's ONE notion of who is
-- at work, rather than inventing a second.
--
-- Two carve-outs, both load-bearing, both decided in @aura/shared's
-- `stickyOwnerAvailability` and tested there:
--
--   * `organizations.attendance_enabled` defaults FALSE and most tenants have
--     never turned it on. Gating on presence they do not collect would make
--     sticky routing send every lead to the fallback, forever, with a reason
--     nobody would connect to a switch on another page. When attendance is
--     off, the shift gate does not apply.
--
--   * A telecaller with no `attendance_live_state` row has never reported
--     presence - a console-only person with no handset, which is normal. That
--     is not evidence of absence, so it does not block the assignment; the
--     decision's reason says the shift was unknown.
--
-- Known absence - OFF_SHIFT or AWAY - is what sends the lead to the fallback.
-- The other six states (ACTIVE, IN_CALL, PROMPTING, BREAK_DUE, ON_BREAK,
-- TECHNICAL) are all "at work": a fifteen-minute break is not a reason to take
-- a customer off the person who knows them.
