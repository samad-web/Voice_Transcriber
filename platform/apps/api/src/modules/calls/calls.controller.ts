import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { SkipThrottle } from "@nestjs/throttler";
import { z } from "zod";
import { CreateCallRequest } from "@aura/shared";
import { publishPipeline } from "@aura/queue";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { PermissionsGuard, RequirePermission } from "../../common/permissions.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { DeviceAuthGuard, type DeviceRequest } from "../../common/device-auth.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { S3Service } from "../../s3/s3.service";

const CompleteCallBody = z.object({
  uploadId: z.string().min(1),
  parts: z.array(z.object({ n: z.number().int().min(1), etag: z.string().min(1) })).min(1),
  sha256: z.string().length(64),
});

/**
 * Filters for the Call Explorer. All optional — bare GET keeps the old
 * behaviour. `status` takes either an exact pipeline state or one of two
 * buckets: `in_pipeline` (still moving) and `failed` (any FAILED_* stage).
 * The buckets matter because "in pipeline" spans five states — matching one
 * of them exactly would hide the rest and read as "no stuck calls".
 */
/**
 * Bulk rewind. Only terminal states are accepted — an in-flight call must never
 * be rewound out from under the worker, and allowing arbitrary statuses here
 * would make that a one-typo mistake.
 */
const ReprocessBacklogBody = z.object({
  statuses: z
    .array(
      z.enum([
        "TRANSCRIPTION_OFF",
        "COMPLETE",
        "FAILED_TRANSCODE",
        "FAILED_ASR",
        "FAILED_ANALYZE",
        "FAILED_CRM",
      ]),
    )
    .min(1),
  /** How far back to reach. Omitted or null means the whole history — which for
   *  a dormant instance can be a lot of paid audio, so the console always asks. */
  sinceDays: z.number().int().min(1).max(3650).nullable().optional(),
  /** Backstop against a single click sweeping thousands of calls into the queue. */
  limit: z.number().int().min(1).max(1000).default(500),
});

/**
 * How often we have dealt with the person on the other end, and where this call
 * sits in that history.
 *
 * A LATERAL rather than stored columns: retention and erasure sweeps delete
 * calls, so a counter written at ingest would silently drift away from what the
 * table actually holds. The (workspace_id, remote_number_hash) index from 0001
 * makes recomputing it cheap, and the answer is always true of the data now.
 *
 * A call whose number was withheld has a NULL hash and gets no history at all —
 * every such call would otherwise look like the same mystery customer ringing
 * back, which is worse than admitting we do not know.
 */
const CONTACT_HISTORY_JOIN = `
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE x.direction = 'incoming')::int AS calls_in,
           count(*) FILTER (WHERE x.direction = 'outgoing')::int AS calls_out,
           count(*) FILTER (WHERE (x.started_at, x.id) <= (c.started_at, c.id))::int AS sequence
      FROM calls x
     WHERE x.workspace_id = c.workspace_id
       AND x.remote_number_hash = c.remote_number_hash
  ) h ON c.remote_number_hash IS NOT NULL`;

const ListCallsQuery = z.object({
  instanceId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  status: z.string().min(1).max(64).optional(),
  direction: z.enum(["incoming", "outgoing"]).optional(),
  /** "true" = repeat contacts only (the follow-up list), "false" = first-time only. */
  followUp: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
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
  // Not throttled (checklist 08 §0.7). This is the ingest path: a handset that
  // is refused here does not retry politely, it accumulates a backlog or drops
  // the recording. A tenant's fleet shares one office/NAT source IP and a phone
  // that has been offline flushes its queue in a burst, which is exactly the
  // shape a per-IP limit punishes. Already gated by a signed device token, and
  // capacity is bounded by the tenant/device admission checks below.
  @SkipThrottle()
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
                o.status AS org_status, o.consent_policy, o.store_full_number
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
      // for the call label, the last 3, and a hash for matching.
      const digits = (call.remoteNumber ?? "").replace(/\D/g, "");
      const numberPrefix = digits ? digits.slice(0, 5) : null;
      const numberLast3 = digits.length >= 3 ? digits.slice(-3) : null;
      const numberHash = digits ? createHash("sha256").update(digits).digest("hex") : null;
      const remoteName = call.remoteName?.trim() || null;
      // The full number is retained ONLY for an org that opted in (0011), which
      // is what makes a CRM lead callable. Everyone else keeps the fragments
      // above and nothing more — the column stays NULL.
      const numberFull = ctx.store_full_number && digits ? digits : null;

      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO calls
           (org_id, workspace_id, device_id, direction, started_at, duration_s,
            audio_source_used, status, consent_status,
            remote_number_prefix, remote_number_last3, remote_number_hash, remote_name,
            remote_number_full)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'AWAITING_AUDIO', $8, $9, $10, $11, $12, $13)
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
          numberFull,
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
  // Not throttled — the second half of ingest. Losing this call after the bytes
  // are already in S3 strands the recording in AWAITING_AUDIO with no sweeper
  // that recovers it, so it is the worst possible request to rate-limit.
  @SkipThrottle()
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

  /**
   * Listing for the web Call Explorer.
   *
   * Every row carries the instance it belongs to. Without that the console
   * could show a flat pile of calls but never answer "what did THIS customer
   * record", which is the question the Instances page exists to ask — so the
   * instance join is part of the contract, not an optimisation.
   */
  @Get()
  @UseGuards(AdminKeyGuard, TenantGuard)
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListCallsQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { instanceId, deviceId, status, direction, followUp, limit, offset } = parsed.data;

    // Identical predicate for the page and the count, so "showing 100 of 3,412"
    // can never disagree with the rows underneath it.
    const where = `WHERE ($1::uuid IS NULL OR i.id = $1::uuid)
            AND ($2::uuid IS NULL OR d.id = $2::uuid)
            AND ($3::text IS NULL OR
                 CASE $3::text
                   -- TRANSCRIPTION_OFF is terminal by choice, so it belongs in
                   -- neither bucket: counting it as in-flight would show work
                   -- that is never coming.
                   WHEN 'in_pipeline' THEN c.status NOT IN ('COMPLETE', 'TRANSCRIPTION_OFF')
                                       AND c.status NOT LIKE 'FAILED%'
                   WHEN 'failed'      THEN c.status LIKE 'FAILED%'
                   ELSE c.status = $3::text
                 END)
            AND ($4::text IS NULL OR c.direction = $4::text)
            -- The follow-up list. COALESCE so a call with a withheld number
            -- counts as a first contact rather than falling out of BOTH sides
            -- of the filter and becoming invisible either way it is set.
            AND ($5::text IS NULL OR
                 ($5::text = 'true') = (COALESCE(h.sequence, 1) > 1))`;
    const filters = [
      instanceId ?? null,
      deviceId ?? null,
      status ?? null,
      direction ?? null,
      followUp ?? null,
    ];

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.direction, c.started_at, c.duration_s, c.audio_source_used,
                c.status, c.consent_status, c.error_message,
                c.pipeline_attempts, c.next_attempt_at,
                c.device_id, d.label AS device_label,
                i.id AS instance_id, i.name AS instance_name,
                c.remote_number_prefix, c.remote_number_last3, c.remote_name,
                h.calls_in, h.calls_out, h.sequence,
                h.sequence > 1 AS is_follow_up
           FROM calls c
           JOIN devices d   ON d.id = c.device_id
           JOIN instances i ON i.id = d.instance_id
           ${CONTACT_HISTORY_JOIN}
          ${where}
          ORDER BY c.started_at DESC
          LIMIT $6 OFFSET $7`,
        [...filters, limit, offset],
      );
      const {
        rows: [count],
      } = await client.query(
        // The join is not optional here even though the count selects nothing
        // from it: `where` is shared with the page query above and references
        // h.sequence for the follow-up filter.
        `SELECT count(*)::int AS total
           FROM calls c
           JOIN devices d   ON d.id = c.device_id
           JOIN instances i ON i.id = d.instance_id
           ${CONTACT_HISTORY_JOIN}
          ${where}`,
        filters,
      );
      return { calls: rows, total: count?.total ?? 0, limit, offset };
    });
  }

  /** Detail: call + transcript + AI output for the drawer. */
  @Get(":id")
  @UseGuards(AdminKeyGuard, TenantGuard)
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [call],
      } = await client.query(
        `SELECT c.*, h.calls_in, h.calls_out, h.sequence,
                h.sequence > 1 AS is_follow_up
           FROM calls c
           ${CONTACT_HISTORY_JOIN}
          WHERE c.id = $1`,
        [callId],
      );
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
  @UseGuards(AdminKeyGuard, TenantGuard, PermissionsGuard)
  @RequirePermission("recordings:listen")
  async audio(
    @Req() req: PrincipalRequest,
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
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
  @UseGuards(AdminKeyGuard, TenantGuard)
  async reprocess(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) callId: string,
  ) {
    const result = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [call],
      } = await client.query(`SELECT status FROM calls WHERE id = $1`, [callId]);
      if (!call) throw new NotFoundException("call not found");
      // TRANSCRIPTION_OFF is reprocessable on purpose: turning transcription
      // back on and pressing Reprocess is how a customer's backlog gets picked
      // up, so it must be rewindable like any other terminal state.
      const terminal =
        call.status === "COMPLETE" ||
        call.status === "TRANSCRIPTION_OFF" ||
        String(call.status).startsWith("FAILED_");
      if (!terminal) {
        throw new ConflictException(
          `call is ${call.status}; only COMPLETE, TRANSCRIPTION_OFF or FAILED_* calls can be reprocessed`,
        );
      }

      // A person deciding to retry resets the automatic budget: they may well
      // have fixed the cause, and inheriting the attempt count from the old
      // problem would let one more failure permanently retire the call.
      await client.query(
        `UPDATE calls
            SET status = 'UPLOADED', pipeline_attempts = 0, next_attempt_at = NULL
          WHERE id = $1
            AND (status IN ('COMPLETE', 'TRANSCRIPTION_OFF') OR status LIKE 'FAILED_%')`,
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

  /**
   * Rewind a whole backlog in one request.
   *
   * Exists because the single-call endpoint is the wrong shape for the two jobs
   * operators actually have: "transcription was off for a week, now catch up"
   * and "a provider outage failed 40 calls, run them again". Doing that from the
   * console meant one HTTP round trip per call, which is slow, half-finishes
   * when the tab closes, and gives no total to sanity-check first.
   *
   * `sinceDays` is the guard rail. Switching transcription back on for a
   * long-dormant instance can otherwise sweep up months of stored audio and
   * spend real money on it — so the console asks how far back to go and the
   * answer lands here, rather than "all" being the only thing the API can do.
   *
   * Claiming is the same optimistic UPDATE as the single-call path, so a call
   * already in flight is never disturbed and two operators pressing this at once
   * cannot enqueue the same call twice.
   */
  @Post("reprocess-backlog")
  @UseGuards(AdminKeyGuard, TenantGuard)
  async reprocessBacklog(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = ReprocessBacklogBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { statuses, sinceDays, limit } = parsed.data;

    const claimed = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE calls
            SET status = 'UPLOADED', pipeline_attempts = 0, next_attempt_at = NULL
          WHERE id IN (
            SELECT id FROM calls
             WHERE org_id = $1
               AND status = ANY($2::text[])
               AND ($3::int IS NULL OR started_at >= now() - make_interval(days => $3))
             ORDER BY started_at DESC
             LIMIT $4
          )
        RETURNING id`,
        [orgId, statuses, sinceDays ?? null, limit],
      );
      if (rows.length > 0) {
        // orgId is bound TWICE, as $1 and $2, and that is not redundancy.
        // org_id is uuid and target_id is text; reusing one placeholder for both
        // makes Postgres deduce two types for the same parameter and abort the
        // statement with "inconsistent types deduced for parameter $1" — which
        // rolled the whole transaction back, so the rewind above never committed
        // and the endpoint answered 500. Same two-binding shape as the other
        // org-targeted audit row (tenancy.controller.ts:125).
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'user', 'dev-admin', 'call.reprocess_backlog', 'organization', $2, $3::jsonb)`,
          [orgId, orgId, JSON.stringify({ statuses, sinceDays, count: rows.length })],
        );
      }
      return rows.map((r) => r.id);
    });

    // Published after the claim commits, so a call is never enqueued without
    // having been rewound. A publish that throws leaves the call in UPLOADED for
    // the stuck-upload sweep to re-wake rather than losing it.
    for (const callId of claimed) await publishPipeline({ callId, orgId });
    return { requeued: claimed.length, statuses, sinceDays: sinceDays ?? null };
  }
}
