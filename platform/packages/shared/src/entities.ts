import { z } from "zod";
import {
  CallDirection,
  CallStatus,
  CaptureCapability,
  ConsentStatus,
  CrmSyncStatus,
  DeviceStatus,
} from "./enums";
import { ExtractionSchema } from "./extraction";

export const Agent = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  /** Agents are versioned and immutable — editing creates a new version. */
  version: z.number().int().positive(),
  systemPrompt: z.string().max(20000),
  fieldSchema: ExtractionSchema,
  labels: z.array(z.string().max(60)).max(32).default([]),
  scoring: z.record(z.string(), z.number()).default({}),
  crmMapping: z.record(z.string(), z.string()).default({}),
  isActive: z.boolean().default(false),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof Agent>;

export const Device = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  label: z.string().max(120),
  model: z.string().max(120),
  osVersion: z.string().max(60),
  appVersion: z.string().max(40),
  status: DeviceStatus,
  captureCapability: CaptureCapability,
  lastSeenAt: z.string().nullable(),
});
export type Device = z.infer<typeof Device>;

export const DeviceHealth = z.object({
  deviceId: z.string().uuid(),
  ts: z.string(),
  batteryOptExempt: z.boolean(),
  accessibilityEnabled: z.boolean(),
  batteryLevel: z.number().int().min(0).max(100),
  pendingUploads: z.number().int().min(0),
  freeStorageMb: z.number().int().min(0),
  lastUploadAt: z.string().nullable(),
});
export type DeviceHealth = z.infer<typeof DeviceHealth>;

export const TranscriptSegment = z.object({
  speaker: z.string().max(40),
  text: z.string(),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  confidence: z.number().min(0).max(1).optional(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

export const Call = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  deviceId: z.string().uuid(),
  direction: CallDirection,
  /** Counterparty number is stored hashed by default (HMAC per-org key). */
  remoteNumberMasked: z.string().max(40),
  remoteName: z.string().max(200).nullable(),
  startedAt: z.string(),
  durationS: z.number().int().min(0),
  audioSourceUsed: z.string().max(40),
  status: CallStatus,
  consentStatus: ConsentStatus,
  agentId: z.string().uuid().nullable(),
  agentVersion: z.number().int().positive().nullable(),
  crmSyncStatus: CrmSyncStatus.nullable(),
});
export type Call = z.infer<typeof Call>;
