import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { type DeviceHandsetAlert, HandsetAlertAckInput } from "@aura/shared";
import { DeviceAuthGuard, type DeviceRequest } from "../../common/device-auth.guard";
import { DbService } from "../../db/db.service";

/** How many alerts one fetch returns. A bulk reassign can raise hundreds; the phone groups them. */
const FETCH_LIMIT = 50;

interface AlertRow {
  id: string;
  kind: DeviceHandsetAlert["kind"];
  style: DeviceHandsetAlert["style"];
  title: string;
  body: string | null;
  created_at: Date;
  sent_by: string | null;
}

export function toDeviceAlert(row: AlertRow): DeviceHandsetAlert {
  return {
    id: row.id,
    kind: row.kind,
    style: row.style,
    title: row.title,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    sentBy: row.sent_by,
  };
}

/**
 * The handset's half of phone alerts (migration 0150).
 *
 * The phone calls GET when the `{action: "alert"}` push wakes it, and on its
 * hourly config poll as a catch-up for pushes that never arrived. It shows
 * what it got, then POSTs the ack - and only the ack makes an alert
 * "delivered", so the push ladder keeps ringing a phone that fetched and then
 * died before it could show anything.
 *
 * DeviceAuthGuard like every /devices/me route, and the telecaller is ALWAYS
 * the one the device is bound to at the moment of the request - joined from
 * `devices`, never taken from the body. A phone rebound to someone else stops
 * seeing the previous person's alerts on its next fetch.
 *
 * Not throttled, for the reason device-telemetry.controller.ts gives: a
 * tenant's phones share one NAT address.
 */
@Controller("devices/me")
@UseGuards(DeviceAuthGuard)
@SkipThrottle()
export class DeviceAlertsController {
  constructor(private readonly db: DbService) {}

  @Get("alerts")
  async list(@Req() req: DeviceRequest) {
    const { deviceId, orgId } = req.device;
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<AlertRow>(
        `SELECT a.id, a.kind, a.style, a.title, a.body, a.created_at,
                COALESCE(NULLIF(u.name, ''), u.email) AS sent_by
           FROM devices d
           JOIN handset_alerts a ON a.telecaller_id = d.telecaller_id AND a.org_id = d.org_id
           LEFT JOIN users u ON u.id = a.sent_by
          WHERE d.id = $1 AND d.org_id = $2
            AND d.status = 'active' AND d.removed_at IS NULL
            AND a.delivered_at IS NULL AND a.expires_at > now()
          ORDER BY a.created_at
          LIMIT ${FETCH_LIMIT}`,
        [deviceId, orgId],
      );
      return { alerts: rows.map(toDeviceAlert) };
    });
  }

  /**
   * Idempotent: acking twice keeps the first timestamps. An id that is not
   * this phone's - another telecaller's, another org's, or already deleted -
   * is silently not updated, so a phone retrying an old ack never errors.
   */
  @Post("alerts/ack")
  @HttpCode(200)
  async ack(@Req() req: DeviceRequest, @Body() body: unknown) {
    const parsed = HandsetAlertAckInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { delivered, opened } = parsed.data;
    if (delivered.length === 0 && opened.length === 0) return { acknowledged: 0 };
    const { deviceId, orgId } = req.device;

    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE handset_alerts a
            SET delivered_at        = COALESCE(a.delivered_at, now()),
                delivered_device_id = COALESCE(a.delivered_device_id, d.id),
                opened_at           = CASE WHEN a.id = ANY($4::uuid[])
                                           THEN COALESCE(a.opened_at, now())
                                           ELSE a.opened_at END
           FROM devices d
          WHERE d.id = $1 AND d.org_id = $2
            AND a.org_id = $2
            AND a.telecaller_id = d.telecaller_id
            AND a.id = ANY($3::uuid[] || $4::uuid[])`,
        [deviceId, orgId, delivered, opened],
      );
      return { acknowledged: rowCount ?? 0 };
    });
  }
}
