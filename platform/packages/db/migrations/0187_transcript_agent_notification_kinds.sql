------------------------------------------------------------------------------
-- 0187_transcript_agent_notification_kinds.sql - the three bells and the two
-- popups the transcript agent needs (§10A.4, §10A.5, §16).
--
-- ── WHY THIS IS ITS OWN FILE ───────────────────────────────────────────────
--
-- It restates `notifications_kind_check` IN FULL, and that has to be the LAST
-- literal restatement in apply order or a drift guard goes quietly wrong.
--
-- `packages/shared/src/notification-kinds.test.ts` finds the last literal
-- `ADD CONSTRAINT notifications_kind_check CHECK (kind IN (...))` across every
-- migration, sorted by filename, and asserts that `NotificationKind`'s options
-- equal it exactly. 0179's header records the reasoning at length and the
-- mistake it was correcting: 0176 appended DYNAMICALLY, 0177 then did a
-- DROP + ADD with an explicit list that could not contain 0176's values, and
-- the two finance kinds were added and then silently removed. The first
-- anybody would have known was a 23514 on a live tenant.
--
-- So: a full literal restatement, in the highest-numbered file of this wave.
-- Every value below was read back from 0179's list, not retyped from memory,
-- plus the three new ones.
--
-- ── AND WHY ONLY THREE KINDS FOR A MODULE THIS SIZE ────────────────────────
--
-- `notifications`'s own header is the reason: "an unread badge is not a
-- message... noise is how a notification system dies: people stop reading the
-- bell, and then the one that mattered gets missed too."
--
-- So the agent reuses what exists wherever the existing kind means the same
-- thing:
--
--   · `review_pending` ALREADY means "something a machine proposed is waiting
--     for a person to approve" (0109). That is exactly the review inbox, so
--     the agent's suggestions ring that bell rather than a new one.
--   · `task_assigned` / `task_due` cover a follow-up the agent created, because
--     it IS a task and the person receiving it does not care who wrote it.
--   · `sla_breach` covers a review item sitting too long, through the same
--     Advisor routing §16 asks for.
--
-- The three that are genuinely new are the ones with no existing equivalent:
-- a callback coming due, a committed callback being missed, and the agent
-- itself needing attention.
------------------------------------------------------------------------------

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'task_due', 'deal_stage_changed', 'deal_idle',
                  'automation', 'report_ready', 'lead_assigned',
                  'opt_out_requested', 'channel_needs_attention',
                  'sla_breach', 'review_pending',
                  'call_access_requested',
                  'storage_quota',
                  'missed_call',
                  'task_response',
                  -- 0140/0143: attendance (doc 33).
                  'attendance_request',
                  'attendance_break_overrun',
                  'attendance_away',
                  'attendance_review',
                  'attendance_absent',
                  -- 0147: we answered a problem you reported (doc 36).
                  'call_issue_update',
                  -- 0148: the data export engine (doc 35).
                  'export_ready',
                  'export_failed',
                  'export_created',
                  -- 0151: call escalations (doc 38).
                  'call_escalated',
                  'call_escalation_update',
                  -- 0152: an invitation was taken up.
                  'invite_accepted',
                  -- 0177/0178: the organization chart's four.
                  'position_vacant',
                  'reporting_change',
                  'contract_expiring',
                  'probation_ending',
                  -- 0172-0176/0179: the finance module's two.
                  'finance_alert',
                  'finance_payout',

                  -- ══ 0184-0187: the transcript agent ══

                  -- A CALLBACK YOU OWE SOMEBODY IS DUE NOW (§10A.4).
                  --
                  -- The in-app half of the due reminder, for a telecaller who
                  -- has a console login. The handset half is a
                  -- `handset_alerts` popup, because most telecallers never
                  -- sign in - 0150's header is the argument, and a bell item
                  -- addressed to somebody with no login is addressed to
                  -- nobody.
                  --
                  -- Dedupe key carries the callback id AND the reminder kind,
                  -- so the pre-reminder, the due popup and the nudge are three
                  -- rows rather than one collapsed one.
                  'callback_due',

                  -- A COMMITTED CALLBACK WAS MISSED (§10A.5).
                  --
                  -- One kind for the whole ladder, not one per level - the
                  -- same argument `call_issue_update` makes. The bell's job is
                  -- to get somebody to open the item; a second kind for the
                  -- same commitment is the noise that teaches people to stop
                  -- reading it. The dedupe key carries the level, so a manager
                  -- at +15 and an owner at +60 are two rows and a sweep running
                  -- twice is one.
                  --
                  -- Reaches the telecaller, their manager through the org
                  -- chart's reporting line, and the owners - whoever the
                  -- owner's own ladder names (§10A.6 step 5).
                  'callback_missed',

                  -- THE ASSISTANT ITSELF NEEDS ATTENTION (§16).
                  --
                  -- "Failed actions, missed callbacks, review backlog,
                  -- connector or calendar token problems, accuracy below gate,
                  -- and unusually high correction rates become alerts with the
                  -- same routing and escalation."
                  --
                  -- ONE kind for all of it, deliberately, and the alternative
                  -- was seven. Every one of them is the same message to the
                  -- same person - "the assistant is not working properly, open
                  -- its page" - and splitting them would put seven switches in
                  -- the notification preferences for one concern. The body
                  -- says which, and the dedupe key carries the cause so a
                  -- daily sweep does not ring daily about the same thing.
                  --
                  -- Goes to owners. A telecaller cannot act on "accuracy below
                  -- gate" and should not be told their work is being measured
                  -- by a bell.
                  'agent_alert'));

-- ── Prove the end state, rather than trusting the statement above ──────────
--
-- The whole point of this file is that a value can be present and then absent.
-- 0179 does the same, and for the same reason: a constraint that refuses a
-- notification makes the routing silently dead, and unlike a data condition it
-- cannot be repaired from the console afterwards - the writes simply fail.
DO $do$
DECLARE missing text;
BEGIN
  SELECT string_agg(v.k, ', ') INTO missing
    FROM (VALUES
            -- This wave's three.
            ('callback_due'), ('callback_missed'), ('agent_alert'),
            -- And a sample of everybody else's, because this file RESTATES the
            -- list: a value dropped by a mistake in the restatement is a
            -- regression in somebody else's feature, and this is the only
            -- place that could catch it.
            ('finance_alert'), ('finance_payout'),
            ('position_vacant'), ('reporting_change'),
            ('contract_expiring'), ('probation_ending'),
            ('invite_accepted'), ('call_escalated'), ('export_ready'),
            ('attendance_absent'), ('review_pending'), ('task_assigned')
         ) AS v(k)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'notifications'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%' || v.k || '%'
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0187: notifications.kind no longer admits: % - this restatement dropped a kind somebody depends on', missing;
  END IF;
END $do$;

------------------------------------------------------------------------------
-- The handset's two popups (§10A.4)
--
-- Same DROP-then-ADD shape 0151 uses, and the same reason the whole list is
-- restated: `handset_alerts.kind` and `HandsetAlertKind` in @aura/shared drift
-- silently, and the failure is a 23514 at the moment a telecaller's phone
-- should have gone off.
--
-- ── WHY A POPUP AND NOT A NOTIFICATION ────────────────────────────────────
--
-- §10A.4 asks for a "popup at due time" that "persists until acted on". A
-- `notifications` row cannot do that: it reaches a person signed in to the
-- console, and most telecallers carry a paired phone and nothing else. 0150's
-- `popup` style is a full-screen view over the lock screen, which is what a
-- commitment at a named time needs.
--
-- `callback_due` is a POPUP and `callback_escalated` is a POPUP, and both are
-- deliberate departures from 0150's rule that "only what cannot wait takes over
-- the screen":
--
--   · a callback at 17:00 IS the thing that cannot wait. It is the one alert in
--     this product where five minutes late is a broken promise.
--   · an escalation means somebody senior is now waiting on this person about
--     a customer who was already let down once.
--
-- The existing `followup_due` stays `notify`, which is the right contrast: a
-- follow-up has a day, a callback has a minute.
------------------------------------------------------------------------------

DO $do$
DECLARE con text;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
     WHERE t.relname = 'handset_alerts' AND c.contype = 'c' AND a.attname = 'kind'
       AND c.conkey = ARRAY[a.attnum]
  LOOP
    EXECUTE format('ALTER TABLE handset_alerts DROP CONSTRAINT %I', con);
  END LOOP;
END $do$;

ALTER TABLE handset_alerts ADD CONSTRAINT handset_alerts_kind_check
  CHECK (kind IN ('lead_assigned', 'task_assigned', 'followup_due',
                  'missed_callback', 'manager_message',
                  -- 0151: call escalations (doc 38).
                  'escalation_received', 'escalation_update',
                  -- 0186/0187: the managed callback list (§10A).
                  --
                  -- NOT the same as `missed_callback` above, which is 0134's
                  -- "their lead rang a DIFFERENT phone and nobody answered".
                  -- This one is "you promised to ring somebody at this time".
                  'callback_due', 'callback_escalated'));

DO $do$
DECLARE missing text;
BEGIN
  SELECT string_agg(v.k, ', ') INTO missing
    FROM (VALUES ('callback_due'), ('callback_escalated'),
                 ('escalation_received'), ('missed_callback'), ('manager_message')
         ) AS v(k)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'handset_alerts'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%' || v.k || '%'
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0187: handset_alerts.kind no longer admits: %', missing;
  END IF;
  RAISE NOTICE '0187: three notification kinds and two handset popups added.';
END $do$;
