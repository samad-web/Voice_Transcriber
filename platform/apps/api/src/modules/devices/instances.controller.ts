import { createHash, randomBytes } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "ap-south-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "aura_minio",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "aura_minio_password",
  },
});

const BUCKET = process.env.S3_BUCKET ?? "aura-recordings";

const CreateInstanceBody = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  tokenTtlMinutes: z.number().int().min(5).max(1440).default(15),
  tokenMaxUses: z.number().int().min(1).max(500).default(1),
});

const MintKeyBody = z.object({
  tokenTtlMinutes: z.number().int().min(5).max(1440).default(15),
  tokenMaxUses: z.number().int().min(1).max(500).default(1),
});

/** Key metadata for the UI - the raw token is unrecoverable by design. */
const KEY_COLUMNS = `id, expires_at, max_uses, use_count, created_at,
         CASE WHEN use_count >= max_uses THEN 'exhausted'
              WHEN expires_at < now()    THEN 'expired'
              ELSE 'active' END AS status`;

/**
 * Instance = deployment target devices enroll against (design doc §2).
 * POST returns the one-time admin/enrollment key EXACTLY ONCE - only its
 * hash is stored. The web activation page renders it as copy-once + QR.
 */
@Controller("instances")
@UseGuards(AdminKeyGuard, TenantGuard)
export class InstancesController {
  constructor(private readonly db: DbService) {}

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateInstanceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { workspaceId, name, tokenTtlMinutes, tokenMaxUses } = parsed.data;

    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    return this.db.withOrg(orgId, async (client) => {
      // FK checks bypass RLS, so verify the workspace is visible in this org.
      const ws = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
      if (ws.rowCount === 0) throw new NotFoundException("workspace not found in this org");

      const {
        rows: [instance],
      } = await client.query(
        `INSERT INTO instances (org_id, workspace_id, name)
         VALUES ($1, $2, $3)
         RETURNING id, workspace_id, name, config_version, created_at`,
        [orgId, workspaceId, name],
      );

      const {
        rows: [token],
      } = await client.query(
        `INSERT INTO enrollment_tokens (org_id, instance_id, token_hash, expires_at, max_uses)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5)
         RETURNING expires_at, max_uses`,
        [orgId, instance.id, tokenHash, tokenTtlMinutes, tokenMaxUses],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'instance.create', 'instance', $3)`,
        [orgId, req.principal?.userId ?? "dev-admin", instance.id],
      );

      return {
        instance,
        enrollment: {
          instanceId: instance.id,
          // Shown once, never retrievable again - only the hash is stored.
          adminKey: rawToken,
          expiresAt: token.expires_at,
          maxUses: token.max_uses,
        },
      };
    });
  }

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        // device_count excludes removed handsets (0087) - the same LIVE filter
        // devices.controller uses, inlined here since this query has no `d`
        // alias to share that constant against.
        `SELECT i.id, i.workspace_id, i.name, i.config_version, i.created_at,
                (SELECT count(*)::int FROM devices d
                  WHERE d.instance_id = i.id AND d.removed_at IS NULL) AS device_count
         FROM instances i
         ORDER BY i.created_at DESC`,
      );
      return { instances: rows };
    });
  }

  /** Everything the instance detail page needs in one round trip. */
  @Get(":id")
  async detail(
    @OrgId() orgId: string,
    @Param("id") instanceId: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [instance],
      } = await client.query(
        `SELECT i.id, i.workspace_id, i.name, i.config_version, i.limits, i.created_at,
                w.name AS workspace_name
           FROM instances i
           JOIN workspaces w ON w.id = i.workspace_id
          WHERE i.id = $1`,
        [instanceId],
      );
      if (!instance) throw new NotFoundException("instance not found in this org");

      const { rows: keys } = await client.query(
        `SELECT ${KEY_COLUMNS} FROM enrollment_tokens
          WHERE instance_id = $1 ORDER BY created_at DESC`,
        [instanceId],
      );

      const { rows: devices } = await client.query(
        // `connected` mirrors devices.controller.ts's CONNECTED constant
        // (active + heard from inside 24h) verbatim - the two live in
        // different controllers with no shared query builder between them, so
        // this is a deliberate duplication kept in sync by that cross-reference
        // rather than a coincidence to "clean up" later.
        `SELECT d.id, d.label, d.fingerprint, d.status, d.capture_capability, d.last_seen_at,
                d.created_at, d.telecaller_name, d.telecaller_id, t.external_id AS telecaller_external_id,
                (d.status = 'active' AND d.last_seen_at > now() - interval '24 hours') AS connected
           FROM devices d
           LEFT JOIN telecallers t ON t.id = d.telecaller_id
          WHERE d.instance_id = $1 AND d.removed_at IS NULL
          ORDER BY d.created_at DESC`,
        [instanceId],
      );

      return { instance, keys, devices };
    });
  }

  /**
   * Decommission an instance. Devices and enrollment tokens cascade from the
   * instances row, but `calls.device_id` is deliberately NOT ON DELETE CASCADE,
   * so call history can never be destroyed as a side effect of removing a
   * deployment target.
   *
   * Two tiers, because that FK would otherwise surface as a raw 500:
   *  - default            → refuses with 409 + the blocking call count
   *  - `?purgeCalls=true` → erases those calls (and their S3 audio) first
   *
   * S3 objects go before any DB delete: losing the rows first would strand the
   * audio with no key left to find it by.
   */
  @Delete(":id")
  async remove(
    @OrgId() orgId: string,
    @Param("id") instanceId: string,
    @Query("purgeCalls") purgeCallsRaw: string | undefined,
    @Req() req: PrincipalRequest,
  ) {
    const purgeCalls = purgeCallsRaw === "true";

    // Read-only pass under RLS: resolve the instance, the blocking counts, and
    // (if purging) the S3 keys that need to go. Kept separate from the writes
    // below so the S3 delete loop - a network call per recording - never runs
    // while a pool connection is checked out inside a live transaction.
    const { instance, counts, s3Keys } = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [instanceRow],
      } = await client.query("SELECT id, name FROM instances WHERE id = $1", [instanceId]);
      if (!instanceRow) throw new NotFoundException("instance not found in this org");

      const {
        rows: [countsRow],
      } = await client.query(
        `SELECT (SELECT count(*)::int FROM devices WHERE instance_id = $1) AS devices,
                (SELECT count(*)::int
                   FROM calls c JOIN devices d ON d.id = c.device_id
                  WHERE d.instance_id = $1) AS calls`,
        [instanceId],
      );

      if (countsRow.calls > 0 && !purgeCalls) {
        throw new ConflictException({
          error: "instance_has_calls",
          message:
            `"${instanceRow.name}" still has ${countsRow.calls} call(s) across ` +
            `${countsRow.devices} device(s). Retry with purgeCalls=true to erase them.`,
          instanceId,
          devices: countsRow.devices,
          calls: countsRow.calls,
        });
      }

      let keys: string[] = [];
      if (countsRow.calls > 0) {
        const { rows: recs } = await client.query(
          `SELECT r.s3_key
             FROM recordings r
             JOIN calls c ON c.id = r.call_id
             JOIN devices d ON d.id = c.device_id
            WHERE d.instance_id = $1 AND r.s3_key IS NOT NULL`,
          [instanceId],
        );
        keys = recs.map((r) => r.s3_key as string);
      }

      return { instance: instanceRow, counts: countsRow, s3Keys: keys };
    });

    // Outside any transaction / pool connection now. S3 objects go before any
    // DB delete: losing the rows first would strand the audio with no key
    // left to find it by, and nothing in the DB has been touched yet if this
    // throws - still retryable exactly as before.
    for (const key of s3Keys) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      } catch (err) {
        throw new ServiceUnavailableException(
          `object storage delete failed for ${key}: ${(err as Error).message}. ` +
            `Nothing was deleted - retry once storage is reachable.`,
        );
      }
    }

    // Short, write-only transaction now that the S3 side is settled.
    return this.db.withOrg(orgId, async (client) => {
      const purged: string[] = [];
      if (s3Keys.length > 0) purged.push(`${s3Keys.length} s3_audio_object`);

      if (counts.calls > 0) {
        // transcripts / recordings / ai_outputs / call_facts / call_notes /
        // crm_sync_log all cascade from calls.
        const callRes = await client.query(
          `DELETE FROM calls
            WHERE device_id IN (SELECT id FROM devices WHERE instance_id = $1)`,
          [instanceId],
        );
        purged.push(`${callRes.rowCount ?? 0} call_row`);
      }

      // Cascades devices + enrollment_tokens.
      await client.query("DELETE FROM instances WHERE id = $1", [instanceId]);
      if (counts.devices > 0) purged.push(`${counts.devices} device_row`);

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'instance.delete', 'instance', $3, $4)`,
        [
          orgId,
          req.principal?.userId ?? "dev-admin",
          instanceId,
          JSON.stringify({
            name: instance.name,
            purgeCalls,
            devices: counts.devices,
            calls: counts.calls,
          }),
        ],
      );

      return { deleted: true, instanceId, name: instance.name, purged };
    });
  }

  /**
   * Mint an additional enrollment key for an existing instance - used when a
   * customer onboards more handsets after the one issued at provisioning.
   */
  @Post(":id/keys")
  async mintKey(
    @OrgId() orgId: string,
    @Param("id") instanceId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = MintKeyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { tokenTtlMinutes, tokenMaxUses } = parsed.data;

    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    return this.db.withOrg(orgId, async (client) => {
      const found = await client.query("SELECT 1 FROM instances WHERE id = $1", [instanceId]);
      if (found.rowCount === 0) throw new NotFoundException("instance not found in this org");

      const {
        rows: [token],
      } = await client.query(
        `INSERT INTO enrollment_tokens (org_id, instance_id, token_hash, expires_at, max_uses)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4), $5)
         RETURNING expires_at, max_uses`,
        [orgId, instanceId, tokenHash, tokenTtlMinutes, tokenMaxUses],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'enrollment_key.create', 'instance', $3)`,
        [orgId, req.principal?.userId ?? "dev-admin", instanceId],
      );

      return {
        instanceId,
        // Shown once, never retrievable again - only the hash is stored.
        adminKey: rawToken,
        expiresAt: token.expires_at,
        maxUses: token.max_uses,
      };
    });
  }
}
