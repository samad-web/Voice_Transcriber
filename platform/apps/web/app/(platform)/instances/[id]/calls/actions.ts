"use server";

import { revalidatePath } from "next/cache";
import { call } from "@/lib/action-call";
import { requireOperator } from "@/lib/operator-guard";

/**
 * Every action below is called from the drawer, which now opens over calls
 * belonging to any tenant - not just the environment's DEV_ORG_ID. Omitting
 * `orgId` keeps the old dev-org behaviour for the standalone /calls page;
 * passing it is what makes the instance-scoped explorer work at all, since
 * reading a call under the wrong org context is a 404 under RLS.
 *
 * That freedom is exactly why each of these opens with `requireOperator()`.
 * These are the actions that hand back transcripts and presigned recording
 * audio, under an org id the caller chose, using the root admin key - and a
 * Server Action is an independently-addressable POST endpoint, so the
 * `(platform)` layout's operator gate (a render-time check) never runs for one.
 * See lib/operator-guard.ts.
 */

export interface TranscriptSegment {
  speaker?: string | null;
  text: string;
  intent?: string | null;
  startMs?: number | null;
  endMs?: number | null;
}

export interface CallIntelligence {
  summary?: string;
  overall_intent?: string;
  customer_intent?: string;
  agent_intent?: string;
  sentiment?: "positive" | "neutral" | "negative";
  outcome?: string;
  key_points?: string[];
  action_items?: string[];
}

export interface CallFact {
  field_key: string;
  value_text: string | null;
  value_num: number | null;
  value_bool: boolean | null;
}

export interface CallRiskFlag {
  category: string;
  snippet: string;
  severity: "low" | "medium" | "high";
}

export interface CallAnalytics {
  quality_score: number | null;
  quality_criteria: {
    consentDisclosed: boolean;
    scriptAdherence: number;
    professionalism: number;
    conversionSignal: number;
    rationale: string;
  } | null;
  agent_talk_seconds: number | null;
  customer_talk_seconds: number | null;
  talk_ratio: number | null;
  interruption_count: number | null;
  longest_monologue_seconds: number | null;
  risk_flags: CallRiskFlag[];
  has_escalation_risk: boolean;
}

export interface CallDetailData {
  call: {
    id: string;
    direction: "incoming" | "outgoing";
    started_at: string;
    duration_s: number;
    audio_source_used: string | null;
    status: string;
    consent_status: string;
    device_label: string | null;
    crm_status?: string | null;
    pipeline_status?: string | null;
    /** Why the last attempt failed. Set with a FAILED_* status, else null. */
    error_message?: string | null;
    /** Failed pipeline runs so far; 0 once the call completes. */
    pipeline_attempts?: number | null;
    /** When the automatic retry is due. Null means no retry is pending. */
    next_attempt_at?: string | null;
    /**
     * Contact history for the number on the other end. All null when the number
     * was withheld - there is nothing to count, and claiming "first contact"
     * for every anonymous caller would be worse than saying nothing.
     */
    calls_in?: number | null;
    calls_out?: number | null;
    sequence?: number | null;
    is_follow_up?: boolean | null;
  };
  transcript: {
    text: string;
    segments: TranscriptSegment[] | null;
    engine: string | null;
    diarized: boolean;
    intelligence?: CallIntelligence | null;
  } | null;
  aiOutput: {
    output: unknown;
    provider: string | null;
    model: string | null;
    validation_status: string | null;
    agent_version: number | null;
  } | null;
  facts: CallFact[];
  analytics: CallAnalytics | null;
}

export async function getCallDetailAction(
  callId: string,
  orgId?: string,
): Promise<{ detail?: CallDetailData; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<CallDetailData>(`/v1/calls/${callId}`, { method: "GET", orgId });
  if (res.error) return { error: res.error };
  return { detail: res.data };
}

export async function reprocessCallAction(
  callId: string,
  orgId?: string,
): Promise<{ status?: string; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<{ status?: string }>(`/v1/calls/${callId}/reprocess`, {
    method: "POST",
    orgId,
  });
  if (res.error) return { error: res.error };
  revalidatePath("/calls");
  // The instance-scoped explorer lives under /instances/<org>/calls, so the
  // global path alone would leave that table showing the pre-reprocess status.
  if (orgId) revalidatePath(`/instances/${orgId}/calls`);
  return { status: res.data?.status ?? "queued" };
}

export async function getCallAudioAction(
  callId: string,
  orgId?: string,
): Promise<{ url?: string; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<{ url?: string }>(`/v1/calls/${callId}/audio`, { method: "GET", orgId });
  if (res.error) return { error: res.error };
  return { url: res.data?.url };
}

export interface CallNote {
  id: string;
  body: string;
  author: string | null;
  created_at: string;
}

export async function getCallNotesAction(
  callId: string,
  orgId?: string,
): Promise<{ notes?: CallNote[]; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<{ notes?: CallNote[] }>(`/v1/calls/${callId}/notes`, {
    method: "GET",
    orgId,
  });
  if (res.error) return { error: res.error };
  return { notes: res.data?.notes ?? [] };
}

export async function addCallNoteAction(
  callId: string,
  body: string,
  orgId?: string,
): Promise<{ note?: CallNote; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<{ note?: CallNote }>(`/v1/calls/${callId}/notes`, {
    method: "POST",
    body: { body },
    orgId,
  });
  if (res.error) return { error: res.error };
  return { note: res.data?.note };
}
