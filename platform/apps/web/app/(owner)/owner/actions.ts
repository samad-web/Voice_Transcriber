"use server";

import { revalidatePath } from "next/cache";
import { API_URL, orgHeaders } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import type { Lead, LeadCall, Stage } from "./types";

/**
 * Every action re-resolves the owner from the session rather than trusting an
 * org id from the client. A server action is a public endpoint — anything it
 * accepts as an argument, a caller can forge — so the tenant is derived, never
 * passed in.
 */
async function ownerHeaders(): Promise<Record<string, string> | null> {
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
}

/**
 * Edit a lead — a stage move from the board, or a note from the drawer.
 *
 * The board applies the move optimistically and calls this; on failure it
 * rolls the card back, so the returned error matters.
 */
export async function updateLeadAction(
  leadId: string,
  update: LeadUpdate,
): Promise<ActionResult & { lead?: Partial<Lead> }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/leads/${leadId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(update),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = body?.message ?? body;
      return {
        error: typeof detail === "string" ? detail : `API ${res.status}`,
      };
    }
    const data = (await res.json()) as { lead: Partial<Lead> };
    revalidatePath("/owner/board");
    revalidatePath("/owner/leads");
    revalidatePath("/owner");
    return { lead: data.lead };
  } catch {
    return { error: "API unreachable" };
  }
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

/** Put a human name against a handset so the dashboard ranks people. */
export async function setTelecallerNameAction(
  deviceId: string,
  name: string,
): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/telecallers/${deviceId}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/owner");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
