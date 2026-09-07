"use server";

import { revalidatePath } from "next/cache";
import type { LeadTemperature } from "@aura/shared";
import { API_URL, orgHeaders } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import type { Lead, LeadCall, LeadCallDetail, Stage } from "./types";

/**
 * Every action re-resolves the owner from the session rather than trusting an
 * org id from the client. A server action is a public endpoint - anything it
 * accepts as an argument, a caller can forge - so the tenant is derived, never
 * passed in.
 */
export async function ownerHeaders(): Promise<Record<string, string> | null> {
  const owner = await getOwner();
  if (!owner) return null;
  return orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });
}

export interface ActionResult {
  error?: string;
}

export interface LeadUpdate {
  stage?: string;
  title?: string;
  contactName?: string | null;
  nextAction?: string | null;
  notes?: string | null;
  valueNum?: number | null;
  /** null clears the label; either way the API stamps it as a human's choice. */
  projectId?: string | null;
  /**
   * Hot / Medium / Cold. Setting one takes the rating off the worker for
   * good; null hands it back, so the two are not interchangeable and the
   * field has to be able to carry an explicit null.
   */
  temperature?: LeadTemperature | null;
}

/** Zod issue arrays and plain messages both arrive under `message`. Shared
 *  with crm-actions.ts, which imports this rather than keeping its own copy. */
export async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  const message = (body as { message?: unknown })?.message;
  if (Array.isArray(message)) {
    return message.map((m: { message?: string }) => m.message ?? "").join("; ");
  }
  return typeof message === "string" ? message : `API ${res.status}`;
}

/**
 * Shared PATCH + parse-error + revalidate shape for updateLeadAction (below)
 * and updateDealAction (crm-actions.ts) - structurally the same operation on
 * two record types, differing only in the endpoint, the payload, and which
 * paths need revalidating after a successful save.
 */
export async function patchRecordAction<T>(
  path: string,
  update: unknown,
  revalidatePaths: string[],
): Promise<ActionResult & { data?: T }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(update),
    });
    if (!res.ok) return { error: await errorText(res) };
    const data = (await res.json()) as T;
    for (const p of revalidatePaths) revalidatePath(p);
    return { data };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Edit a lead - a stage move from the board, or a note from the drawer.
 *
 * The board applies the move optimistically and calls this; on failure it
 * rolls the card back, so the returned error matters.
 */
export async function updateLeadAction(
  leadId: string,
  update: LeadUpdate,
): Promise<ActionResult & { lead?: Partial<Lead> }> {
  const result = await patchRecordAction<{ lead: Partial<Lead> }>(`/v1/leads/${leadId}`, update, [
    "/owner/board",
    "/owner/leads",
    "/owner",
  ]);
  return result.error ? { error: result.error } : { lead: result.data?.lead };
}

/** Lead detail for the drawer: the full record plus its call history. */
export async function fetchLeadAction(
  leadId: string,
): Promise<{ lead?: Lead; calls?: LeadCall[]; stages?: Stage[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/leads/${leadId}`, { headers, cache: "no-store" });
    if (!res.ok) return { error: `API ${res.status}` };
    return (await res.json()) as { lead: Lead; calls: LeadCall[]; stages: Stage[] };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * One call in full - transcript and AI read - for the drawer's transcript panel.
 *
 * Called on expand rather than with the lead: see call-intel.tsx. The 403 is
 * given its own message because it is not a failure, it is an entitlement -
 * `call_intel` is off for this instance - and "API 403" would send an owner to
 * support to be told something the sentence could have said itself.
 */
export async function fetchLeadCallAction(
  leadId: string,
  callId: string,
): Promise<{ detail?: LeadCallDetail; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/leads/${leadId}/calls/${callId}`, {
      headers,
      cache: "no-store",
    });
    if (res.status === 403) {
      return { error: "Call transcripts are not enabled for this instance." };
    }
    if (!res.ok) return { error: `API ${res.status}` };
    return { detail: (await res.json()) as LeadCallDetail };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Put a human name against a handset so the dashboard ranks people.
 *
 * `reassign: true` mints a fresh telecaller identity instead of renaming the
 * current one - use it when the phone has genuinely changed hands, not to
 * fix a typo in the existing holder's name.
 */
export async function setTelecallerNameAction(
  deviceId: string,
  name: string,
  reassign = false,
): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/telecallers/${deviceId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify({ name, reassign }),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/owner");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
