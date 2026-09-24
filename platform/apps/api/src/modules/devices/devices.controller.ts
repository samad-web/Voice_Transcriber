import { createHash, createVerify, randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle, Throttle } from "@nestjs/throttler";
import * as jwt from "jsonwebtoken";
import { z } from "zod";
import {
  AppUpdateResponse,
  DeviceConfig,
  DeviceRecoverRequest,
  DeviceRecoveryProvisionRequest,
  DeviceRegisterRequest,
  DeviceRegisterResponse,
  judgeSecretRecovery,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { DeviceAuthGuard, type DeviceRequest } from "../../common/device-auth.guard";
import { issueNonce, verifyNonce } from "../../common/device-nonce";
import { OrgRoleGuard, RequireOrgRole } from "../../common/org-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { S3Service } from "../../s3/s3.service";
import { FcmService } from "../../fcm/fcm.service";
import { RealtimeService } from "../realtime/realtime.service";
import {
  findReturningDevice,
  hardwareHashFor,
  lockDevice,
  rebindDevice,
  restoreDevice,
} from "./device-rebind";
import { auditActor } from "../../common/audit-actor";

/**
 * The one refusal `POST /devices/recover` gives anybody who has not proven the
 * secret. Unknown device, wrong secret, malformed secret: all identical, so the
 * route cannot be used to learn which device ids exist.
 */
const RECOVERY_REFUSED = "recovery refused";

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

/**
 * The fleet is the handsets that have NOT been removed (0087).
 *
 * Every listing and every count filters on this. A removed device keeps its
 * row - `calls.device_id` has no cascade, so its history has to stay
 * resolvable - but it is no longer part of the fleet anyone is looking at, and
 * leaving it in the counts would mean an operator can never make the number on
 * screen match the number of phones in the building.
 */
const LIVE = "d.removed_at IS NULL";

/**
 * "Connected" = authenticating AND heard from within a day.
 *
 * Deliberately the same 24h boundary the staleness buckets already use
 * (`<1h` and `1-24h` are connected; `1-7d`, `stale` and `never` are not), so
 * the count on the instances list can never disagree with the chip on the
 * device row it summarises. Status matters as well as recency: a handset that
 * was wiped or logged out this morning reported in recently and is emphatically
 * not connected.
 */
const CONNECTED = `d.status = 'active' AND d.last_seen_at > now() - interval '${STALE_UNDER_24H_HOURS} hours'`;

@Controller("devices")
export class DevicesController {
  constructor(
    private readonly db: DbService,
    private readonly s3: S3Service,
    private readonly fcm: FcmService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Device enrollment - the activation gate (design doc §3.2). Called by the
   * Android admin screen with the instance ID + one-time admin key. A device
   * that has not completed this flow can never record.
   *
   * ── A PHONE THAT HAS BEEN HERE BEFORE GETS ITS OLD ROW BACK (0130) ────────
   *
   * The token still authorises everything; what changes is which row it lands
   * on. A re-link token names one row outright, and otherwise the handset's
   * hardware hash finds the row this phone used to be. Either way the row is
   * rebound - new key, same id - so the telecaller, the call history and the
   * leads carry straight on, instead of a stranger appearing beside a silent
   * "active" ghost. See device-rebind.ts for what is and is not reclaimable.
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
    } = await admin.query<{
      id: string;
      org_id: string;
      instance_id: string;
      relink_device_id: string | null;
    }>(
      `SELECT id, org_id, instance_id, relink_device_id
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
    const recoverySecret = randomBytes(32).toString("base64url");
    const hardwareHash = hardwareHashFor(token.org_id, req.hardwareId);

    const enrolled = await this.db.withOrg(token.org_id, async (client) => {
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

      const returning = await findReturningDevice(client, token, hardwareHash);
      if (returning) {
        const { device, method } = returning;
        const { installEpoch, newInstall } = await rebindDevice(client, device, {
          publicKey: req.publicKey,
          fingerprint: req.deviceFingerprint,
          label: req.label ?? null,
          captureCapability: req.captureCapability ?? null,
          refreshTokenHash: sha256(refreshToken),
          recoverySecretHash: sha256(recoverySecret),
          previousRecoverySecretHash: null,
          hardwareHash,
          enrollmentTokenId: token.id,
        });

        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'device', $2, 'device.recover', 'device', $2, $3)`,
          [
            token.org_id,
            device.id,
            JSON.stringify({
              method,
              previousStatus: device.status,
              wasRemoved: device.removed_at !== null,
              previousFingerprint: device.fingerprint,
              fingerprint: req.deviceFingerprint,
              newInstall,
              installEpoch,
            }),
          ],
        );

        return {
          deviceId: device.id,
          refreshToken,
          recoverySecret,
          recovered: true,
          telecallerName: device.telecaller_name,
        };
      }

      // `enrollment_token_id` (0124) is what lets the owner console's pairing
      // dialog see THIS phone arrive on THAT code, rather than guessing from
      // "a device appeared on the same instance just now".
      const {
        rows: [device],
      } = await client.query(
        `INSERT INTO devices
           (org_id, instance_id, label, public_key, fingerprint, capture_capability,
            refresh_token_hash, status, last_seen_at, enrollment_token_id,
            hardware_hash, recovery_secret_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now(), $8, $9, $10)
         RETURNING id, status, created_at`,
        [
          token.org_id,
          req.instanceId,
          req.label ?? null,
          req.publicKey,
          req.deviceFingerprint,
          req.captureCapability ?? null,
          sha256(refreshToken),
          token.id,
          hardwareHash,
          sha256(recoverySecret),
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
      return {
        deviceId: device.id as string,
        refreshToken,
        recoverySecret,
        recovered: false,
        telecallerName: null as string | null,
      };
    });

    // Announced here, and only after the transaction above has committed. The
    // global interceptor cannot do it: this route is unauthenticated apart from
    // the token in the body, so no guard ever resolved a tenant for it to read.
    // This signal is what moves an open pairing dialog from "scan this code"
    // to "connected" the moment the phone lands, instead of on its next poll.
    this.realtime.publish({
      orgId: token.org_id,
      topic: "device",
      action: enrolled.recovered ? "updated" : "created",
      id: enrolled.deviceId,
      at: new Date().toISOString(),
    });

    return this.enrollmentResponse(enrolled);
  }

  /**
   * A reinstalled app reclaiming its row with no QR (0130).
   *
   * The secret comes back from Google Block Store, which keeps it through an
   * uninstall when the phone has Google backup on. It is the only thing that
   * authorises this route, so judgeSecretRecovery (@aura/shared, pinned by its
   * tests) insists on the same phone and a still-active row before anything is
   * rebound. Everything else - a phone the owner retired, a different phone
   * holding a copied secret - is sent back to a person with a pairing code.
   *
   * The secret is replaced on every success, and the old one is honoured only
   * as a retry by the exact key it was replaced for.
   */
  @Post("recover")
  // Same limit and same reasoning as `register`: unauthenticated apart from a
  // credential in the body, so it is where guessing would happen - though a
  // 256-bit secret makes guessing moot, the limit keeps each attempt from being
  // a free admin-pool query.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async recover(@Body() body: unknown) {
    const parsed = DeviceRecoverRequest.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const req = parsed.data;

    // Pre-auth, like `authenticate`: the org is unknown until the device is.
    const {
      rows: [known],
    } = await this.db
      .adminPool()
      .query<{ org_id: string }>(`SELECT org_id FROM devices WHERE id = $1`, [req.deviceId]);
    if (!known) throw new UnauthorizedException(RECOVERY_REFUSED);

    const refreshToken = randomBytes(32).toString("base64url");
    const recoverySecret = randomBytes(32).toString("base64url");
    const hardwareHash = hardwareHashFor(known.org_id, req.hardwareId);

    const outcome = await this.db.withOrg(known.org_id, async (client) => {
      const device = await lockDevice(client, req.deviceId);
      if (!device) return { refused: "bad_secret" as const };

      const verdict = judgeSecretRecovery({
        presentedSecretHash: sha256(req.recoverySecret),
        currentSecretHash: device.recovery_secret_hash,
        previousSecretHash: device.recovery_secret_prev_hash,
        presentedPublicKey: req.publicKey,
        storedPublicKey: device.public_key,
        status: device.status,
        removed: device.removed_at !== null,
        presentedHardwareHash: hardwareHash,
        storedHardwareHash: device.hardware_hash,
      });

      if (!verdict.ok) {
        // A proven secret refused for status or hardware is worth a line in
        // the trail: someone holding this phone's credential tried to come
        // back and could not. A wrong secret is not - it is noise, and
        // recording it would let anyone write to a tenant's audit log.
        if (verdict.reason !== "bad_secret") {
          await client.query(
            `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
             VALUES ($1, 'device', $2, 'device.recover_refused', 'device', $2, $3)`,
            [
              known.org_id,
              device.id,
              JSON.stringify({ reason: verdict.reason, fingerprint: req.deviceFingerprint }),
            ],
          );
        }
        return { refused: verdict.reason };
      }

      const { installEpoch, newInstall } = await rebindDevice(client, device, {
        publicKey: req.publicKey,
        fingerprint: req.deviceFingerprint,
        label: req.label ?? null,
        captureCapability: req.captureCapability ?? null,
        refreshTokenHash: sha256(refreshToken),
        recoverySecretHash: sha256(recoverySecret),
        // Fresh: the secret just spent becomes the one a lost-response retry
        // may present. Retry: that is already what `prev` holds - keep it.
        previousRecoverySecretHash:
          verdict.mode === "fresh" ? device.recovery_secret_hash : device.recovery_secret_prev_hash,
        hardwareHash,
        enrollmentTokenId: null,
      });

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'device', $2, 'device.recover', 'device', $2, $3)`,
        [
          known.org_id,
          device.id,
          JSON.stringify({
            method: "recovery_secret",
            mode: verdict.mode,
            previousFingerprint: device.fingerprint,
            fingerprint: req.deviceFingerprint,
            newInstall,
            installEpoch,
          }),
        ],
      );

      return {
        enrolled: {
          deviceId: device.id,
          refreshToken,
          recoverySecret,
          recovered: true,
          telecallerName: device.telecaller_name,
        },
      };
    });

    if ("refused" in outcome) {
      if (outcome.refused === "bad_secret") throw new UnauthorizedException(RECOVERY_REFUSED);
      // The caller has proven the secret, so it is told why - the phone has to
      // tell the person holding it what to do next, and the two answers need
      // different people: "ask your admin to restore it" vs "get a new code".
      throw new ForbiddenException({
        statusCode: 403,
        code: outcome.refused,
        message:
          outcome.refused === "unlinked"
            ? "this handset was unlinked by an admin - ask them to restore it"
            : "this looks like a different phone - ask an admin for a re-link code",
      });
    }

    this.realtime.publish({
      orgId: known.org_id,
      topic: "device",
      action: "updated",
      id: outcome.enrolled.deviceId,
      at: new Date().toISOString(),
    });

    return this.enrollmentResponse(outcome.enrolled);
  }

  /**
   * An enrolled handset asking for a recovery secret (0130) - how the fleet
   * already in the field becomes recoverable without anyone re-pairing it.
   * The app calls this once per device id after taking the update, stores the
   * answer in Block Store, and reports its hardware hash at the same time so a
   * later QR re-pair can find this row.
   *
   * Replaces any earlier secret outright: the caller holds the Keystore key, so
   * it IS the phone the secret protects.
   */
  @Post("me/recovery")
  @UseGuards(DeviceAuthGuard)
  // Authenticated by a signed device token and called about once per phone,
  // from a fleet that shares one NAT address - same reasoning as fcm-token.
  @SkipThrottle()
  async provisionRecovery(@Req() req: DeviceRequest, @Body() body: unknown) {
    const parsed = DeviceRecoveryProvisionRequest.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { deviceId, orgId } = req.device;
    const recoverySecret = randomBytes(32).toString("base64url");

    const { rowCount } = await this.db.withOrg(orgId, (client) =>
      client.query(
        `UPDATE devices
            SET recovery_secret_hash = $2,
                recovery_secret_prev_hash = NULL,
                hardware_hash = COALESCE($3, hardware_hash)
          WHERE id = $1 AND status = 'active' AND removed_at IS NULL`,
        [deviceId, sha256(recoverySecret), hardwareHashFor(orgId, parsed.data.hardwareId)],
      ),
    );
    // The token is fifteen minutes old at most, so the device was active a
    // moment ago; an owner retired it since. Arming recovery for a retired
    // phone would hand it a way back that the retire was meant to close.
    if (!rowCount) throw new ConflictException("device is not active - recovery not armed");
    return { recoverySecret };
  }

  /**
   * Undo a logout, a wipe or a remove - the operator's side of "unlinked by
   * mistake" (0130). The owner console has the same action on
   * `POST /owner/devices/:id/restore`; both run restoreDevice.
   *
   * The phone still holds its key (a wipe is honoured by closing the gate, not
   * by destroying it), so its next check-in succeeds. The push makes that next
   * check-in happen now.
   */
  @Post(":id/restore")
  @UseGuards(AdminKeyGuard, TenantGuard, OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async restore(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const restored = await this.db.withOrg(orgId, async (client) => {
      const result = await restoreDevice(client, id);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $5, $2, 'device.restore', 'device', $3, $4)`,
        [
          orgId,
          auditActor(req).id,
          id,
          JSON.stringify({ previousStatus: result.previousStatus, wasRemoved: result.wasRemoved }), auditActor(req).type
        ],
      );
      return result;
    });
    const pinged = await this.pushConfigRefresh(orgId, id);
    return { ...restored, status: "active" as const, pinged };
  }

  /**
   * Both enrollment routes answer in this one shape. `telecallerName` is
   * spread-or-nothing, not null - see DeviceRegisterResponse.
   */
  private enrollmentResponse(e: {
    deviceId: string;
    refreshToken: string;
    recoverySecret: string;
    recovered: boolean;
    telecallerName: string | null;
  }) {
    return DeviceRegisterResponse.parse({
      deviceId: e.deviceId,
      refreshToken: e.refreshToken,
      recoverySecret: e.recoverySecret,
      recovered: e.recovered,
      ...(e.telecallerName ? { telecallerName: e.telecallerName } : {}),
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

  /**
   * The self-update channel (migration 0081). The handset reports the
   * versionCode it is running and gets back the newest PUBLISHED build that is
   * strictly newer, or `{ update: null }` - which is what almost every poll
   * gets, and is deliberately a 200 rather than a 204 so the client has one
   * response shape to parse instead of two.
   *
   * Two things this route is careful about:
   *
   * 1. **It is advisory, never a gate.** Nothing here can stop a device
   *    recording. `recordingEnabled` lives in /me/config and is not influenced
   *    by the version a handset is on, so a bad release - or a release channel
   *    that is empty, misconfigured or erroring - cannot take the fleet offline.
   *    An update the phone declines is a phone that keeps working.
   *
   * 2. **The URL is presigned per request.** Storing a URL in app_releases
   *    would bake in a link that expires long before the row does; the bucket
   *    is not public, and it must not become public just to serve an APK.
   */
  @Get("me/update")
  @UseGuards(DeviceAuthGuard)
  // Polled by every handset on the same cycle as /me/config, from a shared
  // source IP behind the customer's NAT. Same reasoning as config: already
  // authenticated by a signed device token, and rate-limiting the fleet's
  // shared egress address would starve the phones that poll last.
  @SkipThrottle()
  async appUpdate(@Req() req: DeviceRequest, @Query("versionCode") versionCode?: string) {
    const { deviceId, orgId } = req.device;

    // Parse before use: an absent or junk param must not silently become 0 and
    // offer an update to a device that is already current. Unknown means
    // "tell me nothing" - the phone re-asks in an hour with a real number.
    const current = Number.parseInt(versionCode ?? "", 10);
    if (!Number.isInteger(current) || current < 0) return { update: null };

    // Record what the handset says it is running, so the fleet view can show
    // which phones have taken an update and which are lagging. Best-effort:
    // this is telemetry, and failing the update check because a bookkeeping
    // UPDATE failed would be the tail wagging the dog.
    try {
      await this.db.withOrg(orgId, (client) =>
        client.query(
          `UPDATE devices SET app_version = $2, updated_at = now()
            WHERE id = $1 AND app_version IS DISTINCT FROM $2`,
          [deviceId, String(current)],
        ),
      );
    } catch {
      // Ignored on purpose - see above.
    }

    // app_releases has no org_id and no RLS (it is one fleet-wide APK), so
    // there is no tenant context to enter. The admin pool is the right handle
    // for a platform-level table, the same way enrollment does its token lookup.
    const {
      rows: [release],
    } = await this.db
      .adminPool()
      .query(
        `SELECT version_code, version_name, object_key, sha256, size_bytes, notes
           FROM app_releases
          WHERE published AND version_code > $1
          ORDER BY version_code DESC
          LIMIT 1`,
        [current],
      );
    if (!release) return { update: null };

    return AppUpdateResponse.parse({
      update: {
        versionCode: release.version_code,
        versionName: release.version_name,
        // 30 minutes: long enough for a phone on a weak connection to finish a
        // few-MB download, short enough that a leaked URL is worthless by the
        // time anyone finds it.
        url: await this.s3.presignedGetUrl(release.object_key, 1800, "application/octet-stream"),
        sha256: release.sha256,
        sizeBytes: Number(release.size_bytes),
        // Spread-or-nothing, not an explicit null - see the schema comment in
        // packages/shared/src/device-api.ts. A JSON null reaches Android's
        // optString as the string "null" and would print as the release note.
        ...(release.notes ? { notes: release.notes } : {}),
      },
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
    const result = await this.setDeviceStatus(orgId, id, "logged_out", req);
    await this.pushConfigRefresh(orgId, id);
    return result;
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
    const result = await this.setDeviceStatus(orgId, id, "wiped", req);
    await this.pushConfigRefresh(orgId, id);
    return result;
  }

  /**
   * Ping / wake a device - pushes a config-refresh signal without changing
   * the device's status. Use this to remotely wake an app that Android's
   * battery optimisation has put to sleep.
   */
  @Post(":id/ping")
  @UseGuards(AdminKeyGuard, TenantGuard, OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async ping(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    const pushed = await this.pushConfigRefresh(orgId, id);
    return { pinged: pushed };
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
           VALUES ($1, $5, $2, 'device.telecaller_set', 'device', $3, $4)`,
          [orgId, auditActor(req).id, deviceId, JSON.stringify({ name, externalId }), auditActor(req).type],
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
         VALUES ($1, $5, $2, $3, 'device', $4)`,
        [orgId, auditActor(req).id, `device.${status === "wiped" ? "wipe" : "logout"}`, deviceId, auditActor(req).type],
      );
      return rows[0];
    });
  }

  /**
   * Take a handset out of the fleet.
   *
   * Logout and Wipe are both states a device STAYS in - neither takes it off
   * the list - so until now a phone that left the company a year ago read
   * exactly like one that is merely offline this afternoon. This is the third
   * action, and the only one that removes.
   *
   * Two tiers, mirroring instances.controller's decommission and for the same
   * FK reason: `calls.device_id` has no cascade, so a handset that recorded
   * anything cannot be DELETEd without destroying that history.
   *
   *  - **no calls**  → the row goes outright. `device_health` cascades,
   *                    `leads.telecaller_device_id` nulls (0010). A test
   *                    enrollment or a mis-scanned QR leaves nothing behind.
   *  - **has calls** → de-enrolled: `removed_at` stamped and `status` dropped
   *                    to `logged_out`, so it leaves every listing and count
   *                    AND stops authenticating, while its calls keep
   *                    resolving in the log, the reports and the lead board.
   *
   * Deliberately NOT a wipe. Wiping destroys the recordings still sitting on
   * the handset, which is a separate and more destructive choice the operator
   * already has one button for; taking a phone off the console's list must not
   * silently reach out and erase it. An operator who wants both presses both.
   */
  @Delete(":id")
  @UseGuards(AdminKeyGuard, TenantGuard, OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async remove(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [device],
      } = await client.query(
        "SELECT id, label, status, removed_at FROM devices WHERE id = $1",
        [id],
      );
      if (!device) throw new NotFoundException("device not found in this org");
      // Not an error worth a 500, but not a silent no-op either: a second
      // Delete on the same row means the operator is looking at a stale table.
      if (device.removed_at) {
        throw new ConflictException("that handset has already been removed from the fleet");
      }

      const {
        rows: [{ calls }],
      } = await client.query("SELECT count(*)::int AS calls FROM calls WHERE device_id = $1", [id]);

      const outcome: "deleted" | "de-enrolled" = calls === 0 ? "deleted" : "de-enrolled";
      if (outcome === "deleted") {
        await client.query("DELETE FROM devices WHERE id = $1", [id]);
      } else {
        await client.query(
          "UPDATE devices SET removed_at = now(), status = 'logged_out' WHERE id = $1",
          [id],
        );
      }

      // After the write, and safe there: audit_log.target_id is plain `text`
      // with no FK back to devices (0001), so the trail survives the hard
      // delete that is the whole point of the first branch.
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $5, $2, 'device.remove', 'device', $3, $4)`,
        [
          orgId,
          auditActor(req).id,
          id,
          JSON.stringify({ outcome, calls, label: device.label, previousStatus: device.status }), auditActor(req).type
        ],
      );

      return { id, outcome, calls };
    });
  }

  /**
   * Device FCM token registration. Called by the Android app after enrollment
   * and on token refresh.
   */
  @Post("me/fcm-token")
  @UseGuards(DeviceAuthGuard)
  @SkipThrottle()
  async registerFcmToken(@Req() req: DeviceRequest, @Body() body: unknown) {
    const parsed = z.object({ token: z.string().min(1).max(500) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { deviceId, orgId } = req.device;
    await this.db.withOrg(orgId, (client) =>
      client.query("UPDATE devices SET fcm_token = $2 WHERE id = $1", [deviceId, parsed.data.token]),
    );
    return { registered: true };
  }

  /**
   * Look up a device's FCM token and push a config-refresh signal.
   * Best-effort: returns false when push is unavailable or the device has no
   * token (pre-upgrade handsets), so callers must not depend on it.
   */
  private async pushConfigRefresh(orgId: string, deviceId: string): Promise<boolean> {
    // withOrg, NOT adminPool: this used to take orgId and never use it, reading
    // `WHERE id = $1` off the RLS-bypassing pool. logout/wipe got away with it
    // because setDeviceStatus runs org-scoped first and would already have
    // thrown - but `ping` calls straight in here, so any org_admin holding a
    // device UUID from another tenant could wake that handset. RLS's
    // org_isolation policy on devices makes the id lookup org-scoped, and a
    // cross-tenant id now returns no rows and reads as "no token".
    //
    // Wrapped because withOrg can throw where adminPool could not (it opens a
    // transaction and the org_isolation policy casts app.org_id to uuid). The
    // contract above promises callers a boolean and nothing worse: logout and
    // wipe have ALREADY committed the status change by the time they call this,
    // so letting a push lookup throw here would turn a completed remote wipe
    // into a 500 and invite the operator to retry an action that had worked.
    try {
      const {
        rows: [device],
      } = await this.db.withOrg(orgId, (client) =>
        client.query("SELECT fcm_token FROM devices WHERE id = $1", [deviceId]),
      );
      if (!device?.fcm_token) return false;
      return this.fcm.sendToDevice(device.fcm_token, { action: "config_refresh" });
    } catch {
      return false;
    }
  }

  /** Fleet listing for the web Devices page. */
  @Get()
  @UseGuards(AdminKeyGuard, TenantGuard)
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT d.id, d.instance_id, d.label, d.fingerprint, d.os_version, d.app_version,
                d.status, d.capture_capability, d.last_seen_at, d.created_at,
                d.telecaller_name, (${CONNECTED}) AS connected
         FROM devices d
         WHERE ${LIVE}
         ORDER BY d.created_at DESC`,
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
          WHERE ${LIVE}
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
