-- 0179_finance_notification_kinds.sql
-- Restate `notifications.kind` so the finance module's two kinds survive.
--
-- ── WHY THIS FILE EXISTS, AND IT IS NOT A TIDY-UP ──────────────────────────
--
-- 0176 widened `notifications_kind_check` for `finance_alert` and
-- `finance_payout` by reading the constraint's live definition and appending to
-- its value list. That was correct when it was written and is no longer
-- sufficient: 0177 (the organization chart, built in parallel in this same
-- tree) does a **DROP CONSTRAINT + ADD CONSTRAINT with an explicit list**, and
-- that list cannot contain the finance values because it was written against
-- the constraint as it stood before 0176.
--
-- Apply order is 0176 → 0177, so without this file the finance kinds are added
-- and then silently removed. The first anybody would know of it is the
-- Advisor's very first notification failing with 23514 on a live tenant -
-- exactly the drift this codebase was already bitten by in production (0100's
-- header records it) and the reason `notification-kinds.test.ts` exists.
--
-- ── AN EXPLICIT LIST, AND THAT IS A REVERSAL WORTH EXPLAINING ──────────────
--
-- The first version of this file appended dynamically, the way 0176 does, on
-- the reasoning that a third copy of thirty-odd values is a third place to
-- drop somebody's work. That reasoning was wrong, for a specific reason:
--
-- `notification-kinds.test.ts` finds the LAST literal
-- `ADD CONSTRAINT notifications_kind_check CHECK (kind IN (...))` in apply
-- order and asserts `NotificationKind`'s options equal it exactly. A dynamic
-- rewrite does not match that pattern - so a migration that changes the live
-- constraint without being visible to the test makes the test's premise false
-- while leaving it green. It would have gone on comparing the enum against
-- 0177's list forever, which is the one kind of drift guard worse than none.
--
-- So this is a full restatement: every value 0177 leaves in place, plus the
-- two finance kinds, written out. It is the last literal list in apply order,
-- which means the existing test now pins the enum against THIS - and the next
-- person to add a kind has one list to edit and a test that fails until they
-- do.
--
-- The values below were read back from the live constraint after 0177 and 0178
-- applied, not copied from either file, so nothing is here by assumption.

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
                  -- ── 0172-0176: the finance module ──
                  --
                  -- `finance_alert` is the Advisor telling a member of STAFF
                  -- that money needs chasing (§12.5). `finance_payout` is an
                  -- incentive statement reaching the person it belongs to
                  -- (§10). Neither ever reaches a customer: the module has no
                  -- send path at all, which is what keeps this platform's
                  -- standing rule - nothing automated sends - true for the one
                  -- module where breaking it would cost a relationship.
                  'finance_alert',
                  'finance_payout'));

-- ── Prove it, rather than assume it ───────────────────────────────────────
--
-- The whole point of this file is that a value can be present and then absent,
-- so it asserts the end state rather than trusting the statement above.
--
-- An EXCEPTION and not a warning: a constraint that refuses the Advisor's own
-- notification makes §12.5's routing silently dead, and unlike a data
-- condition that cannot be repaired from the console afterwards - the writes
-- simply fail. Worth failing a deploy over.
DO $do$
DECLARE missing text;
BEGIN
  SELECT string_agg(v.k, ', ') INTO missing
    FROM (VALUES ('finance_alert'), ('finance_payout'),
                 -- The other sessions' kinds too: this file RESTATES the list,
                 -- so a value dropped by a mistake in the restatement is a
                 -- regression in somebody else's feature, and this is the only
                 -- place that could catch it.
                 ('position_vacant'), ('reporting_change'),
                 ('contract_expiring'), ('probation_ending'),
                 ('invite_accepted'), ('call_escalated'), ('export_ready'),
                 ('attendance_absent'), ('task_assigned')) AS v(k)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'notifications'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%' || v.k || '%'
   );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0179: notifications.kind no longer admits: % - this restatement dropped a kind somebody depends on', missing;
  END IF;
  RAISE NOTICE '0179: notifications.kind restated with both finance kinds';
END $do$;
