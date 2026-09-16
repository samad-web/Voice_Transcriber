import { z } from "zod";
import { CaptureCapability } from "./enums";

/**
 * Device enrollment (design doc §3.2) + the activation gate:
 * the admin generates an instance ID + one-time admin key in the web app;
 * the Android admin screen submits them here. Recording stays disabled
 * until this flow completes.
 */
export const DeviceRegisterRequest = z.object({
  instanceId: z.string().uuid(),
  /** One-time admin/enrollment key: short TTL, limited use count, shown once. */
  enrollmentToken: z.string().min(16).max(128),
  publicKey: z.string(),
  deviceFingerprint: z.string().max(200),
  playIntegrityToken: z.string(),
  label: z.string().max(120).optional(),
  captureCapability: CaptureCapability.optional(),
});
export type DeviceRegisterRequest = z.infer<typeof DeviceRegisterRequest>;

export const DeviceRegisterResponse = z.object({
  deviceId: z.string().uuid(),
  refreshToken: z.string(),
});
export type DeviceRegisterResponse = z.infer<typeof DeviceRegisterResponse>;

export const DeviceAuthRequest = z.object({
  deviceId: z.string().uuid(),
  nonce: z.string(),
  signature: z.string(),
});
export type DeviceAuthRequest = z.infer<typeof DeviceAuthRequest>;

export const DeviceAuthResponse = z.object({
  accessToken: z.string(),
  expiresInS: z.number().int().positive(),
});
export type DeviceAuthResponse = z.infer<typeof DeviceAuthResponse>;

/** Versioned remote config document; server policy overrides local settings. */
export const DeviceConfig = z.object({
  version: z.number().int().min(0),
  /** The activation gate: devices must see true before any capture starts. */
  recordingEnabled: z.boolean(),
  capture: z.object({
    sampleRateHz: z.number().int().default(16000),
    channels: z.number().int().default(1),
    wifiOnlyUpload: z.boolean().default(true),
    localRetentionDays: z.number().int().min(0).default(0),
  }),
  consent: z.object({
    policy: z.enum(["none", "tone", "tone_and_tts", "prohibited"]),
    onFailure: z.enum(["record_and_flag", "do_not_record"]),
  }),
  /**
   * Per-instance mobile app-lock, set on the Instance page in the CRM.
   * `pbkdf2$<iterations>$<saltHex>$<hashHex>` (see app-lock-hash.ts) or null
   * when the org hasn't set one - the device verifies a typed password
   * against this offline, it is never sent back to the server.
   */
  /**
   * Optional as well as nullable, so the server can OMIT the key entirely
   * rather than send an explicit null. Defence in depth for an Android quirk
   * that already cost a device-bricking bug once: `JSONObject.optString(name,
   * fallback)` honours the fallback only for an ABSENT key and returns the
   * string "null" for a JSON null. The client now guards with `isNull` too
   * (PlatformApi.fetchConfig) - this is the other half, so a client that
   * forgets the guard is not punished for it.
   */
  appLockPasswordHash: z.string().nullable().optional(),
});
export type DeviceConfig = z.infer<typeof DeviceConfig>;

export const CreateCallRequest = z.object({
  idempotencyKey: z.string().max(80),
  direction: z.enum(["incoming", "outgoing"]),
  startedAt: z.string(),
  durationS: z.number().int().min(0),
  audioSourceUsed: z.string().max(40),
  sha256: z.string().length(64),
  bytes: z.number().int().positive(),
  consentPlayed: z.boolean(),
  // The other party's phone number (optional; only present when the device has
  // call-log/phone-state permission). The server keeps a short prefix + last3 +
  // hash for display/matching, never the full number.
  remoteNumber: z.string().max(40).optional(),
  remoteName: z.string().max(120).optional(),
});
export type CreateCallRequest = z.infer<typeof CreateCallRequest>;

export const CreateCallResponse = z.object({
  callId: z.string().uuid(),
  upload: z.object({
    method: z.literal("multipart"),
    uploadId: z.string(),
    partUrls: z.array(z.string()),
    partSizeBytes: z.number().int().positive(),
  }),
});
export type CreateCallResponse = z.infer<typeof CreateCallResponse>;

/**
 * GET /v1/devices/me/update - the self-update channel (migration 0081).
 *
 * `update` is null when the handset already carries the newest published build,
 * which is the answer almost every poll gets. A present object is always
 * strictly newer than the versionCode the device reported.
 */
export const AppUpdateResponse = z.object({
  update: z
    .object({
      /** Android's ordering key. Always > the device's own versionCode. */
      versionCode: z.number().int().positive(),
      versionName: z.string(),
      /** Presigned GET, minted per request. Short-lived - download immediately. */
      url: z.string().url(),
      /** Lowercase hex, verified on the handset before the installer is touched. */
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      sizeBytes: z.number().int().positive(),
      /**
       * Omitted, never null, when the release carries no note. Same reason
       * appLockPasswordHash is spread-or-nothing above: Android's
       * `JSONObject.optString(name, fallback)` honours the fallback only for an
       * ABSENT key and hands back the literal string "null" for a JSON null,
       * which would render as `null` in the update prompt.
       */
      notes: z.string().optional(),
    })
    .nullable(),
});
export type AppUpdateResponse = z.infer<typeof AppUpdateResponse>;

// ── Handset enrollment QR ────────────────────────────────────────────────────

/**
 * The QR payload version the Android activation screen parses.
 *
 * A CONTRACT with software already installed on phones in the field. Bumping
 * it, or renaming a field inside the payload, requires a matching change in
 * `AdminActivationActivity` and a supported-version floor - old handsets cannot
 * be updated on demand.
 */
export const ENROLLMENT_QR_VERSION = 1;

export interface EnrollmentQrInput {
  instanceId: string;
  /** The one-time enrollment token. Called `adminKey` on the wire since v1. */
  adminKey: string;
  /** Where the handset should talk to. Omitted when the app already knows. */
  serverUrl?: string | null;
}

/**
 * Build the string the handset scans.
 *
 * Lives in @aura/shared rather than in either console because BOTH mint
 * enrollment tokens now: the operator does it for bulk and MDM
 * (`/instances/:id/keys`), and since migration 0096 a client does it for a
 * phone in their hand (`/owner/devices/pairing-token`). Two consoles building
 * the same payload from two copies of the shape is how one of them silently
 * stops scanning after an unrelated edit.
 */
export function enrollmentQrPayload(input: EnrollmentQrInput): string {
  const serverUrl = input.serverUrl?.trim();
  return JSON.stringify({
    v: ENROLLMENT_QR_VERSION,
    instanceId: input.instanceId,
    adminKey: input.adminKey,
    ...(serverUrl ? { serverUrl } : {}),
  });
}
