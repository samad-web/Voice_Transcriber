-- 0204_integration_watchdog.sql
--
-- A CRM connector that has stopped working says so, instead of waiting for a
-- customer to notice their leads are not arriving. Doc 49 P10-C.
--
-- ── WHY THE EXISTING WATCHDOG IS NOT ENOUGH ─────────────────────────────────
--
-- `channel-watchdog.ts` (0099/0110) already does exactly this shape for
-- MESSAGING providers: it probes rather than waits, and it notifies the
-- workspace's admins. CRM connections got none of it, and four of the nineteen
-- connectors in the catalogue take an OAuth ACCESS token that expires - in an
-- hour for Zoho and Dynamics. When it lapses, every delivery 401s.
--
-- The outbox means nothing is LOST - deliveries queue and retry, and
-- `crm_sync_log` records each failure - but nothing tells anybody, so the first
-- signal is a customer asking why their CRM is three weeks behind. By then the
-- token has been dead for three weeks and the retry budget has long since
-- marked those rows `dead`.
--
-- ── WHAT THIS MIGRATION ACTUALLY ADDS ───────────────────────────────────────
--
-- One notification kind, and two columns on `crm_integrations` so the watchdog
-- can tell "failing right now" from "failed once at 4am and recovered".
--
-- The KIND is the part that needs a migration at all, and the reason is
-- recorded in 0100's header: `notifications.kind` has a DB CHECK and a zod
-- enum, they have drifted in both directions before, and a kind only the enum
-- knows throws 23514 on the write path in production. `notification-kinds.test`
-- reads the LAST `notifications_kind_check` in apply order and compares it
-- against the enum - so the whole list is restated here rather than widened by
-- string surgery, exactly as 0198 restated it.

BEGIN;

-- 1 ── THE KIND ─────────────────────────────────────────────────────────────

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
                  'work_handover',
                  -- 0204: a CRM connector has stopped accepting our
                  -- deliveries - almost always an expired OAuth access token
                  -- on one of the four connectors that take one.
                  'integration_needs_attention'));

-- 2 ── ENOUGH STATE TO TELL A BLIP FROM AN OUTAGE ───────────────────────────
--
-- `crm_integrations` already carries `last_error` and `last_success_at`, which
-- answer "did the most recent attempt fail". They cannot answer "has this been
-- failing continuously since Tuesday", and that is the question that decides
-- whether a human should be interrupted.
--
-- Two columns, and both are about restraint rather than detection: without
-- them the sweep either notifies on every failed delivery (which on a busy
-- floor is a notification per call) or keeps the memory in the worker process,
-- where a redeploy forgets it and the fleet gets notified again.

ALTER TABLE crm_integrations
  /** When this connector last looked broken. NULL = healthy as far as we know. */
  ADD COLUMN IF NOT EXISTS failing_since timestamptz,
  /** When a human was last told. Separate from failing_since so the reminder
   *  interval is a property of the NOTICE, not of the fault. */
  ADD COLUMN IF NOT EXISTS last_alerted_at timestamptz;

COMMENT ON COLUMN crm_integrations.failing_since IS
  'First failure of the current unbroken run of failures, or NULL when the last '
  'delivery succeeded. Set and cleared by the integration watchdog, not by the '
  'outbox - a single 429 is not a fault worth a column.';

COMMENT ON COLUMN crm_integrations.last_alerted_at IS
  'When the workspace admins were last notified about this connector. Kept '
  'separate from failing_since so a fault that persists for a week produces a '
  'weekly reminder rather than one notice nobody saw or a notice every sweep.';

-- The sweep's own query: connections with a recent failure, worst first. Partial
-- because the healthy case is the overwhelming majority and the index should not
-- carry it.
CREATE INDEX IF NOT EXISTS crm_integrations_failing_idx
  ON crm_integrations (failing_since)
  WHERE failing_since IS NOT NULL;

COMMIT;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--
--   \d+ crm_integrations
--   -- the enum and the CHECK must agree, which is what the drift test asserts:
--   --   pnpm --filter @aura/shared test notification-kinds
--
--   -- and the new kind writes:
--   INSERT INTO notifications (org_id, user_id, kind, title)
--   VALUES (…, …, 'integration_needs_attention', 'x');
