import {
  CALL_ESCALATION_REASONS,
  CALL_ESCALATION_STATUS_LABELS,
  ESCALATION_POOL_LABEL,
  OWNER_ROLE_LABELS,
  OwnerRole,
  type CallEscalationEventKind,
  type CallEscalationListItem,
  type CallEscalationStatus,
} from "@aura/shared";

/**
 * Words and tones the escalation queue and its drawer share (0151), so a row
 * and the drawer it opens never describe one escalation two ways.
 */

/** The queue's status filter, as the URL and the API spell it. */
export type EscalationStatusFilter = "live" | "resolved" | "all";
/** "Assigned to me" / "Raised by me" - non-admin personas only. */
export type EscalationMineFilter = "assigned" | "raised";

/**
 * Status chip tones. Grey throughout, deliberately: red means a MISSED call
 * in this console and orange means something failed, and an escalation
 * waiting for an answer is neither. The glyph and the word carry the state -
 * the hollow ring ("not yet") for Waiting, the filled disc for Answered.
 */
export const ESCALATION_STATUS_TONE: Record<CallEscalationStatus, "solid" | "muted" | "outline"> = {
  open: "outline",
  acknowledged: "muted",
  resolved: "solid",
  withdrawn: "outline",
};

export function statusLabel(status: CallEscalationStatus): string {
  return CALL_ESCALATION_STATUS_LABELS[status] ?? status;
}

export function reasonLabel(reason: CallEscalationListItem["reason"]): string {
  return CALL_ESCALATION_REASONS[reason]?.label ?? reason;
}

/** Who has it now - a name, or the owners-and-managers pool. */
export function holderName(item: Pick<CallEscalationListItem, "assignedToName">): string {
  return item.assignedToName ?? ESCALATION_POOL_LABEL;
}

export function directionLabel(direction: string | null): string {
  if (direction === "incoming") return "Incoming";
  if (direction === "outgoing") return "Outgoing";
  return direction ? direction.charAt(0).toUpperCase() + direction.slice(1) : "Call";
}

/** "3m", "1h 5m" - the call's length; "-" when the API has none. */
export function callLength(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "-";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** A forward target as the select offers it: "Priya - Manager", "Arun - Senior telecaller". */
export function targetLabel(target: { name: string; role: string; senior: boolean }): string {
  const parsed = OwnerRole.safeParse(target.role);
  const role = parsed.success ? OWNER_ROLE_LABELS[parsed.data] : target.role;
  return target.senior && (target.role === "telecaller" || target.role === "sales")
    ? `${target.name} - Senior ${role.toLowerCase()}`
    : `${target.name} - ${role}`;
}

/** One line of the history: what happened, in the words the drawer prints. */
export function eventLabel(kind: CallEscalationEventKind): string {
  switch (kind) {
    case "raised":
      return "Escalated";
    case "acknowledged":
      return "Picked up";
    case "forwarded":
      return "Passed on";
    case "resolved":
      return "Answered";
    case "withdrawn":
      return "Withdrawn";
  }
}

/** Live for longer than this reads as overdue: the age turns orange. */
export const ESCALATION_OVERDUE_MS = 60 * 60 * 1000;
