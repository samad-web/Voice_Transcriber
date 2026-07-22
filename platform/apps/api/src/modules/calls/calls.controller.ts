import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CreateCallRequest } from "@aura/shared";
import { publishPipeline } from "@aura/queue";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { PermissionsGuard, RequirePermission } from "../../common/permissions.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { DeviceAuthGuard, type DeviceRequest } from "../../common/device-auth.guard";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";
import { S3Service } from "../../s3/s3.service";

const CompleteCallBody = z.object({
  uploadId: z.string().min(1),
  parts: z.array(z.object({ n: z.number().int().min(1), etag: z.string().min(1) })).min(1),
  sha256: z.string().length(64),
});

@Controller("calls")
export class CallsController {
  constructor(
    private readonly db: DbService,
    private readonly s3: S3Service,
  ) {}

  /**
   * §6.1 upload admission: device status, org status, and consent policy are
   * checked BEFORE any bytes move; rejecting early saves battery + bandwidth.
   * TODO (checklist §2.2): honor the Idempotency-Key on retries.
   */
  @Post()
  @UseGuards(DeviceAuthGuard)
  async create(@Req() req: DeviceRequest, @Body() body: unknown) {
    const parsed = CreateCallRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const call = parsed.data;
    const { deviceId, orgId } = req.device;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [ctx],
      } = await client.query(
        `SELECT d.status AS device_status, i.workspace_id,
                o.status AS org_status, o.consent_policy
           FROM devices d
           JOIN instances i ON i.id = d.instance_id
           JOIN organizations o ON o.id = d.org_id
          WHERE d.id = $1`,
        [deviceId],
      );
      if (!ctx || ctx.device_status !== "active" || ctx.org_status !== "active") {
        throw new ConflictException("device or org is not active — recording is disabled");
      }
      if (ctx.consent_policy === "prohibited") {
        throw new ConflictException("tenant consent policy prohibits recording");
      }

      const consentStatus =
        ctx.consent_policy === "none"
          ? "not_required"
          : call.consentPlayed
            ? "played"
            : "failed";

      // Keep only privacy-lite fragments of the number: a 5-digit leading prefix
      // for the call label, the last 3, and a hash for matching. Never the full
      // number.
      const digits = (call.remoteNumber ?? "").replace(/\D/g, "");
      const numberPrefix = digits ? digits.slice(0, 5) : null;
      const numberLast3 = digits.length >= 3 ? digits.slice(-3) : null;
      const numberHash = digits ? createHash("sha256").update(digits).digest("hex") : null;
      const remoteName = call.remoteName?.trim() || null;

      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO calls
           (org_id, workspace_id, device_id, direction, started_at, duration_s,
            audio_source_used, status, consent_status,
            remote_number_prefix, remote_number_last3, remote_number_hash, remote_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'AWAITING_AUDIO', $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          orgId,
          ctx.workspace_id,
          deviceId,
          call.direction,
          call.startedAt,
          call.durationS,
          call.audioSourceUsed,
          consentStatus,
          numberPrefix,
          numberLast3,
          numberHash,
          remoteName,
        ],
      );

      const s3Key = `org/${orgId}/calls/${row.id}.m4a`;
      const upload = await this.s3.createMultipartUpload(s3Key, call.bytes);

      await client.query(
        `INSERT INTO recordings (org_id, call_id, s3_key, bytes, sha256, codec, sample_rate)
         VALUES ($1, $2, $3, $4, $5, 'aac', 16000)`,
        [orgId, row.id, s3Key, call.bytes, call.sha256],
      );

      return {
        callId: row.id,
        upload: { method: "multipart" as const, ...upload },
      };
    });
  }

  /** §6.1: verify the upload landed, flip to UPLOADED, wake the pipeline. */
  @Post(":id/complete")
  @UseGuards(DeviceAuthGuard)
  async complete(
    @Req() req: DeviceRequest,
    @Param("id", ParseUUIDPipe) callId: string,
    @Body() body: unknown,
  ) {
    const parsed = CompleteCallBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { uploadId, parts, sha256 } = parsed.data;
    const { orgId } = req.device;

    const result = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [rec],
      } = await client.query(
        `SELECT r.s3_key, r.bytes, r.sha256, c.status
           FROM recordings r JOIN calls c ON c.id = r.call_id
          WHERE r.call_id = $1`,
        [callId],
      );
      if (!rec) throw new NotFoundException("call not found");
      if (rec.status !== "AWAITING_AUDIO") {
        throw new ConflictException(`call is ${rec.status}, not awaiting audio`);
      }
      if (rec.sha256 !== sha256) {
        throw new BadRequestException("sha256 mismatch with call creation");
      }

      await this.s3.completeMultipartUpload(rec.s3_key, uploadId, parts);
      const head = await this.s3.headObject(rec.s3_key);
      if (head.bytes !== Number(rec.bytes)) {
        throw new BadRequestException(
          `size mismatch: S3 has ${head.bytes}, expected ${rec.bytes}`,
        );
      }

      await client.query(
        `UPDATE calls SET status = 'UPLOADED' WHERE id = $1 AND status = 'AWAITING_AUDIO'`,
        [callId],
      );
      await client.query(`UPDATE recordings SET uploaded_at = now() WHERE call_id = $1`, [
        callId,
      ]);
      return { callId, status: "UPLOADED" as const };
    });

    // The DB commit above is the source of truth; the queue is just a wake-up.
    await publishPipeline({ callId, orgId });
    return result;
  }

  /** Listing for the web Call Explorer. */
  @Get()
  @UseGuards(AdminKeyGuard)
  async list(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.direction, c.started_at, c.duration_s, c.audio_source_used,
                c.status, c.consent_status, d.label AS device_label,
                c.remote_number_prefix, c.remote_number_last3, c.remote_name
           FROM calls c JOIN devices d ON d.id = c.device_id
          ORDER BY c.started_at DESC
          LIMIT 100`,
      );
      return { calls: rows };
    });
  }

  /** Detail: call + transcript + AI output for the drawer. */
  @Get(":id")
  @UseGuards(AdminKeyGuard)
  async detail(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [call],
      } = await client.query(`SELECT * FROM calls WHERE id = $1`, [callId]);
      if (!call) throw new NotFoundException("call not found");
      const { rows: transcripts } = await client.query(
        `SELECT language, engine, text, segments, diarized, intelligence
           FROM transcripts WHERE call_id = $1`,
        [callId],
      );
      const { rows: outputs } = await client.query(
        `SELECT agent_id, agent_version, output, provider, model, validation_status
           FROM ai_outputs WHERE call_id = $1`,
        [callId],
      );
      const { rows: facts } = await client.query(
        `SELECT field_key, value_text, value_num, value_bool FROM call_facts WHERE call_id = $1`,
        [callId],
      );
      return {
        call,
        transcript: transcripts[0] ?? null,
        aiOutput: outputs[0] ?? null,
        facts,
      };
    });
  }

  /**
   * Presigned playback URL for the web player. Every access is audited
   * (`recording.playback`) — a compliance requirement, since listening to a
   * recording is itself a privacy event. 404 when no audio exists.
   */
  @Get(":id/audio")
  @UseGuards(AdminKeyGuard, PermissionsGuard)
  @RequirePermission("recordings:listen")
  async audio(
    @Req() req: PrincipalRequest,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
    const orgId = orgIdFromHeader(req.headers["x-org-id"]);
    const actorId = req.principal?.userId ?? "unknown";
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [rec],
      } = await client.query(`SELECT s3_key FROM recordings WHERE call_id = $1`, [callId]);
      if (!rec) throw new NotFoundException("no recording for this call");

      const url = await this.s3.presignedGetUrl(rec.s3_key, 300);

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'recording.playback', 'call', $3, $4)`,
        [orgId, actorId, callId, JSON.stringify({ s3Key: rec.s3_key })],
      );

      return { url };
    });
  }

  /**
   * Re-run the pipeline for a finished call — e.g. after an agent/model change.
   * Only terminal states (COMPLETE or FAILED_*) may be rewound to UPLOADED so
   * an in-flight call is never disturbed; the queue is just the wake-up.
   */
  @Post(":id/reprocess")
  @UseGuards(AdminKeyGuard)
  async reprocess(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
    const orgId = orgIdFromHeader(orgHeader);
    const result = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [call],
      } = await client.query(`SELECT status FROM calls WHERE id = $1`, [callId]);
      if (!call) throw new NotFoundException("call not found");
      if (call.status !== "COMPLETE" && !String(call.status).startsWith("FAILED_")) {
        throw new ConflictException(
          `call is ${call.status}; only COMPLETE or FAILED_* calls can be reprocessed`,
        );
      }

      await client.query(
        `UPDATE calls SET status = 'UPLOADED'
          WHERE id = $1 AND (status = 'COMPLETE' OR status LIKE 'FAILED_%')`,
        [callId],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', 'dev-admin', 'call.reprocess', 'call', $2, $3)`,
        [orgId, callId, JSON.stringify({ from: call.status })],
      );
      return { status: "UPLOADED" as const };
    });

    // Source of truth is the DB flip above; the queue is only a wake-up.
    await publishPipeline({ callId, orgId });
    return result;
  }
}
