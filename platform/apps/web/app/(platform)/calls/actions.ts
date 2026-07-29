"use server";

import { revalidatePath } from "next/cache";
import { adminHeaders, API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Every action below is called from the drawer, which now opens over calls
 * belonging to any tenant — not just the environment's DEV_ORG_ID. Omitting
 * `orgId` keeps the old dev-org behaviour for the standalone /calls page;
 * passing it is what makes the instance-scoped explorer work at all, since
 * reading a call under the wrong org context is a 404 under RLS.
 */
const headersFor = (orgId?: string) => (orgId ? orgHeaders(orgId) : adminHeaders);

export interface TranscriptSegment {
  speaker?: string | null;
  text: string;
  intent?: string | null;
  start_s?: number | null;
  end_s?: number | null;
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
}

export async function getCallDetailAction(
  callId: string,
  orgId?: string,
): Promise<{ detail?: CallDetailData; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/calls/${callId}`, {
      headers: headersFor(orgId),
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    return { detail: (await res.json()) as CallDetailData };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}

export async function reprocessCallAction(
  callId: string,
  orgId?: string,
): Promise<{ status?: string; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/calls/${callId}/reprocess`, {
      method: "POST",
      headers: headersFor(orgId),
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { status?: string };
    revalidatePath("/calls");
    // The instance-scoped explorer lives under /instances/<org>/calls, so the
    // global path alone would leave that table showing the pre-reprocess status.
    if (orgId) revalidatePath(`/instances/${orgId}/calls`);
    return { status: data.status ?? "queued" };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function getCallAudioAction(
  callId: string,
  orgId?: string,
): Promise<{ url?: string; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/calls/${callId}/audio`, {
      headers: headersFor(orgId),
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { url?: string };
    return { url: data.url };
  } catch {
    return { error: "API unreachable" };
  }
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
    const res = await fetch(`${API_URL}/v1/calls/${callId}/notes`, {
      headers: headersFor(orgId),
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { notes?: CallNote[] };
    return { notes: data.notes ?? [] };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function addCallNoteAction(
  callId: string,
  body: string,
  orgId?: string,
): Promise<{ note?: CallNote; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/calls/${callId}/notes`, {
      method: "POST",
      headers: headersFor(orgId),
      cache: "no-store",
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(b.message ?? b)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { note?: CallNote };
    return { note: data.note };
  } catch {
    return { error: "API unreachable" };
  }
}
