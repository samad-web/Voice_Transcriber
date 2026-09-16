"use server";

import { revalidatePath } from "next/cache";
import type { LeadSourceKind, LeadSourceStatus } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * Server actions for the lead intake engine (migration 0078).
 *
 * The intake TOKEN never round-trips through the browser as a secret to be
 * protected - it is public by construction, since a web-form token ships in the
 * tenant's own HTML. What does stay server-side is the admin key, exactly as
 * everywhere else in this console: `ownerHeaders()` is read here and never
 * reaches the client bundle.
 */

export interface LeadSourceDraft {
  kind: LeadSourceKind;
  name: string;
  provider?: string;
  config?: Record<string, unknown>;
  signingSecret?: string | null;
  marketingSourceId?: string | null;
  projectId?: string | null;
  assignedTelecallerId?: string | null;
}

/**
 * A new source changes what the board can show, and a paused one changes
 * whether leads arrive at all - so both pages that render a channel are
 * revalidated, not just this one.
 */
const TOUCHED = ["/owner/lead-sources", "/owner/leads", "/owner/board"];

async function call<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ data?: T; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method,
      headers,
      cache: "no-store",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    return { data: (await res.json()) as T };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function createLeadSourceAction(draft: LeadSourceDraft) {
  const result = await call<{ id: string; intakeToken: string; endpointPath: string | null }>(
    "/v1/lead-sources",
    { method: "POST", body: draft },
  );
  if (result.data) for (const path of TOUCHED) revalidatePath(path);
  return result;
}

export async function updateLeadSourceAction(
  id: string,
  patch: Partial<LeadSourceDraft> & { status?: LeadSourceStatus },
) {
  const result = await call<{ ok: true }>(`/v1/lead-sources/${id}`, {
    method: "PATCH",
    body: patch,
  });
  if (result.data) for (const path of TOUCHED) revalidatePath(path);
  return result;
}

/**
 * Deliberately its own action rather than a field on the patch: rotating
 * breaks every live form and vendor callback on that source immediately, which
 * is the point when a token has leaked, and not something a form that
 * round-trips the whole object should be able to trigger by accident.
 */
export async function rotateLeadSourceTokenAction(id: string) {
  const result = await call<{ intakeToken: string; endpointPath: string | null }>(
    `/v1/lead-sources/${id}/rotate-token`,
    { method: "POST" },
  );
  if (result.data) revalidatePath("/owner/lead-sources");
  return result;
}

export interface IntakeEvent {
  id: string;
  channel: string;
  external_id: string | null;
  outcome: "created" | "updated" | "duplicate" | "rejected" | "error";
  reason: string | null;
  payload: Record<string, unknown>;
  lead_id: string | null;
  lead_title: string | null;
  received_at: string;
  processed_at: string | null;
}

export async function listIntakeEventsAction(sourceId: string, outcome?: string) {
  const query = outcome ? `?outcome=${encodeURIComponent(outcome)}` : "";
  return call<{ events: IntakeEvent[] }>(`/v1/lead-sources/${sourceId}/events${query}`, {
    method: "GET",
  });
}

/**
 * Re-run one stored arrival after fixing a field mapping.
 *
 * The API refuses to replay an event that already produced a lead, so
 * double-clicking this cannot duplicate anybody.
 */
export async function replayIntakeEventAction(eventId: string) {
  const result = await call<{ outcome: string; reason: string | null; leadId: string | null }>(
    `/v1/lead-sources/events/${eventId}/replay`,
    { method: "POST" },
  );
  if (result.data) for (const path of TOUCHED) revalidatePath(path);
  return result;
}

export async function startLinkedInConnectAction() {
  const result = await call<{ authorizeUrl: string }>("/v1/linkedin/oauth/start", {
    method: "POST",
  });
  // 503 is the documented "no LinkedIn app registered on this deployment"
  // answer, not a failure to report as one - the page renders a different
  // message for it.
  if (result.error?.includes("not configured")) return { notConfigured: true as const };
  return result;
}
