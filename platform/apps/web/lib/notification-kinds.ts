import type { NotificationKind } from "@aura/shared";

/**
 * How each notification kind is named and grouped in the console (CRM
 * dashboard Phase 7).
 *
 * A `Record<NotificationKind, ...>`, so a kind added to @aura/shared without a
 * label here is a type error rather than a bell row with a raw enum value in
 * it - the same drift notification-kinds.test.ts guards on the database side.
 *
 * Icons are lucide NAMES, not components, so this file stays importable from
 * tests and server code without pulling React in.
 */

export interface NotificationKindSpec {
  label: string;
  /** What choosing Instant or Digest for this kind actually affects. */
  description: string;
  icon: "user-plus" | "user-check" | "clock" | "arrow-right-left" | "hourglass" | "zap" | "file-text" | "inbox" | "ban" | "plug" | "alarm" | "clipboard-check" | "shield-alert" | "hard-drive" | "phone-missed" | "download" | "upload";
  /**
   * Somebody has to DO something, not merely know something. These are what
   * the bell's "Needs action" tab shows.
   */
  needsAction: boolean;
}

export const NOTIFICATION_KINDS: Record<NotificationKind, NotificationKindSpec> = {
  // First in the order deliberately: of everything the bell can say, this is
  // the only one whose subject is somebody outside the business reaching for
  // the business's own recordings.
  call_access_requested: {
    label: "Call access requested",
    description: "Someone outside your team asked to view your call logs and recordings.",
    icon: "shield-alert",
    needsAction: true,
  },
  // Beside it, for the same reason: the other kind whose subject is us rather
  // than the business's own work. "Needs action" because the last thing we say
  // on a ticket is usually a question or an answer waiting to be accepted, and
  // a reported problem nobody comes back to is the one that gets repeated on
  // the phone instead.
  call_issue_update: {
    label: "Reported problem updated",
    description: "We replied to a problem you reported about one of your calls.",
    icon: "clipboard-check",
    needsAction: true,
  },
  // Third in the governance cluster (0148, doc 35): the subject is somebody on
  // the team taking the workspace's data out of it. `needsAction: false` for
  // the reason attendance_absent is - whether an export is a problem is the
  // owner's judgement and there is nothing to decide in the console. It is
  // loud in the bell, not a queue item.
  export_created: {
    label: "Export started",
    description: "Somebody in your workspace started exporting data. Owners are always told.",
    icon: "upload",
    needsAction: false,
  },
  // Fourth in the governance cluster (0152): somebody gaining a login is the
  // same class of fact as somebody taking data out. Not "needs action" - the
  // access was granted when the invite was sent, and this is the confirmation
  // that it was used, not a decision waiting in the console.
  invite_accepted: {
    label: "Invite accepted",
    description: "Somebody you invited signed in for the first time. Owners are always told.",
    icon: "user-check",
    needsAction: false,
  },
  lead_assigned: {
    label: "Lead assigned",
    description: "A lead was routed to you.",
    icon: "inbox",
    needsAction: true,
  },
  // Call escalations (0151, Build docs/38). Raised or passed on to you waits
  // on you - a telecaller may still have the customer on the line, or be about
  // to ring them back. The answer coming back is something to read, not to do.
  call_escalated: {
    label: "Call escalated to you",
    description: "A telecaller asked you to help with one of their calls, or it was passed on to you.",
    icon: "inbox",
    needsAction: true,
  },
  call_escalation_update: {
    label: "Escalation answered",
    description: "Somebody answered a call you escalated.",
    icon: "clipboard-check",
    needsAction: false,
  },
  missed_call: {
    label: "Missed call",
    description: "A call from one of your leads went unanswered, or a missed caller was turned into one.",
    icon: "phone-missed",
    needsAction: true,
  },
  sla_breach: {
    label: "Response time missed",
    description: "A lead has waited longer than your response time for a first reply.",
    icon: "alarm",
    needsAction: true,
  },
  review_pending: {
    label: "Waiting for review",
    description: "Something the system proposed is waiting for a person to approve it.",
    icon: "clipboard-check",
    needsAction: true,
  },
  opt_out_requested: {
    label: "Opt-out request",
    description: "A customer may have asked to stop being messaged.",
    icon: "ban",
    needsAction: true,
  },
  channel_needs_attention: {
    label: "Channel problem",
    description: "A WhatsApp channel has stopped carrying messages.",
    icon: "plug",
    needsAction: true,
  },
  // Attendance (doc 33, migration 0140). A request and a stretch to review
  // both wait on a decision; an overrun break and an unanswered presence
  // check are things to know, and the person deciding what they meant does it
  // from the Review tab.
  attendance_request: {
    label: "Leave or break request",
    description: "A telecaller applied for leave, asked for a break or asked to change their hours.",
    icon: "clipboard-check",
    needsAction: true,
  },
  attendance_review: {
    label: "Attendance to review",
    description: "Part of somebody's day could not be classified and needs a person to excuse it or not.",
    icon: "clipboard-check",
    needsAction: true,
  },
  attendance_break_overrun: {
    label: "Break overran",
    description: "A telecaller's break ran well past its end.",
    icon: "hourglass",
    needsAction: false,
  },
  attendance_away: {
    label: "Missed presence check",
    description: "A telecaller did not answer a presence check during their shift.",
    icon: "alarm",
    needsAction: false,
  },
  // 0143. `needsAction: false` deliberately: whether a missing telecaller is a
  // problem is the manager's call and there is nothing to decide in the
  // console, unlike a leave request. It is loud in the bell, not a queue item.
  attendance_absent: {
    label: "Shift not started",
    description: "A telecaller has not started a shift whose grace period has passed.",
    icon: "alarm",
    needsAction: false,
  },
  task_assigned: {
    label: "Task assigned",
    description: "Somebody gave you a task to accept or decline.",
    icon: "user-plus",
    // Since 0135 a task handed to you waits for your answer.
    needsAction: true,
  },
  task_response: {
    label: "Task accepted or declined",
    description: "Somebody answered a task you gave them.",
    icon: "clipboard-check",
    needsAction: false,
  },
  task_due: {
    label: "Task due",
    description: "A task of yours is due today or late.",
    icon: "clock",
    needsAction: false,
  },
  deal_stage_changed: {
    label: "Deal moved",
    description: "A deal you own changed stage.",
    icon: "arrow-right-left",
    needsAction: false,
  },
  deal_idle: {
    label: "Deal gone quiet",
    description: "A deal you own has had no activity for a while.",
    icon: "hourglass",
    needsAction: false,
  },
  automation: {
    label: "Automation",
    description: "An automation rule fired and asked to tell you.",
    icon: "zap",
    needsAction: false,
  },
  report_ready: {
    label: "Report ready",
    description: "A scheduled report finished.",
    icon: "file-text",
    needsAction: false,
  },
  // 0148. Both go to the person who asked, and neither is "needs action": a
  // file waiting to be downloaded expires on its own, and a failed export has
  // a Run again button on the job itself rather than a decision in the bell.
  export_ready: {
    label: "Export ready",
    description: "A data export you asked for is ready to download.",
    icon: "download",
    needsAction: false,
  },
  export_failed: {
    label: "Export failed",
    description: "A data export you asked for could not be finished.",
    icon: "download",
    needsAction: false,
  },
  // Not "needs action": nothing is refused at 100 %, and the conversation it
  // prompts is with the account manager, not a button in the console.
  storage_quota: {
    label: "Storage limit",
    description: "Your stored call recordings reached 80 % or 100 % of your plan's storage.",
    icon: "hard-drive",
    needsAction: false,
  },
};

/** Display order on the settings page: things to act on first. */
export const NOTIFICATION_KIND_ORDER: NotificationKind[] = (
  Object.keys(NOTIFICATION_KINDS) as NotificationKind[]
).sort((a, b) => Number(NOTIFICATION_KINDS[b].needsAction) - Number(NOTIFICATION_KINDS[a].needsAction));

/**
 * Unknown kinds fall back to a neutral spec instead of throwing: the bell reads
 * rows written by other processes, and a kind a newer worker writes must not
 * blank an older console's panel.
 */
export function notificationKindSpec(kind: string): NotificationKindSpec {
  return (
    NOTIFICATION_KINDS[kind as NotificationKind] ?? {
      label: "Notification",
      description: "",
      icon: "inbox",
      needsAction: false,
    }
  );
}

/** "9:00", "17:00" - the digest hour as the settings page and the bell say it. */
export function formatDigestHour(hour: number): string {
  return `${hour}:00`;
}

/**
 * When held notifications will appear, relative to `now` in the viewer's own
 * clock: "at 9:00" today, "tomorrow at 9:00", or a date further out.
 */
export function describeDelivery(at: string, now: Date): string {
  const when = new Date(at);
  const time = `${when.getHours()}:${String(when.getMinutes()).padStart(2, "0")}`;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(when) - day(now)) / 86_400_000);
  if (days <= 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `in ${days} days at ${time}`;
}
