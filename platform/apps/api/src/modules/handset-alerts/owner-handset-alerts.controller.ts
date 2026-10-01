import { randomUUID } from "node:crypto";
import { BadRequestException, Body, Controller, Get, Logger, Post, Req, UseGuards } from "@nestjs/common";
import {
  deviceUnderstandsAlertsSql,
  HANDSET_ALERT_TTL_MINUTES,
  type HandsetAlertDelivery,
  handsetAlertDelivery,
  nextPushDelaySeconds,
  SendHandsetMessageInput,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { FcmService } from "../../fcm/fcm.service";

/** How many past sends the Phones page lists. */
const RECENT_SENDS = 20;

export interface HandsetRecipient {
  telecallerId: string;
  name: string;
  /** An active paired phone: something can collect the message. */
  hasPhone: boolean;
  /** That phone registered a push token: it can be woken, not just polled. */
  pushable: boolean;
  /**
   * Every phone they have is KNOWN to run an app older than the first build
   * with alerts (HANDSET_ALERTS_MIN_VERSION_CODE): nothing will show until it
   * updates. False when the version is unknown - see the constant.
   */
  needsUpdate: boolean;
}

export interface SentHandsetMessage {
  batchId: string;
  title: string;
  body: string | null;
  popup: boolean;
  sentAt: string;
  sentBy: string | null;
  recipients: Array<{
    telecallerId: string;
    name: string;
    delivery: HandsetAlertDelivery;
    deliveredAt: string | null;
    openedAt: string | null;
  }>;
}

interface SentRow {
  batch_id: string;
  title: string;
  body: string | null;
  style: string;
  created_at: Date;
  expires_at: Date;
  delivered_at: Date | null;
  opened_at: Date | null;
  telecaller_id: string;
  telecaller_name: string;
  sent_by: string | null;
  has_phone: boolean;
}

/** Rows (one per recipient, newest send first) to sends with their receipts. */
export function groupSent(rows: SentRow[], now: number = Date.now()): SentHandsetMessage[] {
  const out = new Map<string, SentHandsetMessage>();
  for (const r of rows) {
    let m = out.get(r.batch_id);
    if (!m) {
      m = {
        batchId: r.batch_id,
        title: r.title,
        body: r.body,
        popup: r.style === "popup",
        sentAt: r.created_at.toISOString(),
        sentBy: r.sent_by,
        recipients: [],
      };
      out.set(r.batch_id, m);
    }
    m.recipients.push({
      telecallerId: r.telecaller_id,
      name: r.telecaller_name,
      delivery: handsetAlertDelivery(
        {
          deliveredAt: r.delivered_at?.toISOString() ?? null,
          openedAt: r.opened_at?.toISOString() ?? null,
          expiresAt: r.expires_at.toISOString(),
          hasPhone: r.has_phone,
        },
        now,
      ),
      deliveredAt: r.delivered_at?.toISOString() ?? null,
      openedAt: r.opened_at?.toISOString() ?? null,
    });
  }
  return [...out.values()];
}

const ACTIVE_PHONE = (t: string) => `EXISTS (
  SELECT 1 FROM devices d
   WHERE d.telecaller_id = ${t} AND d.status = 'active' AND d.removed_at IS NULL)`;

/**
 * "Message phones" on the Phones page (migration 0150): an owner or manager
 * puts a message on one, several or every telecaller's handset, as a
 * full-screen popup or a heads-up notification, and sees who has read it.
 *
 * ── OWNER AND MANAGER ONLY ─────────────────────────────────────────────────
 *
 * The same pair that may reassign leads. A popup takes over somebody's screen;
 * letting a telecaller do that to colleagues would make it a toy.
 *
 * ── WHAT IT REACHES ────────────────────────────────────────────────────────
 *
 * The business's own phones, and nothing else: every recipient is an active
 * telecaller of this org, and the push carries no text (the phone fetches it
 * over GET /devices/me/alerts). No customer ever sees one of these.
 *
 * The push is sent here as well as by the worker so a message lands in
 * seconds rather than on the next sweep. The row is stamped as one push in,
 * so the worker's first retry is a minute later, not a duplicate now.
 */
@Controller("owner/handset-alerts")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class OwnerHandsetAlertsController {
  private readonly logger = new Logger(OwnerHandsetAlertsController.name);

  constructor(
    private readonly db: DbService,
    private readonly fcm: FcmService,
  ) {}

  @Get()
  async overview(@OrgId() orgId: string): Promise<{ recipients: HandsetRecipient[]; sent: SentHandsetMessage[] }> {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: recipients } = await client.query<{
        id: string;
        display_name: string;
        has_phone: boolean;
        pushable: boolean;
        up_to_date: boolean;
      }>(
        `SELECT t.id, t.display_name,
                ${ACTIVE_PHONE("t.id")} AS has_phone,
                EXISTS (SELECT 1 FROM devices d
                         WHERE d.telecaller_id = t.id AND d.status = 'active'
                           AND d.removed_at IS NULL AND d.fcm_token IS NOT NULL
                           AND ${deviceUnderstandsAlertsSql("d")}) AS pushable,
                EXISTS (SELECT 1 FROM devices d
                         WHERE d.telecaller_id = t.id AND d.status = 'active'
                           AND d.removed_at IS NULL
                           AND ${deviceUnderstandsAlertsSql("d")}) AS up_to_date
           FROM telecallers t
          WHERE t.org_id = $1 AND t.status = 'active'
          ORDER BY lower(t.display_name)`,
        [orgId],
      );
      const { rows: sent } = await client.query<SentRow>(
        `WITH b AS (
           SELECT batch_id, min(created_at) AS sent_at
             FROM handset_alerts
            WHERE org_id = $1 AND kind = 'manager_message'
            GROUP BY batch_id
            ORDER BY sent_at DESC
            LIMIT ${RECENT_SENDS}
         )
         SELECT a.batch_id, a.title, a.body, a.style, a.created_at, a.expires_at,
                a.delivered_at, a.opened_at, a.telecaller_id,
                t.display_name AS telecaller_name,
                COALESCE(NULLIF(u.name, ''), u.email) AS sent_by,
                ${ACTIVE_PHONE("a.telecaller_id")} AS has_phone
           FROM handset_alerts a
           JOIN b ON b.batch_id = a.batch_id
           JOIN telecallers t ON t.id = a.telecaller_id
           LEFT JOIN users u ON u.id = a.sent_by
          WHERE a.org_id = $1
          ORDER BY b.sent_at DESC, lower(t.display_name)`,
        [orgId],
      );
      return {
        recipients: recipients.map((r) => ({
          telecallerId: r.id,
          name: r.display_name,
          hasPhone: r.has_phone,
          pushable: r.pushable,
          needsUpdate: r.has_phone && !r.up_to_date,
        })),
        sent: groupSent(sent),
      };
    });
  }

  @Post()
  async send(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = SendHandsetMessageInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);
    const sentBy = actor.type === "user" ? actor.id : null;
    const batchId = randomUUID();

    const { recipients, tokens } = await this.db.withOrg(orgId, async (client) => {
      // Everyone = everyone who has a phone: a message to someone with no
      // handset can only ever read "no phone". Named people are taken as
      // named - the console says plainly when one of them has no phone.
      const { rows: targets } = await client.query<{ id: string }>(
        input.everyone
          ? `SELECT t.id FROM telecallers t
              WHERE t.org_id = $1 AND t.status = 'active' AND ${ACTIVE_PHONE("t.id")}`
          : `SELECT t.id FROM telecallers t
              WHERE t.org_id = $1 AND t.status = 'active' AND t.id = ANY($2::uuid[])`,
        input.everyone ? [orgId] : [orgId, input.telecallerIds],
      );
      if (!input.everyone && targets.length !== new Set(input.telecallerIds).size) {
        throw new BadRequestException("One of those telecallers is not in this workspace, or is archived.");
      }
      if (targets.length === 0) {
        throw new BadRequestException("Nobody in this workspace has a paired phone yet.");
      }
      const ids = targets.map((t) => t.id);

      const { rows: sender } = await client.query<{ name: string | null }>(
        `SELECT COALESCE(NULLIF(name, ''), email) AS name FROM users WHERE id = $1`,
        [sentBy],
      );
      const title = input.title || (sender[0]?.name ? `Message from ${sender[0].name}` : "Message from your manager");

      await client.query(
        `INSERT INTO handset_alerts
           (org_id, telecaller_id, kind, style, title, body, sent_by, batch_id,
            expires_at, push_attempts, last_push_at, next_push_at)
         SELECT $1, t, 'manager_message', $3, $4, $5, $6, $7,
                now() + make_interval(mins => $8), 1, now(), now() + make_interval(secs => $9)
           FROM unnest($2::uuid[]) AS t`,
        [
          orgId,
          ids,
          input.popup ? "popup" : "notify",
          title.slice(0, 120),
          input.body,
          sentBy,
          batchId,
          HANDSET_ALERT_TTL_MINUTES.manager_message,
          nextPushDelaySeconds(1),
        ],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'handset_message.sent', 'handset_message', $4, $5)`,
        [orgId, actor.type, actor.id, batchId, JSON.stringify({ recipients: ids.length, popup: input.popup })],
      );
      const { rows: devices } = await client.query<{ fcm_token: string }>(
        `SELECT DISTINCT d.fcm_token FROM devices d
          WHERE d.org_id = $1 AND d.telecaller_id = ANY($2::uuid[])
            AND d.status = 'active' AND d.removed_at IS NULL AND d.fcm_token IS NOT NULL
            AND ${deviceUnderstandsAlertsSql("d")}`,
        [orgId, ids],
      );
      return { recipients: ids.length, tokens: devices.map((d) => d.fcm_token) };
    });

    // After the commit, so a phone woken by this push finds the row. A push
    // that fails here is retried by the worker a minute from now.
    const results = await Promise.allSettled(tokens.map((t) => this.fcm.sendToDevice(t, { action: "alert" })));
    const woken = results.filter((r) => r.status === "fulfilled" && r.value).length;
    if (woken < tokens.length) this.logger.debug(`handset message ${batchId}: ${woken}/${tokens.length} pushes accepted`);

    return { batchId, recipients, phonesWoken: woken };
  }
}
