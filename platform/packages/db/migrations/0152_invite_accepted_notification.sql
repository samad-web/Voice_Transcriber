-- 0152_invite_accepted_notification.sql - somebody you invited is now in.
--
-- 0137 gave owners invite links and gave the invitee a journey that ends with
-- them signing in with Google. What it never did was CLOSE THE LOOP: acceptance
-- wrote `org_invites.accepted_at`, an `owner.invite.accept` audit row and a
-- `memberships` row, and then told nobody. The person who sent the invite had no
-- way to learn it had been taken up except to reload the Team page and notice a
-- row had moved out of "Pending invites" - so "did Asha ever get in?" was
-- answered by asking Asha.
--
-- Note what already existed and still was not enough. Every sign-in has been
-- recorded in `auth_events` since 0127, but that history is deliberately bound
-- to ONE PERSON: every read is pinned to the caller's own `auth_user_id`, which
-- is what makes it safe to span workspaces and operators. It answers "was that
-- me on Tuesday?" and it must not be made to answer "has my new hire logged in
-- yet?" - so this is a notification, not a widening of that read.
--
-- ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
--
-- Not a sign-in alert. ONE row per invite, at the moment it is accepted, and
-- nothing on the logins that follow. A bell that rang on every sign-in would be
-- the surveillance reading of the same feature, and - per the notifications
-- module's own header - the noise that teaches people to stop reading the bell,
-- taking the kinds that mattered with it.
--
-- Nothing leaves the product: an unread badge is not a message, and this one
-- cannot arrive in anybody's inbox. The invite mail (PLATFORM_SMTP_*) is still
-- the only thing in the invite flow that sends, and still only when the owner
-- ticks the box for that one invite.

-- ── Notification kinds ──────────────────────────────────────────────────────
--
-- Rewritten WHOLESALE, as every migration that adds a kind does, in lockstep
-- with NotificationKind in @aura/shared and NOTIFICATION_KINDS in the console
-- (notification-kinds.test.ts reads the LAST check in apply order).
--   invite_accepted - to whoever sent the invite, and to the owners.

DO $do$
DECLARE con text;
BEGIN
  SELECT c.conname INTO con
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
   WHERE t.relname = 'notifications' AND c.contype = 'c' AND a.attname = 'kind'
     AND c.conkey = ARRAY[a.attnum];
  IF con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', con);
  END IF;
END $do$;

ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('task_assigned', 'task_due', 'deal_stage_changed', 'deal_idle',
                  'automation', 'report_ready', 'lead_assigned',
                  'opt_out_requested', 'channel_needs_attention',
                  'sla_breach', 'review_pending',
                  'call_access_requested',
                  'storage_quota',
                  'missed_call',
                  'task_response',
                  -- 0140: attendance (doc 33).
                  'attendance_request',
                  'attendance_break_overrun',
                  'attendance_away',
                  'attendance_review',
                  -- 0143: never started the shift.
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
                  'invite_accepted'));
