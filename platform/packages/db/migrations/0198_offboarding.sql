-- 0198_offboarding.sql - what the product does when a person leaves.
--
-- ══════════════════════════════════════════════════════════════════════════
--  WHY A MIGRATION AT ALL, WHEN THE FIX IS MOSTLY CODE
-- ══════════════════════════════════════════════════════════════════════════
--
-- Offboarding was never missing a column. Suspension (0102) stops a login,
-- `telecallers.status` (0017) already has 'archived', `devices.removed_at`
-- (0087) already takes a handset out of the fleet, and every assignment
-- column already exists. What was missing was anything that CALLED them in
-- sequence: suspending somebody stopped their console and left their handset
-- recording, their telecaller identity collecting round-robin leads, and
-- their book of work assigned to an account that cannot sign in.
--
-- That sequence is a service (owner/offboard.service.ts). Two things in it
-- cannot live in a service, and they are the whole of this file:
--
--  1. An index, so "which handsets does this person hold" is not a seq scan
--     of the fleet every time the Staff page opens a dialog.
--
--  2. A trigger, because notification producers are spread across seventeen
--     files in two processes and the rule "do not write to somebody who cannot
--     sign in" has to hold for the eighteenth that nobody has written yet.
--
-- Numbered 0198: 0197 is the latest on this tree.

------------------------------------------------------------------------------
-- 1 ── Which handsets does this person hold?
------------------------------------------------------------------------------
--
-- `devices.telecaller_id` (0017) is the only link between a person and a
-- phone, and nothing has ever queried the fleet BY it - every read goes the
-- other way, from a device to the name on it. The offboard manifest asks the
-- reverse question, once per dialog, and the fleet of a large tenant is tens
-- of thousands of rows.
--
-- Partial on `removed_at IS NULL` for the same reason `devices_live` is: a
-- handset already out of the fleet is not one anybody is about to log out.

CREATE INDEX IF NOT EXISTS devices_org_telecaller
  ON devices (org_id, telecaller_id)
  WHERE telecaller_id IS NOT NULL AND removed_at IS NULL;

------------------------------------------------------------------------------
-- 2 ── A notification is never written to a suspended member
------------------------------------------------------------------------------
--
-- ── WHY A TRIGGER, WHICH THIS SCHEMA OTHERWISE RESERVES FOR INVARIANTS ────
--
-- `notify()` (notifications/notify.ts) exists precisely so every producer
-- agrees on what a notification row means, and it has two callers. Seventeen
-- other files write `INSERT INTO notifications` directly, each with its own
-- CTE picking a recipient out of a join - the task sweep from
-- `tasks.assignee_user_id`, the missed-call notice from a lead's telecaller,
-- the callback escalation from `callbacks.assigned_user_id`. Patching
-- seventeen bespoke queries to add one EXISTS clause leaves the eighteenth
-- wrong, and nothing about that failure is visible in a diff: the bell just
-- fills up for somebody who left in March.
--
-- So the rule goes where the rows land.
--
-- ── WHY IT SKIPS ONLY A *SUSPENDED* MEMBER, AND NOT EVERY NON-MEMBER ──────
--
-- `NOT EXISTS (an active membership)` would have been the obvious predicate
-- and it is the wrong one. A notification row whose recipient has no
-- membership in this org at all is not necessarily a mistake - the operator
-- console and the platform-level alerts write for people this tenant has
-- never heard of - and a trigger that silently dropped those would be a
-- disclosure-shaped bug in reverse: real alerts, gone, with nothing logged.
--
-- A SUSPENDED membership is unambiguous. That person is, by the definition
-- 0102 gave the column, somebody this workspace has stopped from signing in.
-- There is no reading of that state in which writing them a notification is
-- useful, and the offboard service marks their unread rows read for the same
-- reason.
--
-- ── WHY RETURN NULL IS SAFE HERE ──────────────────────────────────────────
--
-- A BEFORE INSERT trigger returning NULL drops the row and reports zero rows
-- affected. Every producer already copes with that: `notify()` returns
-- `rowCount > 0` and documents false as "an identical notification already
-- existed", and the raw sites either ignore the count or RETURNING-loop over
-- what landed. Nothing treats "no row" as an error, because `ON CONFLICT DO
-- NOTHING` has always been able to produce it.
--
-- ── AND WHY THE MEMBERSHIP READ IS SOUND UNDER RLS ────────────────────────
--
-- `notifications` is FORCE RLS on `app.org_id` (0048), so an INSERT that gets
-- this far has already proved `NEW.org_id` equals the session's org - which
-- means the `memberships` read below is inside the same policy and sees the
-- row. If a future caller somehow inserted with the GUC unset, the INSERT
-- itself fails on the WITH CHECK before this function ever runs.

CREATE OR REPLACE FUNCTION notifications_skip_suspended()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.user_id = NEW.user_id
       AND m.org_id  = NEW.org_id
       AND m.status  = 'suspended'
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION notifications_skip_suspended() IS
  'Drops a notification addressed to a suspended member (0102). Returns NULL, which '
  'reports zero rows affected - the same outcome every producer already handles for '
  'an ON CONFLICT DO NOTHING collapse. A recipient with NO membership here is left '
  'alone deliberately: operator and platform alerts are written that way.';

DROP TRIGGER IF EXISTS notifications_skip_suspended ON notifications;
CREATE TRIGGER notifications_skip_suspended
  BEFORE INSERT ON notifications
  FOR EACH ROW
  EXECUTE FUNCTION notifications_skip_suspended();

------------------------------------------------------------------------------
-- 3 ── Documenting the two columns the offboard service finally writes
------------------------------------------------------------------------------
--
-- Both have existed for well over a hundred migrations with every reader
-- honouring them and no writer anywhere. Saying so on the column is how the
-- next person to go looking finds the service instead of adding a second
-- mechanism beside it.

COMMENT ON COLUMN telecallers.status IS
  'active | archived. Archived removes this identity from lead routing (every target '
  'read joins on status), from capacity balancing, and from the pickers - without '
  'detaching one call or lead from it. Written by the offboard service and by '
  'suspend/reinstate (owner-team.controller.ts); nothing else should write it.';

COMMENT ON COLUMN memberships.status IS
  'active | suspended. Suspension stops the login at two independent gates '
  '(AuthService.contextFor and ownerRoleFor) and is fully reversible. It does NOT by '
  'itself stop that person''s handset or free their assigned work - the offboard '
  'service does both, and 0198''s header says why that could not be a column.';

------------------------------------------------------------------------------
-- 4 ── One new notification kind: the handover itself
------------------------------------------------------------------------------
--
-- When a departing colleague's work moves, the person receiving it is told
-- once, with the totals: "112 leads, 9 call-backs and 3 tasks moved to you
-- from Priya." Not once per record - a hundred and twelve bell rows for one
-- owner's click is how somebody learns to clear the bell without reading it.
--
-- ── WHY NOT REUSE `lead_assigned` ─────────────────────────────────────────
--
-- Because it would be a lie in the only field the bell's filters read. The
-- preferences page lets a person put `lead_assigned` on digest - a perfectly
-- reasonable thing for a rep drowning in new leads to do - and a handover
-- hidden until 9am tomorrow is exactly the message that needed to arrive now.
-- The two facts also differ in kind: one lead arriving is routine, inheriting
-- somebody's whole desk is not.
--
-- `needsAction: false` in the web registry. There is nothing to accept: the
-- records are already theirs, which is the difference between this and the
-- task seats in the same handover (those stay `pending`, because 0135 made
-- being given work a thing a person may decline).
--
-- ── THE RESTATEMENT TAX ───────────────────────────────────────────────────
--
-- This file restates the whole list, as every migration touching this
-- constraint has had to since 0119. The DO block below is 0197's guard, kept
-- for the same reason: a value dropped by a typo in the restatement is a
-- silent regression in somebody else's feature, and 23514 at runtime is the
-- only other place it would show up. `notification-kinds.test.ts` holds the
-- other half - the zod enum in @aura/shared must match this list exactly.

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
                  -- 0184-0187: the transcript agent's three.
                  'callback_due',
                  'callback_missed',
                  'agent_alert',
                  -- 0197: the transcription allowance.
                  'transcription_quota',
                  -- 0198: somebody left and their desk is now yours.
                  'work_handover'));

DO $do$
DECLARE missing text;
BEGIN
  SELECT string_agg(v.k, ', ') INTO missing
    FROM (VALUES
            -- This wave's one.
            ('work_handover'),
            -- And a sample of everybody else's, because this file RESTATES the
            -- list: a value dropped by a mistake in the restatement is a
            -- regression in somebody else's feature, and this is the only
            -- place that could catch it.
            ('transcription_quota'),
            ('callback_due'), ('callback_missed'), ('agent_alert'),
            ('finance_alert'), ('finance_payout'),
            ('position_vacant'), ('reporting_change'),
            ('invite_accepted'), ('call_escalated'),
            ('export_ready'), ('task_assigned'), ('lead_assigned')
         ) AS v(k)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint c
      WHERE c.conname = 'notifications_kind_check'
        AND pg_get_constraintdef(c.oid) LIKE '%''' || v.k || '''%');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0198 dropped notification kinds in the restatement: %', missing;
  END IF;
END $do$;
