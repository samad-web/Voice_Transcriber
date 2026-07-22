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
