import { z } from "zod";

/**
 * Pipeline state machine - the database is the source of truth (design doc §6.2).
 *
 * Order and membership mirror `calls_status_check` as migration 0014 redefines
 * it, value for value, so the two read side by side in a diff. enums.test.ts
 * asserts that against the migration itself: this file is what every fixture is
 * built from, so a union that omits a live status produces tests that pass while
 * the code is wrong.
 */
export const CallStatus = z.enum([
  "AWAITING_AUDIO",
  "UPLOADED",
  "TRANSCODING",
  "TRANSCRIBING",
  "ANALYZING",
  "SYNCING",
  "COMPLETE",
  // Transcription switched off for the instance (0014): terminal, but not a
  // failure - the call row and its audio are complete, only the paid stages
  // were skipped. Written at worker pipeline.ts.
  "TRANSCRIPTION_OFF",
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

/** Result of the enrollment capture probe - feeds the certified-device matrix. */
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

/**
 * Outbox delivery state - `crm_sync_log_status_check` as 0008 redefines it.
 *
 * 'dead' is the NORMAL terminal state, not an edge case: the outbox writes it
 * for a terminal 4xx and for an exhausted attempt budget (worker outbox.ts), and
 * it is what distinguishes "gave up" from a 'failed'/'pending' delivery still
 * awaiting retry. Omitting it here made every fixture built from this file
 * describe a state machine the worker does not have.
 */
export const CrmSyncStatus = z.enum(["pending", "synced", "failed", "dead"]);
export type CrmSyncStatus = z.infer<typeof CrmSyncStatus>;
