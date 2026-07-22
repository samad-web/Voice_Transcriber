import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { DeviceAuthGuard, type DeviceRequest } from "../../common/device-auth.guard";
import { DbService } from "../../db/db.service";

const HealthBody = z.object({
  batteryLevel: z.number(),
  accessibilityEnabled: z.boolean(),
  batteryOptExempt: z.boolean(),
  pendingUploads: z.number().int(),
  freeStorageMb: z.number(),
  lastUploadAt: z.string().datetime().optional(),
});

const EventsBody = z.object({
  events: z.array(z.unknown()),
});

/**
 * Fleet telemetry from the Android client (design doc §3.4). Device-authed:
 * the org + device identity come from the access JWT, never the body.
 */
@Controller("devices/me")
@UseGuards(DeviceAuthGuard)
export class DeviceTelemetryController {
  constructor(private readonly db: DbService) {}

  /** Periodic health beacon — one row per report, plus a last-seen touch. */
  @Post("health")
  async health(@Req() req: DeviceRequest, @Body() body: unknown) {
    const parsed = HealthBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const h = parsed.data;
    const { deviceId, orgId } = req.device;

    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `INSERT INTO device_health
           (org_id, device_id, ts, battery_opt_exempt, accessibility_enabled,
            battery_level, pending_uploads, free_storage_mb, last_upload_at)
         VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8)`,
        [
          orgId,
          deviceId,
          h.batteryOptExempt,
          h.accessibilityEnabled,
          h.batteryLevel,
          h.pendingUploads,
          h.freeStorageMb,
          h.lastUploadAt ?? null,
        ],
      );
      await client.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [deviceId]);
      return { ok: true };
    });
  }

  /** Batched client-side events — audited as a single batch for now. */
  @Post("events")
  async events(@Req() req: DeviceRequest, @Body() body: unknown) {
    const parsed = EventsBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { deviceId, orgId } = req.device;
    const n = parsed.data.events.length;

    await this.db.withOrg(orgId, (client) =>
      client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'device', $2, 'device.events', 'device', $3, $4)`,
        [orgId, deviceId, deviceId, JSON.stringify({ count: n })],
      ),
    );
    return { accepted: n };
  }

  /**
   * Lets the phone read back the pipeline result for a call it uploaded, so the
   * app can show the transcript + AI extraction in its own recordings list.
   * Scoped to the calling device — a device can only see its own calls.
   */
  @Get("calls/:callId")
  async callResult(@Req() req: DeviceRequest, @Param("callId", ParseUUIDPipe) callId: string) {
    const { deviceId, orgId } = req.device;
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `SELECT c.status,
                t.text AS transcript,
                (SELECT output FROM ai_outputs WHERE call_id = c.id ORDER BY created_at DESC LIMIT 1) AS ai_output
           FROM calls c
           LEFT JOIN transcripts t ON t.call_id = c.id
          WHERE c.id = $1 AND c.device_id = $2`,
        [callId, deviceId],
      );
      if (!row) throw new NotFoundException("call not found for this device");
      return { status: row.status, transcript: row.transcript, aiOutput: row.ai_output };
    });
  }
}
