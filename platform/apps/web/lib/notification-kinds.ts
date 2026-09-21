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
  icon: "user-plus" | "clock" | "arrow-right-left" | "hourglass" | "zap" | "file-text" | "inbox" | "ban" | "plug" | "alarm" | "clipboard-check" | "shield-alert";
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
  lead_assigned: {
    label: "Lead assigned",
    description: "A lead was routed to you.",
    icon: "inbox",
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
  task_assigned: {
    label: "Task assigned",
    description: "Somebody gave you a task.",
    icon: "user-plus",
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
