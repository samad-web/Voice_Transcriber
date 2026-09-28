import { Injectable, Logger } from "@nestjs/common";
import { describeRequest, resolveOwnerRole, type RequestKind } from "@aura/shared";
import { FcmService } from "../../fcm/fcm.service";
import { notify } from "../notifications/notify";
import { RealtimeService } from "../realtime/realtime.service";
import type { Queryable } from "./attendance-schedule";

export interface Actor {
  membershipId: string | null;
  ownerRole: string | null;
  telecallerIds: string[];
  userId: string | null;
}

export interface NewRequestForRouting {
  id: string;
  telecallerName: string;
  kind: RequestKind;
  leaveType?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  halfDay?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  approverMembershipId: string | null;
}

/**
 * The side effects every attendance write shares (doc 33, 0140): waking the
 * affected phones, telling the Today board, marking days for the classifier,
 * and routing a new request to whoever decides it.
 *
 * Nothing here sends WhatsApp. A request with the workspace toggle on gets
 * OUTBOX ROWS, which the worker drains (apps/worker/src/pipeline/
 * attendance-whatsapp.ts) - and re-checks the toggle at send time.
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly fcm: FcmService,
    private readonly realtime: RealtimeService,
  ) {}

  /** FCM tokens of the live, active handsets of these telecallers (or the whole bound fleet). */
  async deviceTokens(client: Queryable, target: { telecallerIds: string[] } | { all: true }): Promise<string[]> {
    if ("telecallerIds" in target && target.telecallerIds.length === 0) return [];
    const { rows } = await client.query<{ fcm_token: string }>(
      `SELECT fcm_token FROM devices
        WHERE removed_at IS NULL AND status = 'active' AND fcm_token IS NOT NULL
          AND ${"all" in target ? "telecaller_id IS NOT NULL" : "telecaller_id = ANY($1::uuid[])"}`,
      "all" in target ? [] : [target.telecallerIds],
    );
    return rows.map((r) => r.fcm_token);
  }

  /**
   * Best-effort `config_refresh` - never throws, never blocks the response on
   * FCM. Called AFTER the write committed, so the phone's refetch sees it.
   */
  pushConfigRefresh(tokens: string[]): void {
    if (tokens.length === 0) return;
    void Promise.allSettled(tokens.map((t) => this.fcm.sendToDevice(t, { action: "config_refresh" }))).then(
      (results) => {
        const failed = results.filter((r) => r.status === "rejected" || r.value === false).length;
        if (failed > 0) this.logger.debug(`config_refresh: ${failed}/${tokens.length} not delivered`);
      },
    );
  }

  /** The Today board re-reads. Explicit because `devices/me` is a SILENT prefix. */
  announce(orgId: string, id?: string | null): void {
    this.realtime.publish({ orgId, topic: "attendance", action: "updated", id: id ?? null, at: new Date().toISOString() });
  }

  /** Ask the worker's classifier to rebuild these (telecaller, date) days. */
  async markDirty(client: Queryable, orgId: string, days: { telecallerId: string; date: string }[]): Promise<void> {
    if (days.length === 0) return;
    await client.query(
      `INSERT INTO attendance_dirty_days (org_id, telecaller_id, work_date)
       SELECT $1, x.telecaller_id, x.work_date
         FROM jsonb_to_recordset($2::jsonb) AS x(telecaller_id uuid, work_date date)
       ON CONFLICT (telecaller_id, work_date) DO UPDATE SET marked_at = now()`,
      [orgId, JSON.stringify(days.map((d) => ({ telecaller_id: d.telecallerId, work_date: d.date })))],
    );
  }

  /** A workspace holiday touches everybody on that date. */
  async markDirtyEveryone(client: Queryable, orgId: string, dates: string[]): Promise<void> {
    if (dates.length === 0) return;
    await client.query(
      `INSERT INTO attendance_dirty_days (org_id, telecaller_id, work_date)
       SELECT $1, t.id, d.d
         FROM telecallers t CROSS JOIN unnest($2::date[]) AS d(d)
        WHERE t.status = 'active'
       ON CONFLICT (telecaller_id, work_date) DO UPDATE SET marked_at = now()`,
      [orgId, dates],
    );
  }

  /**
   * Every active owner of the workspace, one membership per person (the
   * org-scope row first). `owner_role IS NULL` counts as owner, matching
   * resolveOwnerRole: those are memberships that predate personas.
   */
  async activeOwners(client: Queryable, orgId: string): Promise<{ membershipId: string; userId: string }[]> {
    const { rows } = await client.query<{ membership_id: string; user_id: string }>(
      `SELECT DISTINCT ON (m.user_id) m.id AS membership_id, m.user_id
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND COALESCE(m.owner_role, 'owner') = 'owner'
          AND m.status = 'active' AND u.status = 'active'
        ORDER BY m.user_id, (m.scope_type = 'org') DESC, m.id`,
      [orgId],
    );
    return rows.map((r) => ({ membershipId: r.membership_id, userId: r.user_id }));
  }

  /** The caller as `canDecideRequest` needs them. */
  async actorFor(client: Queryable, orgId: string, userId: string | null): Promise<Actor> {
    if (!userId) return { membershipId: null, ownerRole: null, telecallerIds: [], userId: null };
    const {
      rows: [row],
    } = await client.query<{ membership_id: string | null; owner_role: string | null; telecaller_ids: string[] | null }>(
      `SELECT (SELECT m.id FROM memberships m WHERE m.org_id = $1 AND m.user_id = $2
                ORDER BY (m.scope_type = 'org') DESC, m.id LIMIT 1) AS membership_id,
              (SELECT m.owner_role FROM memberships m WHERE m.org_id = $1 AND m.user_id = $2
                ORDER BY (m.scope_type = 'org') DESC, m.id LIMIT 1) AS owner_role,
              (SELECT array_agg(t.id) FROM telecallers t WHERE t.org_id = $1 AND t.user_id = $2) AS telecaller_ids`,
      [orgId, userId],
    );
    return {
      membershipId: row?.membership_id ?? null,
      ownerRole: row?.membership_id ? resolveOwnerRole(row.owner_role) : null,
      telecallerIds: row?.telecaller_ids ?? [],
      userId,
    };
  }

  /**
   * Tell whoever decides a new PENDING request (doc 33 §6.3): the approver's
   * user, or every active owner. The console notification is written first and
   * never depends on WhatsApp. With the workspace toggle on, one outbox row per
   * recipient membership is queued as well - unique, so a replay queues nothing.
   *
   * The telecaller's reason is deliberately in neither: a sick-leave reason is
   * a health detail, shown only on the Requests tab.
   */
  async routeNewRequest(
    client: Queryable,
    orgId: string,
    request: NewRequestForRouting,
    zone: string,
    whatsappOn: boolean,
  ): Promise<number> {
    let recipients: { membershipId: string; userId: string }[] = [];
    if (request.approverMembershipId) {
      const { rows } = await client.query<{ membership_id: string; user_id: string }>(
        `SELECT m.id AS membership_id, m.user_id
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.id = $1 AND m.status = 'active' AND u.status = 'active'`,
        [request.approverMembershipId],
      );
      recipients = rows.map((r) => ({ membershipId: r.membership_id, userId: r.user_id }));
    }
    if (recipients.length === 0) recipients = await this.activeOwners(client, orgId);

    const what = describeRequest({ ...request, zone } as Parameters<typeof describeRequest>[0]);
    const title =
      request.kind === "leave"
        ? `Leave request from ${request.telecallerName}`
        : request.kind === "break"
          ? `Break request from ${request.telecallerName}`
          : `Hours change request from ${request.telecallerName}`;
    let written = 0;
    for (const r of recipients) {
      const ok = await notify(client as never, orgId, {
        userId: r.userId,
        kind: "attendance_request",
        title: title.slice(0, 200),
        body: `${what}. Waiting for your decision.`,
        linkPath: "/owner/attendance?tab=requests",
        dedupeKey: `attendance_request:${request.id}`,
      });
      if (ok) written += 1;
    }

    if (whatsappOn && recipients.length > 0) {
      await client.query(
        `INSERT INTO attendance_whatsapp_outbox (org_id, request_id, recipient_membership_id, reason)
         SELECT $1, $2, unnest($3::uuid[]), 'new_request'
         ON CONFLICT (request_id, recipient_membership_id, reason) DO NOTHING`,
        [orgId, request.id, recipients.map((r) => r.membershipId)],
      );
    }
    return written;
  }
}
