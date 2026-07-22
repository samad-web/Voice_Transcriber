import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { createHash, createVerify, randomBytes } from "node:crypto";
import * as jwt from "jsonwebtoken";
import { z } from "zod";
import { DeviceConfig, DeviceRegisterRequest } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { DeviceAuthGuard, type DeviceRequest } from "../../common/device-auth.guard";
import { issueNonce, verifyNonce } from "../../common/device-nonce";
import { orgIdFromHeader } from "../../common/org-context";
import { DbService } from "../../db/db.service";

const ChallengeBody = z.object({ deviceId: z.string().uuid() });
const AuthenticateBody = z.object({
  deviceId: z.string().uuid(),
  nonce: z.string().min(16),
  signature: z.string().min(16), // base64url DER ECDSA-SHA256 over the raw nonce string
});

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

@Controller("devices")
export class DevicesController {
  constructor(private readonly db: DbService) {}

  /**
   * Device enrollment — the activation gate (design doc §3.2). Called by the
   * Android admin screen with the instance ID + one-time admin key. A device
   * that has not completed this flow can never record.
   */
  @Post("register")
  async register(@Body() body: unknown) {
    const parsed = DeviceRegisterRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const req = parsed.data;

    // TODO (checklist §2.2): verify req.playIntegrityToken with the Play
    // Integrity API and reject rooted/emulated devices per tenant policy.

    // Enrollment runs before any org context exists — narrowly-scoped admin
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
  challenge(@Body() body: unknown) {
    const parsed = ChallengeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return { nonce: issueNonce(parsed.data.deviceId) };
  }

  /**
   * Step 2 (design doc §3.2): device signs the nonce with its Keystore P-256
   * key; a valid signature proves possession of hardware-backed key material
   * and earns a 15-minute access JWT. Only ACTIVE devices get tokens — this
   * is the server half of the activation gate.
   */
  @Post("authenticate")
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
      throw new UnauthorizedException(`device is ${device.status} — re-enrollment required`);
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
  async config(@Req() req: DeviceRequest) {
    const { deviceId, orgId } = req.device;
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `SELECT d.status AS device_status, i.config_version,
                o.status AS org_status, o.consent_policy, o.on_consent_failure
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
      });
    });
  }

  /** Remote logout — device keeps its data but can no longer record or auth. */
  @Post(":id/logout")
  @UseGuards(AdminKeyGuard)
  async logout(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.setDeviceStatus(orgIdFromHeader(orgHeader), id, "logged_out");
  }

  /** Remote wipe — device must delete local recordings + keys on next contact. */
  @Post(":id/wipe")
  @UseGuards(AdminKeyGuard)
  async wipe(
    @Headers("x-org-id") orgHeader: string | undefined,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    // TODO (checklist §3.5): push FCM message so the device acts immediately
    // instead of on next config poll.
    return this.setDeviceStatus(orgIdFromHeader(orgHeader), id, "wiped");
  }

  private setDeviceStatus(orgId: string, deviceId: string, status: "logged_out" | "wiped") {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        "UPDATE devices SET status = $2 WHERE id = $1 RETURNING id, status",
        [deviceId, status],
      );
      if (rows.length === 0) throw new BadRequestException("device not found in this org");
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', $2, 'device', $3)`,
        [orgId, `device.${status === "wiped" ? "wipe" : "logout"}`, deviceId],
      );
      return rows[0];
    });
  }

  /** Fleet listing for the web Devices page. */
  @Get()
  @UseGuards(AdminKeyGuard)
  async list(@Headers("x-org-id") orgHeader: string | undefined) {
    const orgId = orgIdFromHeader(orgHeader);
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
}
