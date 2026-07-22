import { z } from "zod";

/** Pipeline state machine — the database is the source of truth (design doc §6.2). */
export const CallStatus = z.enum([
  "AWAITING_AUDIO",
  "UPLOADED",
  "TRANSCODING",
  "TRANSCRIBING",
  "ANALYZING",
  "SYNCING",
  "COMPLETE",
  "FAILED_TRANSCODE",
  "FAILED_ASR",
  "FAILED_ANALYZE",
  "FAILED_CRM",
]);
export type CallStatus = z.infer<typeof CallStatus>;

export const CallDirection = z.enum(["incoming", "outgoing"]);
export type CallDirection = z.infer<typeof CallDirection>;

export const ConsentPolicy = z.enum(["none", "tone", "tone_and_tts", "prohibited"]);
export type ConsentPolicy = z.infer<typeof ConsentPolicy>;

export const ConsentStatus = z.enum(["not_required", "played", "failed", "pending"]);
export type ConsentStatus = z.infer<typeof ConsentStatus>;

export const OnConsentFailure = z.enum(["record_and_flag", "do_not_record"]);
export type OnConsentFailure = z.infer<typeof OnConsentFailure>;

export const DeviceStatus = z.enum(["active", "logged_out", "wiped", "lost"]);
export type DeviceStatus = z.infer<typeof DeviceStatus>;

/** Result of the enrollment capture probe — feeds the certified-device matrix. */
export const CaptureCapability = z.enum([
  "FULL_DUPLEX",
  "NEAR_END_ONLY",
  "SPEAKER_REQUIRED",
  "UNSUPPORTED",
]);
export type CaptureCapability = z.infer<typeof CaptureCapability>;

export const UploadState = z.enum([
  "PENDING",
  "UPLOADING",
  "UPLOADED",
  "FAILED",
  "DISCARDED",
]);
export type UploadState = z.infer<typeof UploadState>;

export const CrmSyncStatus = z.enum(["pending", "synced", "failed"]);
export type CrmSyncStatus = z.infer<typeof CrmSyncStatus>;
