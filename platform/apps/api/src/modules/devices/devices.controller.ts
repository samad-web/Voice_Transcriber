import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { createHash, createVerify, randomBytes } from "node:crypto";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import * as jwt from "jsonwebtoken";
import { z } from "zod";
import { DeviceConfig, DeviceRegisterRequest } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { DeviceAuthGuard, type DeviceRequest } from "../../common/device-auth.guard";
import { issueNonce, verifyNonce } from "../../common/device-nonce";
import { OrgRoleGuard, RequireOrgRole } from "../../common/org-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const ChallengeBody = z.object({ deviceId: z.string().uuid() });
const SetTelecallerBody = z.object({
  name: z.string().trim().min(1).max(120),
  // Employee/agent code. Optional - most telecallers may never be given one.
  externalId: z.string().trim().max(64).nullable().optional(),
  // True when this handset now belongs to a genuinely different person -
  // mints a new telecaller identity instead of renaming the existing one.
  // False (the default) is for correcting a typo in the current holder's
  // own name.
  reassign: z.boolean().default(false),
});
const AuthenticateBody = z.object({
  deviceId: z.string().uuid(),
  nonce: z.string().min(16),
  signature: z.string().min(16), // base64url DER ECDSA-SHA256 over the raw nonce string
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

// ── Fleet health (Phase 5) ───────────────────────────────────────────────────
//
// Thresholds for GET /devices/fleet-health below. Named + commented rather
// than inline literals so a future tuning pass has one place to look, and so
// a code reviewer sees the reasoning next to the number instead of just the
// number.

/** A device with no last_seen_at beacon at all has never checked in. */
type Staleness = "never" | "<1h" | "1-24h" | "1-7d" | "stale";

/**
 * How long an ACTIVE device may go quiet before it counts as "stale" for
 * display purposes. Every enrolled handset re-authenticates every 15 minutes
 * (DEVICE_JWT_TTL_SECONDS) and beacons /devices/me/health on top of that, so
 * these bands are generous multiples of that cadence, not the cadence itself.
 */
const STALE_UNDER_1H_HOURS = 1;
const STALE_UNDER_24H_HOURS = 24;
const STALE_UNDER_7D_HOURS = 24 * 7;

/**
 * An ACTIVE device silent longer than this needs attention. `logged_out` and
 * `wiped` devices are deliberately excluded - going quiet is their whole
 * point, not a fault - so this only ever fires against `status = 'active'`.
 * Same 24h band as the STALE_UNDER_24H_HOURS display bucket: a device an
 * admin already sees as "1-24h" is not yet a problem, one day+ is.
 */
const NEEDS_ATTENTION_STALE_HOURS = 24;

/**
 * Free on-device storage below this is close to blocking new recordings from
 * ever landing (the handset stops accepting capture before it stops beaconing
 * health). Picked well above zero so an admin has a runway to act - a
 * lock-screen-only device can eat storage fast between two health beacons.
 */
const LOW_STORAGE_MB = 500;

/**
 * device_health.failure_counts is an open jsonb map (upload/transcribe retry
 * counters etc., not a fixed key set), so this checks every value rather than
 * one named key. A handful of transient retries is normal on flaky mobile
 * data; a double-digit count on any one counter is not.
 */
const ELEVATED_FAILURE_COUNT = 5;

function stalenessOf(lastSeenAt: string | Date | null, now: number): Staleness {
  if (!lastSeenAt) return "never";
  const ageHours = (now - new Date(lastSeenAt).getTime()) / (60 * 60 * 1000);
  if (ageHours < STALE_UNDER_1H_HOURS) return "<1h";
  if (ageHours < STALE_UNDER_24H_HOURS) return "1-24h";
  if (ageHours < STALE_UNDER_7D_HOURS) return "1-7d";
  return "stale";
}

interface LatestHealth {
  batteryLevel: number | null;
  freeStorageMb: number | null;
  pendingUploads: number | null;
  failureCounts: Record<string, number>;
  ts: string;
}

/** Why a device tripped `needsAttention` - rendered as the web chip's tooltip. */
function attentionReasons(
  status: string,
  lastSeenAt: string | Date | null,
  now: number,
  health: LatestHealth | null,
): string[] {
  const reasons: string[] = [];
  if (
    status === "active" &&
    (!lastSeenAt || (now - new Date(lastSeenAt).getTime()) / (60 * 60 * 1000) > NEEDS_ATTENTION_STALE_HOURS)
  ) {
    reasons.push(`silent over ${NEEDS_ATTENTION_STALE_HOURS}h while active`);
  }
  if (health?.freeStorageMb != null && health.freeStorageMb < LOW_STORAGE_MB) {
    reasons.push(`free storage under ${LOW_STORAGE_MB}MB`);
  }
  if (health?.failureCounts && Object.values(health.failureCounts).some((n) => Number(n) > ELEVATED_FAILURE_COUNT)) {
    reasons.push("elevated failure count");
  }
  return reasons;
}

/**
 * Latest device_health row per device. Same LATERAL shape as
 * CONTACT_HISTORY_JOIN (calls.controller.ts) - ordered by the time column
 * DESC LIMIT 1 - using the (device_id, ts DESC) index device_health already
 * has, rather than a stored "current health" column that would drift the
 * moment a newer beacon lands anywhere but here.
 */
const LATEST_HEALTH_JOIN = `
  LEFT JOIN LATERAL (
    SELECT battery_level, free_storage_mb, pending_uploads, failure_counts, ts
      FROM device_health dh
     WHERE dh.device_id = d.id
     ORDER BY dh.ts DESC
     LIMIT 1
  ) h ON true`;

@Controller("devices")
export class DevicesController {
  constructor(private readonly db: DbService) {}

  /**
   * Device enrollment - the activation gate (design doc §3.2). Called by the
   * Android admin screen with the instance ID + one-time admin key. A device
   * that has not completed this flow can never record.
   */
  @Post("register")
  // 10/min per IP (checklist 08 §0.7). Enrollment is unauthenticated apart from
  // the one-time key in the body, so it is where an attacker would sit guessing
  // enrollment tokens; each attempt also costs an admin-pool query. Ten is
  // comfortably above the human pace of scanning QR codes onto handsets, which
  // is the only legitimate way this route is called.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async register(@Body() body: unknown) {
    const parsed = DeviceRegisterRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const req = parsed.data;

    // TODO (checklist §2.2): verify req.playIntegrityToken with the Play
    // Integrity API and reject rooted/emulated devices per tenant policy.

    // Enrollment runs before any org context exists - narrowly-scoped admin
    // lookup to resolve the org from the token, then everything tenant-scoped.
    const admin = this.db.adminPool();
    const {
      rows: [token],
    } = await admin.query(
      `SELECT id, org_id
         FROM enrollment_tokens
        WHERE instance_id = $1
          AND token_hash = $2
          AND expires_at > now()
          AND use_count < max_uses`,
      [req.instanceId, sha256(req.enrollmentToken)],
    );
    if (!token) {
      throw new UnauthorizedException("invalid, expired, or exhausted enrollment key");
    }

    const refreshToken = randomBytes(32).toString("base64url");

    return this.db.withOrg(token.org_id, async (client) => {
      // Guard against concurrent use of the same key
      const used = await client.query(
        `UPDATE enrollment_tokens
            SET use_count = use_count + 1
          WHERE id = $1 AND use_count < max_uses
          RETURNING id`,
        [token.id],
      );
      if (used.rowCount === 0) {
        throw new UnauthorizedException("enrollment key exhausted");
      }

      const {
        rows: [device],
      } = await client.query(
        `INSERT INTO devices
           (org_id, instance_id, label, public_key, fingerprint, capture_capability,
            refresh_token_hash, status, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now())
         RETURNING id, status, created_at`,
        [
          token.org_id,
          req.instanceId,
          req.label ?? null,
          req.publicKey,
          req.deviceFingerprint,
          req.captureCapability ?? null,
          sha256(refreshToken),
        ],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'device', $2, 'device.register', 'instance', $3, $4)`,
        [
          token.org_id,
          device.id,
          req.instanceId,
          JSON.stringify({ fingerprint: req.deviceFingerprint, capability: req.captureCapability ?? null }),
        ],
      );

      // Shown once; the device stores it in its Keystore-backed token store.
      return { deviceId: device.id, refreshToken };
    });
  }

  /** Step 1 of device auth: hand out a short-lived nonce to sign. */
  @Post("challenge")
  // Not throttled (checklist 08 §0.7). Device access tokens live 15 minutes
  // (DEVICE_JWT_TTL_SECONDS), so a tenant's whole fleet re-runs challenge +
  // authenticate on a loop, and a fleet shares one office/NAT source IP - a
  // per-IP limit would stop the biggest customers recording first. The real
  // gate is the ECDSA signature over the nonce in `authenticate`, which no
  // volume of requests helps an attacker forge. `challenge` itself is an HMAC
  // over the device id with no database access.
  @SkipThrottle()
  challenge(@Body() body: unknown) {
    const parsed = ChallengeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return { nonce: issueNonce(parsed.data.deviceId) };
  }

  /**
   * Step 2 (design doc §3.2): device signs the nonce with its Keystore P-256
   * key; a valid signature proves possession of hardware-backed key material
   * and earns a 15-minute access JWT. Only ACTIVE devices get tokens - this
   * is the server half of the activation gate.
   */
  @Post("authenticate")
  // Not throttled - same reasoning as `challenge` above: whole fleets re-auth
  // every 15 minutes from a shared source IP, and possession of the Keystore
  // private key is the gate.
  @SkipThrottle()
  async authenticate(@Body() body: unknown) {
    const parsed = AuthenticateBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { deviceId, nonce, signature } = parsed.data;

    if (!verifyNonce(nonce, deviceId)) {
      throw new UnauthorizedException("invalid or expired nonce");
    }

    // Pre-auth flow: resolve the device via the admin pool, then verify proof.
    const {
      rows: [device],
    } = await this.db.adminPool().query(
      `SELECT d.id, d.org_id, d.instance_id, d.public_key, d.status, i.config_version
         FROM devices d JOIN instances i ON i.id = d.instance_id
        WHERE d.id = $1`,
      [deviceId],
    );
    if (!device) throw new UnauthorizedException("unknown device");
    if (device.status !== "active") {
      throw new UnauthorizedException(`device is ${device.status} - re-enrollment required`);
    }

    const verifier = createVerify("SHA256");
    verifier.update(nonce);
    verifier.end();
    let valid = false;
    try {
      valid = verifier.verify(device.public_key, Buffer.from(signature, "base64url"));
    } catch {
      valid = false;
    }
    if (!valid) throw new UnauthorizedException("signature verification failed");

    const accessToken = jwt.sign(
      {
        scope: "device",
        org_id: device.org_id,
        instance_id: device.instance_id,
        cfg_ver: device.config_version,
      },
      process.env.JWT_SECRET ?? "dev-jwt-secret-change-me",
      { subject: device.id, expiresIn: "15m" },
    );

    await this.db.withOrg(device.org_id, (client) =>
      client.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [device.id]),
    );

    return { accessToken, expiresInS: 900 };
  }

  /**
   * Versioned remote config (design doc §9). `recordingEnabled` is the
   * activation gate the Android client must honor before ANY capture starts:
   * false whenever the device is not active, the org is suspended, or the
   * tenant's consent policy prohibits recording.
   */
  @Get("me/config")
  @UseGuards(DeviceAuthGuard)
  // Not throttled: polled by every handset in the fleet, from a shared source
  // IP, and it is the gate the client checks before capture - rate-limiting it
  // stops recording. Already authenticated by a signed device token.
  @SkipThrottle()
  async config(@Req() req: DeviceRequest) {
    const { deviceId, orgId } = req.device;
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `SELECT d.status AS device_status, i.config_version,
                o.status AS org_status, o.consent_policy, o.on_consent_failure,
                o.app_lock_password_hash
           FROM devices d
           JOIN instances i ON i.id = d.instance_id
           JOIN organizations o ON o.id = d.org_id
          WHERE d.id = $1`,
        [deviceId],
      );
      if (!row) throw new UnauthorizedException("device not found");

      const recordingEnabled =
        row.device_status === "active" &&
        row.org_status === "active" &&
        row.consent_policy !== "prohibited";

      return DeviceConfig.parse({
        version: row.config_version,
        recordingEnabled,
        capture: {
          sampleRateHz: 16000,
          channels: 1,
          wifiOnlyUpload: true,
          localRetentionDays: 0,
        },
        consent: {
          policy: row.consent_policy,
          onFailure: row.on_consent_failure,
        },
        // Spread-or-nothing rather than an explicit null: an absent key is the
        // one shape Android's optString handles correctly. See the schema
        // comment in packages/shared/src/device-api.ts.
        ...(row.app_lock_password_hash
          ? { appLockPasswordHash: row.app_lock_password_hash }
          : {}),
      });
    });
  }

  /** Remote logout - device keeps its data but can no longer record or auth. */
  @Post(":id/logout")
  @UseGuards(AdminKeyGuard, TenantGuard, OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async logout(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.setDeviceStatus(orgId, id, "logged_out", req);
  }

  /** Remote wipe - device must delete local recordings + keys on next contact. */
  @Post(":id/wipe")
  @UseGuards(AdminKeyGuard, TenantGuard, OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async wipe(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    // TODO (checklist §3.5): push FCM message so the device acts immediately
    // instead of on next config poll.
    return this.setDeviceStatus(orgId, id, "wiped", req);
  }

  /**
   * Set the telecaller (name + optional employee/agent code) holding this
   * handset. Captured here, at connection time in the platform console, so a
   * recorded call can be traced to who actually spoke it - not just which
   * device recorded it - the moment a device is enrolled, rather than only
   * after the fact from the org's own owner dashboard.
   *
   * Writes the same `telecallers` identity table (0017) and `devices`
   * columns that owner.controller's setTelecaller does - this is the same
   * feature reachable from the operator side, plus the external_id (0067)
   * that route does not collect. Re-running with the same device links back
   * to the existing telecaller row instead of creating a duplicate, so this
   * doubles as "modify": call it again to correct a name or code.
   *
   * `reassign: true` is the other case - a genuinely different person now
   * holds this handset. Without it, calling this with a new name RENAMES the
   * existing telecaller row, which would silently relabel their whole call
   * history as the new person's (0068). `reassign` always mints a fresh
   * `telecallers` row and re-points the device at it, leaving the old
   * identity's row and history untouched.
   */
  @Patch(":id/telecaller")
  @UseGuards(AdminKeyGuard, TenantGuard)
  async setTelecaller(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) deviceId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = SetTelecallerBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const name = parsed.data.name;
    const externalId = parsed.data.externalId?.trim() || null;
    const reassign = parsed.data.reassign;

    try {
      return await this.db.withOrg(orgId, async (client) => {
        const {
          rows: [device],
        } = await client.query(`SELECT telecaller_id FROM devices WHERE id = $1`, [deviceId]);
        if (!device) throw new BadRequestException("device not found in this org");

        let telecallerId: string = device.telecaller_id;
        if (telecallerId && !reassign) {
          await client.query(
            `UPDATE telecallers SET display_name = $2, external_id = $3 WHERE id = $1`,
            [telecallerId, name, externalId],
          );
        } else {
          const {
            rows: [inserted],
          } = await client.query(
            `INSERT INTO telecallers (org_id, display_name, external_id)
             VALUES ($1, $2, $3) RETURNING id`,
            [orgId, name, externalId],
          );
          telecallerId = inserted.id;
          await client.query(`UPDATE devices SET telecaller_id = $2 WHERE id = $1`, [
            deviceId,
            telecallerId,
          ]);
        }

        const {
          rows: [updated],
        } = await client.query(
          `UPDATE devices SET telecaller_name = $2 WHERE id = $1
           RETURNING id, telecaller_name, telecaller_id`,
          [deviceId, name],
        );

        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'user', $2, 'device.telecaller_set', 'device', $3, $4)`,
          [orgId, req.principal?.userId ?? "dev-admin", deviceId, JSON.stringify({ name, externalId })],
        );

        return {
          device: updated,
          telecaller: { id: telecallerId, displayName: name, externalId },
        };
      });
    } catch (err) {
      // Unique violation on telecallers_org_external_id (0067) - two
      // telecallers under this org can't share one employee/agent code.
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException(
          `That ID is already assigned to another telecaller in this org.`,
        );
      }
      throw err;
    }
  }

  private setDeviceStatus(orgId: string, deviceId: string, status: "logged_out" | "wiped", req: PrincipalRequest) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        "UPDATE devices SET status = $2 WHERE id = $1 RETURNING id, status",
        [deviceId, status],
      );
      if (rows.length === 0) throw new BadRequestException("device not found in this org");
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, $3, 'device', $4)`,
        [orgId, req.principal?.userId ?? "dev-admin", `device.${status === "wiped" ? "wipe" : "logout"}`, deviceId],
      );
      return rows[0];
    });
  }

  /** Fleet listing for the web Devices page. */
  @Get()
  @UseGuards(AdminKeyGuard, TenantGuard)
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, instance_id, label, fingerprint, os_version, app_version,
                status, capture_capability, last_seen_at, created_at
         FROM devices
         ORDER BY created_at DESC`,
      );
      return { devices: rows };
    });
  }

  /**
   * Fleet health (Phase 5): staleness + latest telemetry per device, plus a
   * computed `needsAttention` the web devices table (instance detail page)
   * renders as a chip. A sibling to `list()` above - same table, same guard
   * tier, richer computed fields drawn from device_health - not a
   * replacement. Org-wide (not filtered to one instance) so the console can
   * fetch it once per page load and key the result by device id, instead of
   * one extra round trip per instance.
   */
  @Get("fleet-health")
  @UseGuards(AdminKeyGuard, TenantGuard)
  async fleetHealth(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT d.id, d.instance_id, d.status, d.last_seen_at,
                h.battery_level, h.free_storage_mb, h.pending_uploads, h.failure_counts, h.ts AS health_ts
           FROM devices d
           ${LATEST_HEALTH_JOIN}
          ORDER BY d.created_at DESC`,
      );

      const now = Date.now();
      const devices = rows.map((row) => {
        const health: LatestHealth | null = row.health_ts
          ? {
              batteryLevel: row.battery_level,
              freeStorageMb: row.free_storage_mb,
              pendingUploads: row.pending_uploads,
              failureCounts: row.failure_counts ?? {},
              ts: row.health_ts,
            }
          : null;
        const reasons = attentionReasons(row.status, row.last_seen_at, now, health);
        return {
          deviceId: row.id as string,
          instanceId: row.instance_id as string,
          staleness: stalenessOf(row.last_seen_at, now),
          health,
          needsAttention: reasons.length > 0,
          attentionReasons: reasons,
        };
      });

      return { devices };
    });
  }
}
