"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/operator-guard";
import { getPrincipal, isOperator } from "@/lib/owner-context";
import { API_URL, crossTenantHeaders, orgHeaders } from "@/lib/server-api";
import type {
  CallIssueCategory,
  CallIssueResolution,
  CallIssueSeverity,
  CallIssueStatus,
} from "@aura/shared";

/**
 * The escalation queue's Server Actions (0147, doc 36 §13).
 *
 * EVERY exported function here calls `requireOperator()` FIRST, inline, as its
 * first statement. A Server Action is an independently-addressable POST endpoint
 * - the `(platform)` layout's operator check gates rendering, not invocation -
 * and these send the root ADMIN_API_KEY across every tenant.
 *
 * It is written out at the top of each function rather than hidden in a wrapper
 * ON PURPOSE: `platform-actions.guard.test.ts` scans this file's SOURCE for the
 * call, and doc 34 records a wrapper blinding exactly that test to seven pages.
 */

export interface Escalation {
  id: string;
  ref: number;
  org_id: string;
  org_name: string;
  call_id: string;
  category: CallIssueCategory;
  severity: CallIssueSeverity;
  status: CallIssueStatus;
  description: string;
  at_seconds: number | null;
  reported_by_name: string;
  reported_by_role: string;
  reported_at: string;
  acknowledged_at: string | null;
  acknowledged_by_email: string | null;
  assigned_to_email: string | null;
  resolution: CallIssueResolution | null;
  resolved_at: string | null;
  resolved_by_email: string | null;
  client_confirmed_at: string | null;
  reprocess_count: number;
  last_reprocess_at: string | null;
  duplicate_of: string | null;
  snap_call_status: string;
  snap_call_started_at: string;
  snap_duration_s: number;
  snap_direction: string;
  call_access_gate_enabled: boolean;
}

/** The detail adds the rest of the snapshot and the call's CURRENT state. */
export interface EscalationDetail extends Escalation {
  snap_pipeline_attempts: number;
  snap_device_id: string | null;
  snap_audio_source_used: string | null;
  snap_agent_id: string | null;
  snap_agent_version: number | null;
  snap_recording_s3_key: string | null;
  snap_recording_bytes: number | null;
  snap_recording_sha256: string | null;
  snap_recording_codec: string | null;
  snap_recording_sample_rate: number | null;
  snap_asr_engine: string | null;
  snap_asr_language: string | null;
  snap_asr_diarized: boolean | null;
  snap_asr_confidence: number | null;
  snap_transcript_chars: number | null;
  snap_transcript_md5: string | null;
  access_request_id: string | null;
  live_call_status: string;
  live_pipeline_attempts: number;
}

export interface EscalationEvent {
  id: string;
  kind: string;
  visibility: "internal" | "client";
  actor_type: "user" | "operator" | "system";
  actor_id: string;
  actor_name: string | null;
  body: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export interface ContentAccess {
  gateEnabled: boolean;
  live: boolean;
  grantEndsAt: string | null;
  requestId: string | null;
}

export interface EscalationStats {
  unacknowledged: number;
  live: number;
  blocking: number;
  awaiting_client: number;
  resolved_7d: number;
  reprocessed_30d: number;
  oldest_unacknowledged_hours: number | null;
}

/**
 * The one fetch these actions make.
 *
 * NOT `lib/action-call.ts`'s `call()`, and the difference matters: that helper
 * attaches `x-operator-email` only when it is given an `orgId`, because it was
 * written for per-tenant pages. Every route here is CROSS-tenant and every write
 * refuses without that header, so a cross-tenant `call()` would 403 each of them.
 */
async function queueFetch<T>(
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<{ data?: T; error?: string; status?: number }> {
  const principal = await getPrincipal().catch(() => null);
  const operatorEmail = isOperator(principal) ? (principal?.email ?? null) : null;

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method,
      headers: {
        ...crossTenantHeaders,
        ...(operatorEmail ? { "x-operator-email": operatorEmail } : {}),
      },
      cache: "no-store",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (payload as { message?: unknown }).message;
      const text = Array.isArray(message)
        ? message.map((m: { message?: string }) => m.message ?? "").join("; ")
        : ((message as string) ?? JSON.stringify(payload));
      return { error: `API ${res.status}: ${text}`, status: res.status };
    }
    return { data: payload as T, status: res.status };
  } catch {
    return { error: "API unreachable - is the API running?" };
  }
}

export async function listEscalationsAction(filters: {
  state?: string;
  category?: string;
  severity?: string;
  orgId?: string;
  q?: string;
}): Promise<{ reports?: Escalation[]; error?: string }> {
  await requireOperator();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const res = await queueFetch<{ reports: Escalation[] }>(
    `/v1/admin/call-issues?${params.toString()}`,
  );
  return { reports: res.data?.reports, error: res.error };
}

export async function escalationStatsAction(): Promise<{
  stats?: EscalationStats;
  error?: string;
}> {
  await requireOperator();
  const res = await queueFetch<EscalationStats>("/v1/admin/call-issues/stats");
  return { stats: res.data, error: res.error };
}

export async function escalationDetailAction(id: string): Promise<{
  report?: EscalationDetail;
  events?: EscalationEvent[];
  contentAccess?: ContentAccess;
  error?: string;
}> {
  await requireOperator();
  const res = await queueFetch<{
    report: EscalationDetail;
    events: EscalationEvent[];
    contentAccess: ContentAccess;
  }>(`/v1/admin/call-issues/${id}`);
  return { ...res.data, error: res.error };
}

export async function patchEscalationAction(
  id: string,
  body: {
    assignedToEmail?: string | null;
    severity?: CallIssueSeverity;
    status?: CallIssueStatus;
    duplicateOf?: string | null;
  },
): Promise<{ ok?: boolean; error?: string }> {
  await requireOperator();
  const res = await queueFetch(`/v1/admin/call-issues/${id}`, { method: "PATCH", body });
  if (res.error) return { error: res.error };
  revalidatePath("/support");
  return { ok: true };
}

export async function noteEscalationAction(
  id: string,
  body: string,
  visibility: "internal" | "client",
): Promise<{ ok?: boolean; error?: string }> {
  await requireOperator();
  const res = await queueFetch(`/v1/admin/call-issues/${id}/notes`, {
    method: "POST",
    body: { body, visibility },
  });
  if (res.error) return { error: res.error };
  revalidatePath("/support");
  return { ok: true };
}

/**
 * Re-run the call.
 *
 * This is the action that spends money - at the ASR provider and the analyzer,
 * every press - which is the whole reason it is here and not in the customer's
 * console. The confirm dialog in the client component is the only place a reader
 * is told that before it happens.
 */
export async function reprocessEscalationAction(
  id: string,
): Promise<{ ok?: boolean; from?: string; error?: string }> {
  await requireOperator();
  const res = await queueFetch<{ from: string }>(`/v1/admin/call-issues/${id}/reprocess`, {
    method: "POST",
  });
  if (res.error) return { error: res.error };
  revalidatePath("/support");
  return { ok: true, from: res.data?.from };
}

export async function resolveEscalationAction(
  id: string,
  resolution: string,
  note: string,
): Promise<{ ok?: boolean; error?: string }> {
  await requireOperator();
  const res = await queueFetch(`/v1/admin/call-issues/${id}/resolve`, {
    method: "POST",
    body: { resolution, note },
  });
  if (res.error) return { error: res.error };
  revalidatePath("/support");
  return { ok: true };
}

export async function reopenEscalationAction(
  id: string,
  note: string,
): Promise<{ ok?: boolean; error?: string }> {
  await requireOperator();
  const res = await queueFetch(`/v1/admin/call-issues/${id}/reopen`, {
    method: "POST",
    body: { note },
  });
  if (res.error) return { error: res.error };
  revalidatePath("/support");
  return { ok: true };
}

/**
 * Ask the client for permission to hear the recording (migration 0122).
 *
 * Reuses the EXISTING request route rather than inventing a second consent path:
 * the tenant answers on the `/owner/call-access` page they already have, the
 * partial unique index in 0122 collapses this onto any request already open, and
 * the reason names the ticket so the administrator knows what they are approving.
 *
 * This one IS per-tenant, so it goes through `orgHeaders` - the only call in this
 * file that names an org.
 */
export async function requestCallAccessAction(input: {
  orgId: string;
  ref: number;
  category: string;
  days?: number;
}): Promise<{ ok?: boolean; error?: string }> {
  await requireOperator();
  const principal = await getPrincipal().catch(() => null);
  const operatorEmail = isOperator(principal) ? (principal?.email ?? null) : null;
  if (!operatorEmail) return { error: "Only a platform operator can ask for call access." };

  const start = new Date();
  const end = new Date(start.getTime() + (input.days ?? 7) * 24 * 60 * 60 * 1000);

  try {
    const res = await fetch(`${API_URL}/v1/call-access/requests`, {
      method: "POST",
      headers: orgHeaders(input.orgId, { operatorEmail }),
      cache: "no-store",
      body: JSON.stringify({
        reason: `Investigating reported problem AUR-${String(input.ref).padStart(6, "0")} (${input.category})`,
        requestedStart: start.toISOString(),
        requestedEnd: end.toISOString(),
      }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { message?: string };
      return { error: payload.message ?? `API ${res.status}` };
    }
    revalidatePath("/support");
    return { ok: true };
  } catch {
    return { error: "API unreachable - is the API running?" };
  }
}
