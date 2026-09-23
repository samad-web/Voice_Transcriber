import { z } from "zod";
import { CaptureCapability } from "./enums";

/**
 * Device enrollment (design doc §3.2) + the activation gate:
 * the admin generates an instance ID + one-time admin key in the web app;
 * the Android admin screen submits them here. Recording stays disabled
 * until this flow completes.
 */
/**
 * What the handset sends to say which physical phone it is (0130): a SHA-256
 * it derives from ANDROID_ID, so the raw id never leaves the phone. ANDROID_ID
 * survives an uninstall, which is the whole point - it is how a re-scanned
 * pairing QR finds the row this phone used to be.
 *
 * A routing hint, never a credential. Nothing is authorised by it alone:
 * `register` still needs a live pairing token, and `recover` still needs the
 * recovery secret. Optional because every build before 1.1.6 omits it.
 */
export const HardwareId = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase sha256 hex digest");

export const DeviceRegisterRequest = z.object({
  instanceId: z.string().uuid(),
  /** One-time admin/enrollment key: short TTL, limited use count, shown once. */
  enrollmentToken: z.string().min(16).max(128),
  publicKey: z.string(),
  deviceFingerprint: z.string().max(200),
  playIntegrityToken: z.string(),
  label: z.string().max(120).optional(),
  captureCapability: CaptureCapability.optional(),
  hardwareId: HardwareId.optional(),
});
export type DeviceRegisterRequest = z.infer<typeof DeviceRegisterRequest>;

export const DeviceRegisterResponse = z.object({
  deviceId: z.string().uuid(),
  refreshToken: z.string(),
  /**
   * The credential that lets THIS phone reclaim its row after a reinstall
   * without a QR (0130). The handset keeps it in Google Block Store, never in
   * its own preferences, and it is replaced on every use.
   */
  recoverySecret: z.string(),
  /** True when the phone took back an existing row instead of adding one. */
  recovered: z.boolean(),
  /**
   * Who holds this handset, so a reinstalled app can greet its telecaller by
   * name again. Omitted rather than null when nobody is set: an absent key is
   * the one shape Android's optString handles correctly (see DeviceConfig).
   */
  telecallerName: z.string().optional(),
});
export type DeviceRegisterResponse = z.infer<typeof DeviceRegisterResponse>;

/**
 * `POST /devices/recover` (0130): a reinstalled app reclaiming its row with the
 * secret it read back from Block Store. No pairing token - the secret is the
 * authorisation - so the server insists on three things before it rebinds: the
 * secret matches, the row is still active (an owner's retire is never undone
 * by the phone itself), and the hardware hash names the same physical phone.
 */
export const DeviceRecoverRequest = z.object({
  deviceId: z.string().uuid(),
  recoverySecret: z.string().min(32).max(128),
  publicKey: z.string().min(64).max(2000),
  deviceFingerprint: z.string().max(200),
  label: z.string().max(120).optional(),
  captureCapability: CaptureCapability.optional(),
  hardwareId: HardwareId.optional(),
});
export type DeviceRecoverRequest = z.infer<typeof DeviceRecoverRequest>;

/**
 * `POST /devices/me/recovery` (0130): an ENROLLED handset asking for a recovery
 * secret, and reporting its hardware hash. How the fleet already in the field
 * - enrolled before recovery existed - becomes recoverable once it takes the
 * update, without anyone re-pairing a phone.
 */
export const DeviceRecoveryProvisionRequest = z.object({
  hardwareId: HardwareId.optional(),
});
export type DeviceRecoveryProvisionRequest = z.infer<typeof DeviceRecoveryProvisionRequest>;

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
 * POST /v1/calls/missed - calls nobody picked up, read from the handset's own
 * call log (migration 0133).
 *
 * A separate route rather than a flag on CreateCallRequest, because that
 * contract is an UPLOAD handshake: it demands bytes and a digest and answers
 * with multipart URLs. A missed call has no audio, and bending the upload
 * shape around "zero bytes, no parts" would teach every older client a state
 * it was never built for.
 *
 * Batched, because the call log is read as a backlog: a phone that slept for a
 * day wakes with every call it missed since, and one round trip per entry is
 * the shape that lost uploads in the first place.
 */
export const MissedCallReason = z.enum([
  /** Rang out - CallLog.Calls.MISSED_TYPE. */
  "unanswered",
  /** Rejected on the handset - REJECTED_TYPE. */
  "declined",
  /** Sent to voicemail - VOICEMAIL_TYPE. */
  "voicemail",
  /**
   * An OUTGOING attempt that rang out (migration 0134) - CallLog.Calls
   * .OUTGOING_TYPE with a zero duration. The one reason that pairs with
   * `direction: "outgoing"` rather than "incoming"; see MissedCallEntry's
   * refinement.
   */
  "no_answer",
]);
export type MissedCallReason = z.infer<typeof MissedCallReason>;

/**
 * Which side rang. Defaults to "incoming" - every entry before 0134 was one,
 * and an older reading of this same call log still only ever reports those.
 */
export const MissedCallDirection = z.enum(["incoming", "outgoing"]);
export type MissedCallDirection = z.infer<typeof MissedCallDirection>;

/** Entries per request. The handset pages its backlog at this size. */
export const MISSED_CALLS_BATCH_MAX = 200;

export const MissedCallEntry = z
  .object({
    /**
     * Stable per call-log entry - the handset sends `missed-<epoch ms>` of the
     * entry's DATE. A replay of a batch whose response never arrived is then a
     * no-op per entry, not a duplicate call.
     */
    idempotencyKey: z.string().min(1).max(80),
    /** When it rang: the call log's DATE, as an ISO instant. */
    startedAt: z.string().datetime({ offset: true }),
    direction: MissedCallDirection.default("incoming"),
    reason: MissedCallReason,
    /** Optional, and absent rather than null - the same rule as CreateCallRequest. */
    remoteNumber: z.string().max(40).optional(),
    remoteName: z.string().max(120).optional(),
  })
  // Kept in lockstep with the DB's calls_missed_reason_shape_check (0134): a
  // reason that does not match its own direction is rejected at the door
  // rather than trusted to the constraint to catch, which would fail the
  // whole batch's transaction instead of just this one entry.
  .refine(
    (entry) =>
      entry.direction === "outgoing" ? entry.reason === "no_answer" : entry.reason !== "no_answer",
    { message: "reason does not match direction", path: ["reason"] },
  );
export type MissedCallEntry = z.infer<typeof MissedCallEntry>;

export const MissedCallsRequest = z.object({
  calls: z.array(MissedCallEntry).min(1).max(MISSED_CALLS_BATCH_MAX),
});
export type MissedCallsRequest = z.infer<typeof MissedCallsRequest>;

export const MissedCallsResponse = z.object({
  /** New rows written. */
  accepted: z.number().int(),
  /** Entries this device had already sent - replays, not errors. */
  duplicates: z.number().int(),
  /** Entries refused on their own merits (a start time in the future). */
  skipped: z.number().int(),
});
export type MissedCallsResponse = z.infer<typeof MissedCallsResponse>;

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
 * (`/instances/:id/keys`), and since migration 0107 a client does it for a
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
