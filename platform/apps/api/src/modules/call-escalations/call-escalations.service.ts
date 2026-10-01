import { ConflictException, HttpException, Injectable, Logger } from "@nestjs/common";
import {
  CALL_ESCALATION_LIVE_STATUSES,
  CALL_ESCALATION_REASONS,
  type CallEscalationDetail,
  type CallEscalationEventKind,
  type CallEscalationEventView,
  type CallEscalationListItem,
  type CallEscalationListQuery,
  type CallEscalationReason,
  type CallEscalationSource,
  type CallEscalationStatus,
  type DeviceCallEscalationConfig,
  type DeviceCallEscalationView,
  DEVICE_ESCALATION_LOOKBACK_DAYS,
  deviceCallEscalationConfig,
  deviceUnderstandsAlertsSql,
  ESCALATION_POOL_LABEL,
  type EscalationTargetCandidate,
  HANDSET_ALERT_STYLE,
  HANDSET_ALERT_TTL_MINUTES,
  isLiveEscalation,
  MAX_LIVE_ESCALATIONS_PER_TELECALLER,
  nextPushDelaySeconds,
  resolveEscalationTarget,
  resolveOwnerRole,
} from "@aura/shared";
import { FcmService } from "../../fcm/fcm.service";
import { notify } from "../notifications/notify";
import { RealtimeService } from "../realtime/realtime.service";

/**
 * Call escalations (migration 0151, Build docs/38): the logic the console's
 * routes, the handset's routes and the device config block share.
 *
 * ── WHAT NEVER ENTERS THESE ROWS ────────────────────────────────────────────
 *
 * No transcript, summary or audio is copied into `call_escalations`, its
 * events, a bell notification or a phone alert. What travels is the
 * telecaller's own reason and note, the resolver's own note, people's names and
 * the lead's NAME (never a number - numbers are stored hashed, and a lead's
 * title can be a masked one, see CUSTOMER_LABEL_SQL). Whoever opens an
 * escalation reads the call through GET /owner/call-escalations/:id/call, under
 * their own `recordings_listen`.
 *
 * ── ROUND TRIPS ─────────────────────────────────────────────────────────────
 *
 * The API is in Mumbai and the database in Seoul (~125ms a flight), so the
 * reads are folded: one statement loads everything a raise has to decide, the
 * insert writes the escalation, its first event and its audit row together,
 * and a phone alert's insert returns the push tokens it needs.
 */

/** A `withOrg` client, as far as this module needs one. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/** `'open', 'acknowledged'` - what the partial unique index `call_escalations_live` calls live. */
export const LIVE_SQL = CALL_ESCALATION_LIVE_STATUSES.map((s) => `'${s}'`).join(", ");

/** A person's display name off a `users` alias. */
export const userNameSql = (u: string): string => `COALESCE(NULLIF(btrim(${u}.name), ''), ${u}.email)`;

/**
 * The customer, as an escalation names them: the lead's name, else nothing.
 *
 * `leads.title` is the person's name when one is known and otherwise a MASKED
 * NUMBER ("+9198…", see leadTitle in @aura/shared), so the title is only used
 * when it carries no digit at all. An escalation never shows a number.
 */
export const customerLabelSql = (l: string): string => `COALESCE(
    NULLIF(btrim(${l}.contact_name), ''),
    CASE WHEN ${l}.title !~ '[0-9]' AND ${l}.title <> 'Unknown caller'
         THEN NULLIF(btrim(${l}.title), '') END)`;

/** The console link a bell item opens: the queue, with the drawer on this one. */
export const escalationLink = (id: string): string => `/owner/escalations?open=${id}`;

export function reasonLabel(reason: CallEscalationReason): string {
  return CALL_ESCALATION_REASONS[reason]?.label ?? reason;
}

const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());

// ── Who receives it ────────────────────────────────────────────────────────

/**
 * A telecaller's routing, alias `t`: who they escalate to (0151) and who they
 * report to (0140), each with what `canReceiveEscalation` needs to judge it.
 * Pair with ROUTING_JOINS.
 */
export const ROUTING_COLUMNS = `
  t.id AS tc_id, t.display_name AS tc_name, t.user_id AS tc_user_id,
  et.id AS et_id, et.user_id AS et_user_id, et.owner_role AS et_role, et.status AS et_status,
  etu.status AS et_user_status, et.escalation_senior AS et_senior, ${userNameSql("etu")} AS et_name,
  rt.id AS rt_id, rt.user_id AS rt_user_id, rt.owner_role AS rt_role, rt.status AS rt_status,
  rtu.status AS rt_user_status, rt.escalation_senior AS rt_senior, ${userNameSql("rtu")} AS rt_name`;

export const ROUTING_JOINS = `
  LEFT JOIN memberships et ON et.id = t.escalate_to_membership_id
  LEFT JOIN users etu      ON etu.id = et.user_id
  LEFT JOIN memberships rt ON rt.id = t.reports_to_membership_id
  LEFT JOIN users rtu      ON rtu.id = rt.user_id`;

export interface RoutingRow {
  tc_id: string | null;
  tc_name: string | null;
  tc_user_id: string | null;
  et_id: string | null;
  et_user_id: string | null;
  et_role: string | null;
  et_status: string | null;
  et_user_status: string | null;
  et_senior: boolean | null;
  et_name: string | null;
  rt_id: string | null;
  rt_user_id: string | null;
  rt_role: string | null;
  rt_status: string | null;
  rt_user_status: string | null;
  rt_senior: boolean | null;
  rt_name: string | null;
}

function candidate(
  id: string | null,
  userId: string | null,
  role: string | null,
  status: string | null,
  userStatus: string | null,
  senior: boolean | null,
): EscalationTargetCandidate | null {
  if (!id || !userId) return null;
  return {
    membershipId: id,
    userId,
    ownerRole: role,
    // A missing user reads as not active: a pointer at nobody is skipped.
    status: status ?? "suspended",
    userStatus: userStatus ?? "suspended",
    senior: senior === true,
  };
}

export interface ResolvedTarget {
  /** Null = every active owner and manager. */
  membershipId: string | null;
  /** The recipient's display name; null exactly when `membershipId` is. */
  name: string | null;
}

/** `resolveEscalationTarget` over a routing row, with the winner's name. */
export function resolveRouting(row: RoutingRow): ResolvedTarget {
  const escalateTo = candidate(row.et_id, row.et_user_id, row.et_role, row.et_status, row.et_user_status, row.et_senior);
  const reportsTo = candidate(row.rt_id, row.rt_user_id, row.rt_role, row.rt_status, row.rt_user_status, row.rt_senior);
  const id = resolveEscalationTarget(escalateTo, reportsTo, row.tc_user_id);
  if (!id) return { membershipId: null, name: null };
  const name = id === row.et_id ? row.et_name : row.rt_name;
  return { membershipId: id, name: name ?? "Your manager" };
}

// ── Everything a raise has to decide, in one read ──────────────────────────

export interface RaiseContext extends RoutingRow {
  enabled: boolean;
  /** Device mode: the phone is active and not removed. Always true from the console. */
  device_ok: boolean;
  call_found: boolean;
  call_telecaller_id: string | null;
  customer_label: string | null;
  /** The call's live escalation, if it has one - a second press returns it. */
  live_on_call: string | null;
  /** Live escalations this telecaller already has (MAX_LIVE_ESCALATIONS_PER_TELECALLER). */
  live_count: number;
  /** Device mode: the escalation this phone already stored under the same clientRef. */
  replay_id: string | null;
  /** Who is raising it: the viewer's name (console), the telecaller's (device). */
  actor_name: string | null;
}

export type RaiseWho =
  | { kind: "console"; orgId: string; telecallerId: string; userId: string }
  | { kind: "device"; deviceId: string; clientRef: string | null };

/**
 * The org switch, the raiser's routing and - when `callId` is given - the call,
 * its live escalation and the raiser's live count. ONE statement.
 *
 * Device mode joins the telecaller the phone is bound to RIGHT NOW (never one
 * named by the request); console mode takes the viewer's own telecaller
 * identity, which OwnerScopeGuard resolved from `telecallers.user_id`.
 */
export async function loadRaiseContext(client: Queryable, who: RaiseWho, callId: string | null): Promise<RaiseContext | null> {
  const params: unknown[] = [];
  const p = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };

  const callCols = callId
    ? `(c.id IS NOT NULL) AS call_found, c.telecaller_id AS call_telecaller_id,
       ${customerLabelSql("l")} AS customer_label,
       (SELECT ce.id FROM call_escalations ce
         WHERE ce.call_id = c.id AND ce.status IN (${LIVE_SQL}) LIMIT 1) AS live_on_call,
       (SELECT count(*)::int FROM call_escalations ce
         WHERE ce.telecaller_id = t.id AND ce.status IN (${LIVE_SQL})) AS live_count`
    : `false AS call_found, NULL::uuid AS call_telecaller_id, NULL::text AS customer_label,
       NULL::uuid AS live_on_call, 0 AS live_count`;
  const callJoins = callId
    ? `LEFT JOIN calls c ON c.id = ${p(callId)}::uuid
       LEFT JOIN leads l ON l.id = c.lead_id`
    : "";

  let sql: string;
  if (who.kind === "device") {
    const replay = who.clientRef
      ? `(SELECT ce.id FROM call_escalations ce
           WHERE ce.org_id = d.org_id AND ce.device_id = d.id AND ce.client_ref = ${p(who.clientRef)}::text) AS replay_id`
      : `NULL::uuid AS replay_id`;
    sql = `SELECT o.call_escalation_enabled AS enabled,
                  (d.status = 'active' AND d.removed_at IS NULL) AS device_ok,
                  ${ROUTING_COLUMNS},
                  ${callCols},
                  ${replay},
                  t.display_name AS actor_name
             FROM devices d
             JOIN organizations o ON o.id = d.org_id
             LEFT JOIN telecallers t ON t.id = d.telecaller_id AND t.status = 'active'
             ${ROUTING_JOINS}
             ${callJoins}
            WHERE d.id = ${p(who.deviceId)}::uuid`;
  } else {
    sql = `SELECT o.call_escalation_enabled AS enabled,
                  true AS device_ok,
                  ${ROUTING_COLUMNS},
                  ${callCols},
                  NULL::uuid AS replay_id,
                  (SELECT ${userNameSql("vu")} FROM users vu WHERE vu.id = ${p(who.userId)}::uuid) AS actor_name
             FROM organizations o
             LEFT JOIN telecallers t ON t.id = ${p(who.telecallerId)}::uuid AND t.org_id = o.id AND t.status = 'active'
             ${ROUTING_JOINS}
             ${callJoins}
            WHERE o.id = ${p(who.orgId)}::uuid`;
  }
  // Placeholders are numbered in the order `p()` ran, not the order they read
  // in the text - which is fine, as each value is bound exactly once.
  const {
    rows: [row],
  } = await client.query<RaiseContext>(sql, params);
  return row ?? null;
}

/**
 * The `callEscalation` block of GET /devices/me/config, or null when it must be
 * OMITTED: the switch is off, the phone is not active, or it is bound to no
 * active telecaller. `recipientName` is who the button will reach; null is the
 * pool.
 */
export async function deviceCallEscalationBlock(client: Queryable, deviceId: string): Promise<DeviceCallEscalationConfig | null> {
  const ctx = await loadRaiseContext(client, { kind: "device", deviceId, clientRef: null }, null);
  if (!ctx || ctx.enabled !== true || !ctx.device_ok || !ctx.tc_id) return null;
  return deviceCallEscalationConfig(resolveRouting(ctx).name);
}

// ── Who may see and act ────────────────────────────────────────────────────

export interface EscalationViewer {
  userId: string;
  /** Owner or manager persona: sees every escalation, may act on any live one. */
  admin: boolean;
  /** The viewer's active telecaller identity, if they have one. */
  telecallerId: string | null;
}

/**
 * The per-row facts about the viewer, as SQL over alias `e` with the viewer's
 * users.id at `user`. Each is a plain boolean (COALESCE: `NULL IN (...)` is
 * NULL, not false).
 */
export function viewerFlagsSql(e: string, user: string): { assignedToMe: string; raisedByMe: string; actedOn: string } {
  return {
    assignedToMe: `COALESCE(${e}.assigned_membership_id IN (
        SELECT vm.id FROM memberships vm WHERE vm.user_id = ${user}), false)`,
    raisedByMe: `COALESCE(${e}.telecaller_id IN (
        SELECT vt.id FROM telecallers vt WHERE vt.user_id = ${user}), false)`,
    actedOn: `EXISTS (SELECT 1 FROM call_escalation_events vev
                       WHERE vev.escalation_id = ${e}.id AND vev.actor_user_id = ${user})`,
  };
}

/**
 * Whether the viewer may see an escalation (doc 38, "Who sees and acts"): an
 * owner or manager sees all of them; anyone else sees one assigned to one of
 * their memberships, raised by their telecaller identity, or one they acted on.
 */
export function escalationVisibleSql(e: string, user: string, admin: boolean): string {
  if (admin) return "true";
  const f = viewerFlagsSql(e, user);
  return `(${f.assignedToMe} OR ${f.raisedByMe} OR ${f.actedOn})`;
}

/**
 * canAct = live AND (admin OR assigned to me) - an escalation sitting with the
 * pool is the admins' to pick up. canWithdraw = live AND raised by me.
 */
export function escalationPermissions(
  status: string,
  admin: boolean,
  flags: { assignedToMe: boolean; raisedByMe: boolean },
): { canAct: boolean; canWithdraw: boolean } {
  const live = isLiveEscalation(status);
  return { canAct: live && (admin || flags.assignedToMe), canWithdraw: live && flags.raisedByMe };
}

// ── Reading rows ───────────────────────────────────────────────────────────

/** One escalation as every read selects it. Pair with ESCALATION_FROM. */
export const escalationColumns = (user: string): string => {
  const f = viewerFlagsSql("e", user);
  return `
  e.id, e.call_id, e.status, e.reason, e.note, e.source, e.telecaller_id,
  t.display_name AS telecaller_name,
  e.assigned_membership_id, ${userNameSql("au")} AS assigned_to_name,
  e.created_at, e.acknowledged_at, ${userNameSql("aku")} AS acknowledged_by_name,
  e.resolved_at, ${userNameSql("ru")} AS resolved_by_name, e.resolution_note, e.forward_count,
  c.started_at AS call_started_at, c.direction AS call_direction, c.duration_s AS call_duration_s,
  c.status AS call_status, c.lead_id AS call_lead_id, ${customerLabelSql("l")} AS customer_label,
  ${f.assignedToMe} AS assigned_to_me, ${f.raisedByMe} AS raised_by_me`;
};

export const ESCALATION_FROM = `
  FROM call_escalations e
  JOIN telecallers t       ON t.id = e.telecaller_id
  LEFT JOIN calls c        ON c.id = e.call_id
  LEFT JOIN leads l        ON l.id = c.lead_id
  LEFT JOIN memberships am ON am.id = e.assigned_membership_id
  LEFT JOIN users au       ON au.id = am.user_id
  LEFT JOIN users aku      ON aku.id = e.acknowledged_by
  LEFT JOIN users ru       ON ru.id = e.resolved_by`;

export interface EscalationRow {
  id: string;
  call_id: string;
  status: CallEscalationStatus;
  reason: CallEscalationReason;
  note: string | null;
  source: CallEscalationSource;
  telecaller_id: string;
  telecaller_name: string | null;
  assigned_membership_id: string | null;
  assigned_to_name: string | null;
  created_at: Date | string;
  acknowledged_at: Date | string | null;
  acknowledged_by_name: string | null;
  resolved_at: Date | string | null;
  resolved_by_name: string | null;
  resolution_note: string | null;
  forward_count: number | string;
  call_started_at: Date | string | null;
  call_direction: string | null;
  call_duration_s: number | null;
  call_status: string | null;
  call_lead_id: string | null;
  customer_label: string | null;
  assigned_to_me: boolean;
  raised_by_me: boolean;
}

export interface EscalationDetailRow extends EscalationRow {
  events: Array<{ id: string; kind: CallEscalationEventKind; actorName: string; toName: string | null; note: string | null; createdAt: string }> | null;
  forward_targets: Array<{ membershipId: string; name: string; role: string | null; senior: boolean }> | null;
}

export function toListItem(r: EscalationRow, viewer: { admin: boolean }): CallEscalationListItem {
  const perms = escalationPermissions(r.status, viewer.admin, {
    assignedToMe: r.assigned_to_me === true,
    raisedByMe: r.raised_by_me === true,
  });
  return {
    id: r.id,
    callId: r.call_id,
    status: r.status,
    reason: r.reason,
    note: r.note,
    source: r.source,
    telecallerId: r.telecaller_id,
    telecallerName: r.telecaller_name ?? "A telecaller",
    assignedMembershipId: r.assigned_membership_id,
    assignedToName: r.assigned_membership_id ? (r.assigned_to_name ?? null) : null,
    createdAt: iso(r.created_at) as string,
    acknowledgedAt: iso(r.acknowledged_at),
    acknowledgedByName: r.acknowledged_by_name,
    resolvedAt: iso(r.resolved_at),
    resolvedByName: r.resolved_by_name,
    resolutionNote: r.resolution_note,
    forwardCount: Number(r.forward_count ?? 0),
    call: {
      startedAt: iso(r.call_started_at),
      direction: r.call_direction,
      durationS: r.call_duration_s == null ? null : Number(r.call_duration_s),
      status: r.call_status,
      leadId: r.call_lead_id,
      customerLabel: r.customer_label,
    },
    canAct: perms.canAct,
    canWithdraw: perms.canWithdraw,
  };
}

export function toDetail(r: EscalationDetailRow, viewer: { admin: boolean }): CallEscalationDetail {
  const events: CallEscalationEventView[] = (r.events ?? []).map((ev) => ({
    id: ev.id,
    kind: ev.kind,
    actorName: ev.actorName,
    toName: ev.toName,
    note: ev.note,
    createdAt: iso(ev.createdAt) as string,
  }));
  return {
    ...toListItem(r, viewer),
    events,
    forwardTargets: (r.forward_targets ?? []).map((m) => ({
      membershipId: m.membershipId,
      name: m.name,
      role: resolveOwnerRole(m.role),
      senior: m.senior === true,
    })),
  };
}

export function toDeviceView(r: EscalationRow): DeviceCallEscalationView {
  return {
    id: r.id,
    callId: r.call_id,
    status: r.status,
    reason: r.reason,
    reasonLabel: reasonLabel(r.reason),
    note: r.note,
    assignedToName: r.assigned_membership_id ? (r.assigned_to_name ?? null) : null,
    acknowledgedByName: r.acknowledged_by_name,
    resolvedByName: r.resolved_by_name,
    resolutionNote: r.resolution_note,
    createdAt: iso(r.created_at) as string,
    resolvedAt: iso(r.resolved_at),
  };
}

// ── What the bell and the phone say ────────────────────────────────────────

/**
 * Title and body for "it now sits with you". The reason, the lead's name and
 * the telecaller's (or forwarder's) own note - never anything said on the call.
 */
export function escalationReceivedText(x: {
  event: "raised" | "forwarded";
  telecallerName: string;
  actorName: string;
  reason: CallEscalationReason;
  customerLabel: string | null;
  note: string | null;
}): { title: string; body: string } {
  const about = [reasonLabel(x.reason), x.customerLabel].filter(Boolean).join(" · ");
  const said = x.note ? ` - "${x.note}"` : "";
  if (x.event === "raised") {
    return { title: `${x.telecallerName} escalated a call`, body: `${about}${said}` };
  }
  return { title: `${x.actorName} passed you an escalation`, body: `${x.telecallerName}'s call · ${about}${said}` };
}

/** Title and bell body for "your escalation was answered". The phone's body is the note alone. */
export function escalationResolvedText(x: {
  resolverName: string;
  reason: CallEscalationReason;
  customerLabel: string | null;
  note: string | null;
}): { title: string; body: string } {
  const title = `${x.resolverName} answered your escalation${x.customerLabel ? ` about ${x.customerLabel}` : ""}`;
  return { title, body: x.note ?? reasonLabel(x.reason) };
}

// ── The service ────────────────────────────────────────────────────────────

export interface RaiseInput {
  ctx: RaiseContext;
  orgId: string;
  callId: string;
  reason: CallEscalationReason;
  note: string | null;
  source: CallEscalationSource;
  deviceId: string | null;
  clientRef: string | null;
  /** users.id of whoever raised it - the telecaller's login, which may not exist. */
  raisedByUserId: string | null;
  actorName: string;
  audit: { type: string; id: string };
}

export interface RaiseOutcome {
  id: string;
  duplicate: boolean;
  /** FCM tokens to wake with `{action: "alert"}` once the transaction has committed. */
  tokens: string[];
}

export interface AssignmentDelivery {
  escalationId: string;
  forwardCount: number;
  /** Null = every active owner and manager. */
  assignedMembershipId: string | null;
  /** Users who must not be told: the raiser's login(s). The actor is skipped too. */
  exclude: Array<string | null>;
  actorUserId: string | null;
  event: "raised" | "forwarded";
  telecallerName: string;
  actorName: string;
  reason: CallEscalationReason;
  customerLabel: string | null;
  note: string | null;
  callId: string;
}

export interface ResolutionDelivery {
  escalationId: string;
  /** The raiser's console login, if any - the bell. */
  raiserUserId: string | null;
  /** The raiser's telecaller - the phone. */
  telecallerId: string;
  telecallerUserId: string | null;
  resolverUserId: string | null;
  resolverName: string;
  reason: CallEscalationReason;
  customerLabel: string | null;
  note: string | null;
  callId: string;
}

export type TransitionKind = Exclude<CallEscalationEventKind, "raised">;

/**
 * The SET clause of each step. $1 is the escalation, $2 the acting user, and
 * $12 the step's own value (the resolution note, the forward target).
 */
const TRANSITION_SET: Record<TransitionKind, { set: string; takesValue: boolean }> = {
  acknowledged: {
    set: `status = 'acknowledged', acknowledged_by = $2::uuid, acknowledged_at = now()`,
    takesValue: false,
  },
  resolved: {
    set: `status = 'resolved', resolved_by = $2::uuid, resolved_at = now(), resolution_note = $12::text`,
    takesValue: true,
  },
  // Passing it on clears the "I'm on it": the new holder has not picked it up.
  forwarded: {
    set: `status = 'open', assigned_membership_id = $12::uuid, acknowledged_by = NULL,
          acknowledged_at = NULL, forward_count = forward_count + 1`,
    takesValue: true,
  },
  withdrawn: { set: `status = 'withdrawn'`, takesValue: false },
};

export interface TransitionInput {
  id: string;
  kind: TransitionKind;
  actorUserId: string | null;
  actorName: string;
  toMembershipId?: string | null;
  toName?: string | null;
  note?: string | null;
  /** The resolution note (resolved) or the new assignee (forwarded). */
  value?: string | null;
  audit: { type: string; id: string; meta: Record<string, unknown> };
}

/** An escalation locked for a step, with what deciding and telling people needs. */
export interface ActionRow {
  id: string;
  status: CallEscalationStatus;
  reason: CallEscalationReason;
  call_id: string;
  telecaller_id: string;
  assigned_membership_id: string | null;
  forward_count: number | string;
  raised_by_user_id: string | null;
  telecaller_name: string | null;
  tc_user_id: string | null;
  customer_label: string | null;
  acknowledged_by_name: string | null;
  assigned_to_me: boolean;
  raised_by_me: boolean;
  viewer_name: string | null;
  raiser_has_login: boolean;
}

@Injectable()
export class CallEscalationsService {
  private readonly logger = new Logger(CallEscalationsService.name);

  constructor(
    private readonly fcm: FcmService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Store a new escalation and tell whoever it now sits with. The caller has
   * already checked the switch, the raiser and the call (`loadRaiseContext`).
   *
   * A call with a live escalation returns that one, `duplicate: true` - a
   * second press is the same escalation. So does a lost race on either unique
   * index (the call's live one, or the phone's clientRef).
   */
  async raise(client: Queryable, input: RaiseInput): Promise<RaiseOutcome> {
    const { ctx } = input;
    if (ctx.live_on_call) return { id: ctx.live_on_call, duplicate: true, tokens: [] };
    if (ctx.live_count >= MAX_LIVE_ESCALATIONS_PER_TELECALLER) {
      throw new HttpException(
        {
          code: "too_many_live",
          message: `You already have ${ctx.live_count} escalations waiting for an answer. Wait for one of those first.`,
        },
        429,
      );
    }

    const target = resolveRouting(ctx);
    const {
      rows: [inserted],
    } = await client.query<{ id: string }>(
      // One statement: the escalation, its first history row and its audit row.
      // ON CONFLICT with no target covers both unique indexes - the call's live
      // escalation and the phone's clientRef - and every CTE reads `ins`, so a
      // conflict writes nothing at all.
      `WITH ins AS (
         INSERT INTO call_escalations
           (org_id, call_id, telecaller_id, reason, note, assigned_membership_id, source,
            device_id, raised_by_user_id, client_ref)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::uuid, $7::text,
                 $8::uuid, $9::uuid, $10::text)
         ON CONFLICT DO NOTHING
         RETURNING id, org_id
       ),
       ev AS (
         INSERT INTO call_escalation_events
           (org_id, escalation_id, kind, actor_user_id, actor_name, to_membership_id, to_name, note)
         SELECT ins.org_id, ins.id, 'raised', $9::uuid, $11::text, $6::uuid, $12::text, $5::text FROM ins
         RETURNING 1
       ),
       au AS (
         INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         SELECT ins.org_id, $13::text, $14::text, 'call_escalation.raised', 'call_escalation', ins.id::text, $15::jsonb
           FROM ins
         RETURNING 1
       )
       SELECT ins.id FROM ins`,
      [
        input.orgId,
        input.callId,
        ctx.tc_id,
        input.reason,
        input.note,
        target.membershipId,
        input.source,
        input.deviceId,
        input.raisedByUserId,
        input.clientRef,
        input.actorName.slice(0, 200) || "A telecaller",
        target.membershipId ? target.name : ESCALATION_POOL_LABEL,
        input.audit.type,
        input.audit.id,
        JSON.stringify({
          callId: input.callId,
          telecallerId: ctx.tc_id,
          reason: input.reason,
          source: input.source,
          assignedMembershipId: target.membershipId,
        }),
      ],
    );

    if (!inserted) {
      const {
        rows: [existing],
      } = await client.query<{ id: string }>(
        `SELECT id FROM call_escalations
          WHERE ($1::uuid IS NOT NULL AND device_id = $1::uuid AND client_ref = $2::text)
             OR (call_id = $3::uuid AND status IN (${LIVE_SQL}))
          ORDER BY (client_ref IS NOT DISTINCT FROM $2::text) DESC
          LIMIT 1`,
        [input.deviceId, input.clientRef, input.callId],
      );
      if (!existing) throw new ConflictException("the escalation could not be stored - try again");
      return { id: existing.id, duplicate: true, tokens: [] };
    }

    const tokens = await this.deliverAssignment(client, input.orgId, {
      escalationId: inserted.id,
      forwardCount: 0,
      assignedMembershipId: target.membershipId,
      exclude: [ctx.tc_user_id, input.raisedByUserId],
      actorUserId: input.raisedByUserId,
      event: "raised",
      telecallerName: ctx.tc_name ?? "A telecaller",
      actorName: input.actorName,
      reason: input.reason,
      customerLabel: ctx.customer_label,
      note: input.note,
      callId: input.callId,
    });
    return { id: inserted.id, duplicate: false, tokens };
  }

  /**
   * The users an assignment reaches: the assigned membership's user when that
   * membership and user are both active, else - for the pool - every active
   * owner and manager, one membership per person, org-scope row first. Minus
   * `exclude` (the raiser: escalating to yourself is not escalating).
   */
  async recipientsFor(client: Queryable, orgId: string, assignedMembershipId: string | null, exclude: Array<string | null>): Promise<string[]> {
    const skip = exclude.filter((x): x is string => typeof x === "string" && x.length > 0);
    const { rows } = assignedMembershipId
      ? await client.query<{ user_id: string }>(
          `SELECT m.user_id
             FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.id = $1::uuid AND m.org_id = $2::uuid
              AND m.status = 'active' AND u.status = 'active'
              AND NOT (m.user_id = ANY($3::uuid[]))`,
          [assignedMembershipId, orgId, skip],
        )
      : await client.query<{ user_id: string }>(
          `SELECT DISTINCT ON (m.user_id) m.user_id
             FROM memberships m JOIN users u ON u.id = m.user_id
            WHERE m.org_id = $1::uuid
              AND COALESCE(m.owner_role, 'owner') IN ('owner', 'manager')
              AND m.status = 'active' AND u.status = 'active'
              AND NOT (m.user_id = ANY($2::uuid[]))
            ORDER BY m.user_id, (m.scope_type = 'org') DESC, m.id`,
          [orgId, skip],
        );
    return rows.map((r) => r.user_id);
  }

  /**
   * Raised or passed on: a `call_escalated` bell item for each recipient, and
   * an `escalation_received` popup on the phone of any recipient who is also an
   * active telecaller with an active phone. Returns the push tokens.
   */
  async deliverAssignment(client: Queryable, orgId: string, d: AssignmentDelivery): Promise<string[]> {
    const userIds = await this.recipientsFor(client, orgId, d.assignedMembershipId, [...d.exclude, d.actorUserId]);
    if (userIds.length === 0) return [];
    const text = escalationReceivedText(d);
    for (const userId of userIds) {
      await notify(
        client as never,
        orgId,
        {
          userId,
          kind: "call_escalated",
          title: text.title.slice(0, 200),
          body: text.body.slice(0, 1000),
          linkPath: escalationLink(d.escalationId),
          dedupeKey: `call_escalated:${d.escalationId}:${d.forwardCount}`,
        },
        d.actorUserId,
      );
    }
    return this.insertAlerts(
      client,
      orgId,
      { userIds },
      {
        kind: "escalation_received",
        title: text.title,
        body: text.body,
        callId: d.callId,
        dedupeKey: `escalation_received:${d.escalationId}:${d.forwardCount}`,
      },
    );
  }

  /**
   * Answered: a `call_escalation_update` bell item to the raiser's login when
   * they have one, and an `escalation_update` popup on their phone whose body
   * is the resolver's own note. Returns the push tokens.
   */
  async deliverResolution(client: Queryable, orgId: string, r: ResolutionDelivery): Promise<string[]> {
    const text = escalationResolvedText(r);
    if (r.raiserUserId) {
      await notify(
        client as never,
        orgId,
        {
          userId: r.raiserUserId,
          kind: "call_escalation_update",
          title: text.title.slice(0, 200),
          body: text.body.slice(0, 1000),
          linkPath: escalationLink(r.escalationId),
          dedupeKey: `call_escalation_update:${r.escalationId}:resolved`,
        },
        r.resolverUserId,
      );
    }
    // An owner who escalated their own call and then answered it needs no popup.
    if (r.resolverUserId && r.resolverUserId === r.telecallerUserId) return [];
    return this.insertAlerts(
      client,
      orgId,
      { telecallerIds: [r.telecallerId] },
      {
        kind: "escalation_update",
        title: text.title,
        body: r.note,
        callId: r.callId,
        dedupeKey: `escalation_update:${r.escalationId}`,
      },
    );
  }

  /**
   * Phone alerts for these users' (or telecallers') active telecaller
   * identities that have an active phone, and the push tokens of the phones
   * that understand alerts - one statement.
   *
   * Each row is stamped as one push in (`push_attempts = 1`, `next_push_at` on
   * the ladder), exactly as owner-handset-alerts does, because the push is sent
   * right after commit; the worker's sweep retries from there. The dedupe key
   * makes a replay insert nothing, and a row not inserted returns no token, so
   * nothing is pushed twice.
   */
  async insertAlerts(
    client: Queryable,
    orgId: string,
    to: { userIds: string[] } | { telecallerIds: string[] },
    a: {
      kind: "escalation_received" | "escalation_update";
      title: string;
      body: string | null;
      callId: string;
      dedupeKey: string;
    },
  ): Promise<string[]> {
    const ids = "userIds" in to ? to.userIds : to.telecallerIds;
    if (ids.length === 0) return [];
    const { rows } = await client.query<{ fcm_token: string }>(
      `WITH tc AS (
         SELECT t.id FROM telecallers t
          WHERE t.org_id = $1::uuid AND t.status = 'active'
            AND ${"userIds" in to ? "t.user_id" : "t.id"} = ANY($2::uuid[])
            AND EXISTS (SELECT 1 FROM devices d
                         WHERE d.telecaller_id = t.id AND d.status = 'active' AND d.removed_at IS NULL)
       ),
       ins AS (
         INSERT INTO handset_alerts
           (org_id, telecaller_id, kind, style, title, body, call_id, dedupe_key,
            expires_at, push_attempts, last_push_at, next_push_at)
         SELECT $1::uuid, tc.id, $3::text, $4::text, $5::text, $6::text, $7::uuid, $8::text,
                now() + make_interval(mins => $9), 1, now(), now() + make_interval(secs => $10)
           FROM tc
         ON CONFLICT (telecaller_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING telecaller_id
       )
       SELECT DISTINCT d.fcm_token
         FROM devices d
         JOIN ins ON ins.telecaller_id = d.telecaller_id
        WHERE d.org_id = $1::uuid AND d.status = 'active' AND d.removed_at IS NULL
          AND d.fcm_token IS NOT NULL
          AND ${deviceUnderstandsAlertsSql("d")}`,
      [
        orgId,
        ids,
        a.kind,
        HANDSET_ALERT_STYLE[a.kind],
        a.title.slice(0, 120),
        a.body ? a.body.slice(0, 600) : null,
        a.callId,
        a.dedupeKey,
        HANDSET_ALERT_TTL_MINUTES[a.kind],
        nextPushDelaySeconds(1),
      ],
    );
    return rows.map((r) => r.fcm_token);
  }

  /** Lock one escalation the viewer can see, for a step. Null = not found or not theirs to see. */
  async lockForAction(client: Queryable, id: string, viewer: EscalationViewer): Promise<ActionRow | null> {
    const f = viewerFlagsSql("e", "$2::uuid");
    const {
      rows: [row],
    } = await client.query<ActionRow>(
      `SELECT e.id, e.status, e.reason, e.call_id, e.telecaller_id, e.assigned_membership_id,
              e.forward_count, e.raised_by_user_id,
              t.display_name AS telecaller_name, t.user_id AS tc_user_id,
              ${customerLabelSql("l")} AS customer_label,
              ${userNameSql("aku")} AS acknowledged_by_name,
              ${f.assignedToMe} AS assigned_to_me,
              ${f.raisedByMe} AS raised_by_me,
              (SELECT ${userNameSql("vu")} FROM users vu WHERE vu.id = $2::uuid) AS viewer_name,
              -- Whether the raiser can open the console at all - only then is
              -- a bell item for them worth writing.
              EXISTS (SELECT 1 FROM memberships rm JOIN users ru ON ru.id = rm.user_id
                       WHERE rm.org_id = e.org_id AND rm.user_id = COALESCE(e.raised_by_user_id, t.user_id)
                         AND rm.status = 'active' AND ru.status = 'active') AS raiser_has_login
         FROM call_escalations e
         JOIN telecallers t ON t.id = e.telecaller_id
         LEFT JOIN calls c ON c.id = e.call_id
         LEFT JOIN leads l ON l.id = c.lead_id
         LEFT JOIN users aku ON aku.id = e.acknowledged_by
        WHERE e.id = $1::uuid AND ${escalationVisibleSql("e", "$2::uuid", viewer.admin)}
        FOR UPDATE OF e`,
      [id, viewer.userId],
    );
    return row ?? null;
  }

  /**
   * One step - the row, its history entry and its audit row in one statement.
   * Run it under `lockForAction`'s lock, after deciding the step is allowed.
   */
  async transition(client: Queryable, t: TransitionInput): Promise<{ id: string; forward_count: number }> {
    const step = TRANSITION_SET[t.kind];
    const params: unknown[] = [
      t.id,
      t.actorUserId,
      t.kind,
      t.actorName.slice(0, 200) || "Someone",
      t.toMembershipId ?? null,
      t.toName ?? null,
      t.note ?? null,
      t.audit.type,
      t.audit.id,
      `call_escalation.${t.kind}`,
      JSON.stringify(t.audit.meta),
    ];
    if (step.takesValue) params.push(t.value ?? null);
    const {
      rows: [row],
    } = await client.query<{ id: string; forward_count: number | string }>(
      `WITH u AS (
         UPDATE call_escalations SET ${step.set} WHERE id = $1::uuid
         RETURNING id, org_id, forward_count
       ),
       ev AS (
         INSERT INTO call_escalation_events
           (org_id, escalation_id, kind, actor_user_id, actor_name, to_membership_id, to_name, note)
         SELECT u.org_id, u.id, $3::text, $2::uuid, $4::text, $5::uuid, $6::text, $7::text FROM u
         RETURNING 1
       ),
       au AS (
         INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         SELECT u.org_id, $8::text, $9::text, $10::text, 'call_escalation', u.id::text, $11::jsonb FROM u
         RETURNING 1
       )
       SELECT u.id, u.forward_count FROM u`,
      params,
    );
    if (!row) throw new ConflictException("the escalation changed while you were acting on it - reload it");
    return { id: row.id, forward_count: Number(row.forward_count) };
  }

  /** GET /owner/call-escalations/:id, as the viewer may see it. */
  async readDetail(client: Queryable, id: string, viewer: EscalationViewer): Promise<CallEscalationDetail | null> {
    const {
      rows: [row],
    } = await client.query<EscalationDetailRow>(
      `SELECT ${escalationColumns("$2::uuid")},
              (SELECT json_agg(json_build_object(
                        'id', ev.id, 'kind', ev.kind, 'actorName', ev.actor_name,
                        'toName', ev.to_name, 'note', ev.note, 'createdAt', ev.created_at)
                      ORDER BY ev.created_at, ev.id)
                 FROM call_escalation_events ev WHERE ev.escalation_id = e.id) AS events,
              -- Where it can be passed to: owners, managers and seniors, minus
              -- the viewer and the raiser. One membership per person.
              (SELECT json_agg(json_build_object(
                        'membershipId', x.id, 'name', x.name, 'role', x.role, 'senior', x.senior)
                      ORDER BY lower(x.name), x.id)
                 FROM (SELECT DISTINCT ON (fm.user_id) fm.id, ${userNameSql("fu")} AS name,
                              fm.owner_role AS role, fm.escalation_senior AS senior
                         FROM memberships fm JOIN users fu ON fu.id = fm.user_id
                        WHERE fm.org_id = e.org_id AND fm.status = 'active' AND fu.status = 'active'
                          AND (COALESCE(fm.owner_role, 'owner') IN ('owner', 'manager') OR fm.escalation_senior)
                          AND fm.user_id <> $2::uuid
                          AND fm.user_id IS DISTINCT FROM e.raised_by_user_id
                          AND fm.user_id IS DISTINCT FROM t.user_id
                          -- Not whoever has it now: passing it to them changes nothing.
                          AND fm.user_id IS DISTINCT FROM am.user_id
                        ORDER BY fm.user_id, (fm.scope_type = 'org') DESC, fm.id) x) AS forward_targets
         ${ESCALATION_FROM}
        WHERE e.id = $1::uuid AND ${escalationVisibleSql("e", "$2::uuid", viewer.admin)}`,
      [id, viewer.userId],
    );
    return row ? toDetail(row, viewer) : null;
  }

  /**
   * GET /owner/call-escalations - the page and the two counts in ONE statement.
   * `counts` LEFT JOIN `page`, so the counts come back even when the page is
   * empty (one row, page columns NULL).
   */
  async readList(
    client: Queryable,
    viewer: EscalationViewer,
    q: CallEscalationListQuery,
  ): Promise<{ items: CallEscalationListItem[]; counts: { live: number; assignedToMeLive: number } }> {
    const f = viewerFlagsSql("e", "$1::uuid");
    const status = q.status ?? "live";
    const statusSql = {
      live: `e.status IN (${LIVE_SQL})`,
      resolved: `e.status = 'resolved'`,
      withdrawn: `e.status = 'withdrawn'`,
      all: "true",
    }[status];
    const mineSql = q.mine === "raised" ? f.raisedByMe : q.mine === "assigned" ? f.assignedToMe : "true";
    const { rows } = await client.query<EscalationRow & { live_count: number; assigned_live_count: number; rn: number | null }>(
      `WITH visible AS (
         SELECT e.id, e.status, ${f.assignedToMe} AS mine
           FROM call_escalations e
          WHERE ${escalationVisibleSql("e", "$1::uuid", viewer.admin)}
       ),
       counts AS (
         SELECT count(*) FILTER (WHERE status IN (${LIVE_SQL}))::int AS live_count,
                count(*) FILTER (WHERE status IN (${LIVE_SQL}) AND mine)::int AS assigned_live_count
           FROM visible
       ),
       page AS (
         SELECT ${escalationColumns("$1::uuid")},
                row_number() OVER (ORDER BY (e.status IN (${LIVE_SQL})) DESC, e.created_at DESC, e.id) AS rn
           ${ESCALATION_FROM}
          WHERE e.id IN (SELECT id FROM visible) AND ${statusSql} AND ${mineSql}
          ORDER BY (e.status IN (${LIVE_SQL})) DESC, e.created_at DESC, e.id
          LIMIT $2
       )
       SELECT counts.live_count, counts.assigned_live_count, page.*
         FROM counts LEFT JOIN page ON true
        ORDER BY page.rn`,
      [viewer.userId, q.limit ?? 50],
    );
    const first = rows[0];
    return {
      items: rows.filter((r) => r.id != null).map((r) => toListItem(r, viewer)),
      counts: { live: first?.live_count ?? 0, assignedToMeLive: first?.assigned_live_count ?? 0 },
    };
  }

  /** One escalation as the phone sees it (the raise response). */
  async readDeviceView(client: Queryable, id: string): Promise<DeviceCallEscalationView | null> {
    const {
      rows: [row],
    } = await client.query<EscalationRow>(`SELECT ${escalationColumns("NULL::uuid")} ${ESCALATION_FROM} WHERE e.id = $1::uuid`, [id]);
    return row ? toDeviceView(row) : null;
  }

  /**
   * GET /devices/me/escalations: the bound telecaller's last 30 days, plus any
   * older one still live. Empty when the phone is inactive or bound to nobody.
   */
  async readDeviceList(client: Queryable, deviceId: string): Promise<DeviceCallEscalationView[]> {
    const { rows } = await client.query<EscalationRow>(
      `SELECT ${escalationColumns("NULL::uuid")}
         ${ESCALATION_FROM}
        WHERE e.telecaller_id = (
                SELECT dv.telecaller_id FROM devices dv
                  JOIN telecallers bt ON bt.id = dv.telecaller_id AND bt.status = 'active'
                 WHERE dv.id = $1::uuid AND dv.status = 'active' AND dv.removed_at IS NULL)
          AND (e.created_at > now() - make_interval(days => $2) OR e.status IN (${LIVE_SQL}))
        ORDER BY e.created_at DESC
        LIMIT 200`,
      [deviceId, DEVICE_ESCALATION_LOOKBACK_DAYS],
    );
    return rows.map(toDeviceView);
  }

  /** FCM tokens of the live, active handsets of these telecallers (or the whole bound fleet). */
  async configTokens(client: Queryable, target: { telecallerIds: string[] } | { all: true }): Promise<string[]> {
    if ("telecallerIds" in target && target.telecallerIds.length === 0) return [];
    const { rows } = await client.query<{ fcm_token: string }>(
      `SELECT DISTINCT fcm_token FROM devices
        WHERE removed_at IS NULL AND status = 'active' AND fcm_token IS NOT NULL
          AND ${"all" in target ? "telecaller_id IS NOT NULL" : "telecaller_id = ANY($1::uuid[])"}`,
      "all" in target ? [] : [target.telecallerIds],
    );
    return rows.map((r) => r.fcm_token);
  }

  /**
   * Best-effort `config_refresh`, so a phone shows or hides "Escalate" (and its
   * recipient's name) now rather than on its next poll. Never throws; call it
   * AFTER the write committed, so the phone's refetch sees it.
   */
  pushConfigRefresh(tokens: string[]): void {
    this.push(tokens, "config_refresh");
  }

  /**
   * Wake the phones an alert was just written for. The push carries no content
   * - the phone fetches the text over GET /devices/me/alerts. Call AFTER commit;
   * a push that fails here is retried by the worker's sweep.
   */
  pushAlerts(tokens: string[]): void {
    this.push(tokens, "alert");
  }

  /**
   * The console's queue re-reads. The owner routes announce themselves through
   * their path (`call-escalation`); a raise from the phone arrives on the
   * SILENT `devices/me` prefix, so that handler calls this.
   */
  announce(orgId: string, id?: string | null): void {
    this.realtime.publish({ orgId, topic: "call-escalation", action: "created", id: id ?? null, at: new Date().toISOString() });
  }

  private push(tokens: string[], action: "alert" | "config_refresh"): void {
    const unique = [...new Set(tokens)];
    if (unique.length === 0) return;
    void Promise.allSettled(unique.map((t) => this.fcm.sendToDevice(t, { action }))).then((results) => {
      const failed = results.filter((r) => r.status === "rejected" || r.value === false).length;
      if (failed > 0) this.logger.debug(`${action}: ${failed}/${unique.length} pushes not accepted`);
    });
  }
}
