import { z } from "zod";

/**
 * Call escalations (migration 0151, Build docs/38): a telecaller hands one of
 * their calls up to a senior or a manager, from the phone or the console.
 *
 * The single vocabulary for the API, the console and - through the device
 * config block - the phone. call-escalations.test.ts compares every enum here
 * with the migration's CHECKs, so a value added on one side only fails a test
 * instead of throwing 23514 in production.
 *
 * Not `call-issues.ts` (0147): that is a client reporting a fault to the
 * vendor. This never leaves the tenant.
 */

// ── Vocabulary ─────────────────────────────────────────────────────────────

export const CallEscalationReason = z.enum([
  "wants_senior",
  "price_approval",
  "complaint",
  "cant_answer",
  "hot_lead",
  "other",
]);
export type CallEscalationReason = z.infer<typeof CallEscalationReason>;

/**
 * Labels as the telecaller reads them. Sent to the phone in the config block,
 * so the handset never carries its own copy of the list to drift from.
 */
export const CALL_ESCALATION_REASONS: Record<CallEscalationReason, { label: string; hint: string }> = {
  wants_senior: { label: "Customer wants a senior", hint: "They asked to speak to someone above me." },
  price_approval: { label: "Price or discount approval", hint: "The deal needs a price I can't give." },
  complaint: { label: "Complaint or upset customer", hint: "They're unhappy and need someone senior." },
  cant_answer: { label: "Question I can't answer", hint: "They asked something I don't know." },
  hot_lead: { label: "Hot lead, needs help closing", hint: "Ready to buy - a senior should follow up." },
  other: { label: "Something else", hint: "Say what in the note." },
};

/** Display order: the list above, which is also the enum's order. */
export const CALL_ESCALATION_REASON_ORDER: readonly CallEscalationReason[] = CallEscalationReason.options;

/**
 * open         - waiting for whoever it sits with.
 * acknowledged - somebody pressed "I'm on it".
 * resolved     - answered, with or without a note back to the telecaller.
 * withdrawn    - the telecaller took it back before anyone answered.
 */
export const CallEscalationStatus = z.enum(["open", "acknowledged", "resolved", "withdrawn"]);
export type CallEscalationStatus = z.infer<typeof CallEscalationStatus>;

/** What the partial unique index `call_escalations_live` calls live. */
export const CALL_ESCALATION_LIVE_STATUSES = ["open", "acknowledged"] as const satisfies readonly CallEscalationStatus[];

export function isLiveEscalation(status: string): boolean {
  return (CALL_ESCALATION_LIVE_STATUSES as readonly string[]).includes(status);
}

export const CALL_ESCALATION_STATUS_LABELS: Record<CallEscalationStatus, string> = {
  open: "Waiting",
  acknowledged: "Picked up",
  resolved: "Answered",
  withdrawn: "Withdrawn",
};

export const CallEscalationEventKind = z.enum(["raised", "acknowledged", "forwarded", "resolved", "withdrawn"]);
export type CallEscalationEventKind = z.infer<typeof CallEscalationEventKind>;

export const CallEscalationSource = z.enum(["device", "console"]);
export type CallEscalationSource = z.infer<typeof CallEscalationSource>;

export const CALL_ESCALATION_NOTE_MAX = 500;
export const CALL_ESCALATION_RESOLUTION_MAX = 1000;

/**
 * Live escalations one telecaller may have at once. A brake on a stuck button
 * or a runaway retry loop, not a quota - a desk with twenty unanswered
 * escalations has a staffing problem the twenty-first will not fix.
 */
export const MAX_LIVE_ESCALATIONS_PER_TELECALLER = 20;

/** How far back the phone's status list reads. */
export const DEVICE_ESCALATION_LOOKBACK_DAYS = 30;

/** What the console and the phone call "every owner and manager". */
export const ESCALATION_POOL_LABEL = "All managers & owners";

// ── Inputs ─────────────────────────────────────────────────────────────────
//
// No `.default()` anywhere: a PATCH-shaped input with a default silently
// overwrites the fields the caller never sent (the zod partial/default trap).

const note = z.string().trim().max(CALL_ESCALATION_NOTE_MAX).optional();

function otherNeedsNote<T extends { reason: CallEscalationReason; note?: string }>(v: T): boolean {
  return v.reason !== "other" || (v.note ?? "").trim().length > 0;
}
const OTHER_NEEDS_NOTE = { message: "Say what the escalation is about", path: ["note"] };

/** Console: POST /v1/owner/call-escalations. */
export const RaiseCallEscalationInput = z
  .object({
    callId: z.string().uuid(),
    reason: CallEscalationReason,
    note,
  })
  .refine(otherNeedsNote, OTHER_NEEDS_NOTE);
export type RaiseCallEscalationInput = z.infer<typeof RaiseCallEscalationInput>;

/** Phone: POST /v1/devices/me/calls/:callId/escalations. */
export const DeviceRaiseCallEscalationInput = z
  .object({
    reason: CallEscalationReason,
    note,
    /** The phone's own id for this press - a retry after a lost response is stored once. */
    clientRef: z.string().min(8).max(80),
  })
  .refine(otherNeedsNote, OTHER_NEEDS_NOTE);
export type DeviceRaiseCallEscalationInput = z.infer<typeof DeviceRaiseCallEscalationInput>;

/** POST /v1/owner/call-escalations/:id/resolve. The note goes back to the telecaller's phone. */
export const ResolveCallEscalationInput = z.object({
  note: z.string().trim().max(CALL_ESCALATION_RESOLUTION_MAX).optional(),
});
export type ResolveCallEscalationInput = z.infer<typeof ResolveCallEscalationInput>;

/**
 * POST /v1/owner/call-escalations/:id/forward - pass it up.
 * `toMembershipId: null` hands it to every owner and manager.
 */
export const ForwardCallEscalationInput = z.object({
  toMembershipId: z.string().uuid().nullable(),
  note: z.string().trim().max(CALL_ESCALATION_RESOLUTION_MAX).optional(),
});
export type ForwardCallEscalationInput = z.infer<typeof ForwardCallEscalationInput>;

/** PUT /v1/owner/call-escalation-settings - owner only. */
export const CallEscalationSettingsInput = z.object({ enabled: z.boolean() });
export type CallEscalationSettingsInput = z.infer<typeof CallEscalationSettingsInput>;

/**
 * PUT /v1/owner/call-escalation-settings/routing - owner or manager. Both lists are
 * optional and only the rows sent are touched.
 */
export const CallEscalationRoutingInput = z
  .object({
    telecallers: z
      .array(
        z.object({
          telecallerId: z.string().uuid(),
          /** null = fall back to their manager, then to every owner and manager. */
          escalateToMembershipId: z.string().uuid().nullable(),
        }),
      )
      .max(500)
      .optional(),
    seniors: z
      .array(z.object({ membershipId: z.string().uuid(), senior: z.boolean() }))
      .max(500)
      .optional(),
  })
  .refine((v) => (v.telecallers?.length ?? 0) + (v.seniors?.length ?? 0) > 0, {
    message: "Nothing to change",
  });
export type CallEscalationRoutingInput = z.infer<typeof CallEscalationRoutingInput>;

/** GET /v1/owner/call-escalations query. */
export const CallEscalationListQuery = z.object({
  /** live = open + acknowledged. */
  status: z.enum(["live", "resolved", "withdrawn", "all"]).optional(),
  /** Narrow to what I raised or what sits with me. Omitted = everything I may see. */
  mine: z.enum(["raised", "assigned"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type CallEscalationListQuery = z.infer<typeof CallEscalationListQuery>;

// ── Who receives it ────────────────────────────────────────────────────────

/** A membership as routing needs to see it. */
export interface EscalationTargetCandidate {
  membershipId: string;
  userId: string;
  ownerRole: string | null;
  /** memberships.status */
  status: string;
  /** users.status */
  userStatus: string;
  senior: boolean;
}

/** owner/manager, with NULL as the pre-persona owner (the resolveOwnerRole rule). */
export function isEscalationAdminRole(ownerRole: string | null | undefined): boolean {
  const role = ownerRole ?? "owner";
  return role === "owner" || role === "manager";
}

/** May this membership receive an escalation raised by `raiserUserId`, right now? */
export function canReceiveEscalation(
  c: EscalationTargetCandidate | null | undefined,
  raiserUserId: string | null,
): c is EscalationTargetCandidate {
  if (!c) return false;
  if (c.status !== "active" || c.userStatus !== "active") return false;
  if (raiserUserId && c.userId === raiserUserId) return false;
  return isEscalationAdminRole(c.ownerRole) || c.senior;
}

/**
 * The membership a new escalation is assigned to, or null for every owner and
 * manager. See 0151's header for the order. `reportsTo` is the 0140 approver,
 * which is only ever an owner or manager - a stale pointer to anyone else is
 * skipped rather than trusted.
 */
export function resolveEscalationTarget(
  escalateTo: EscalationTargetCandidate | null | undefined,
  reportsTo: EscalationTargetCandidate | null | undefined,
  raiserUserId: string | null,
): string | null {
  if (canReceiveEscalation(escalateTo, raiserUserId)) return escalateTo.membershipId;
  if (canReceiveEscalation(reportsTo, raiserUserId) && isEscalationAdminRole(reportsTo.ownerRole)) {
    return reportsTo.membershipId;
  }
  return null;
}

// ── The phone ──────────────────────────────────────────────────────────────

/**
 * The `callEscalation` block of GET /devices/me/config. OMITTED - never null -
 * while the workspace switch is off or the phone is bound to no active
 * telecaller, so a switched-off workspace and a 1.2.0 phone read the same.
 */
export const DeviceCallEscalationConfig = z.object({
  /** Who it will reach, for the button: "Escalate to Priya". Null = every owner and manager. */
  recipientName: z.string().nullable(),
  reasons: z.array(
    z.object({ code: CallEscalationReason, label: z.string(), hint: z.string() }),
  ),
  noteMax: z.number().int().positive(),
});
export type DeviceCallEscalationConfig = z.infer<typeof DeviceCallEscalationConfig>;

export function deviceCallEscalationConfig(recipientName: string | null): DeviceCallEscalationConfig {
  return {
    recipientName,
    reasons: CALL_ESCALATION_REASON_ORDER.map((code) => ({ code, ...CALL_ESCALATION_REASONS[code] })),
    noteMax: CALL_ESCALATION_NOTE_MAX,
  };
}

/** One row of GET /devices/me/escalations, and the body of a raise's response. */
export interface DeviceCallEscalationView {
  id: string;
  callId: string;
  status: CallEscalationStatus;
  reason: CallEscalationReason;
  reasonLabel: string;
  note: string | null;
  /** Who has it now. Null = every owner and manager. */
  assignedToName: string | null;
  /** Who pressed "I'm on it", if anyone. */
  acknowledgedByName: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

// ── The console ────────────────────────────────────────────────────────────

/** One row of GET /v1/owner/call-escalations. */
export interface CallEscalationListItem {
  id: string;
  callId: string;
  status: CallEscalationStatus;
  reason: CallEscalationReason;
  note: string | null;
  source: CallEscalationSource;
  telecallerId: string;
  telecallerName: string;
  /** Null = every owner and manager. */
  assignedMembershipId: string | null;
  assignedToName: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
  forwardCount: number;
  call: {
    startedAt: string | null;
    direction: string | null;
    durationS: number | null;
    status: string | null;
    /** The call's lead, when it has one - the link to open it. */
    leadId: string | null;
    /** The lead's name, else null (numbers are stored hashed). */
    customerLabel: string | null;
  };
  /** The viewer may pick it up, answer it or pass it on. */
  canAct: boolean;
  /** The viewer raised it and it is still live. */
  canWithdraw: boolean;
}

export interface CallEscalationEventView {
  id: string;
  kind: CallEscalationEventKind;
  actorName: string;
  /** For raised/forwarded: who it went to ("All managers & owners" for the pool). */
  toName: string | null;
  note: string | null;
  createdAt: string;
}

/** GET /v1/owner/call-escalations/:id */
export interface CallEscalationDetail extends CallEscalationListItem {
  events: CallEscalationEventView[];
  /** Where it can be passed to: owners, managers and seniors, minus the viewer and the raiser. */
  forwardTargets: Array<{ membershipId: string; name: string; role: string; senior: boolean }>;
}

/** GET /v1/owner/call-escalation-settings */
export interface CallEscalationSettingsView {
  enabled: boolean;
  /** Only an owner may flip the switch. */
  canEditSwitch: boolean;
  /** Owners and managers may change who receives what. */
  canEditRouting: boolean;
  /** Live escalations right now - shown next to the switch. */
  liveCount: number;
  telecallers: Array<{
    telecallerId: string;
    name: string;
    /** Has a console login - only then can they be a senior themselves. */
    hasLogin: boolean;
    escalateToMembershipId: string | null;
    /** 0140's reporting line, shown as the fallback. */
    reportsToMembershipId: string | null;
    reportsToName: string | null;
    /** Who an escalation raised right now would reach. Null = every owner and manager. */
    effectiveRecipientName: string | null;
  }>;
  /** Everyone with a login who could be a recipient or be made a senior. */
  members: Array<{
    membershipId: string;
    userId: string;
    name: string;
    ownerRole: string;
    senior: boolean;
    /** Owner or manager, or a senior - may be chosen as a recipient. */
    canReceive: boolean;
  }>;
}
