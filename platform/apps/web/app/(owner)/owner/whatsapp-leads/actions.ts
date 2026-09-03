"use server";

import { revalidatePath } from "next/cache";
import type { QualificationBand, QualificationDisposition } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * The WhatsApp qualification review queue (migration 0080).
 *
 * Every call re-resolves the owner from the session via ownerHeaders() rather
 * than trusting anything the client passed - the same shape the inbox uses, and
 * the reason a client component can never widen its own scope.
 */

export interface Qualification {
  id: string;
  conversation_id: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  disposition: QualificationDisposition;
  band: QualificationBand;
  score: number;
  intent: string | null;
  rationale: string | null;
  message_count: number;
  extracted_name: string | null;
  extracted_email: string | null;
  extracted_company: string | null;
  extracted_budget: number | null;
  extracted_notes: string | null;
  provider: string | null;
  model: string | null;
  lead_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  peer_address: string;
  peer_label: string | null;
  last_inbound_at: string | null;
}

export async function listQualificationsAction(
  filters: { status?: string; includeJunk?: boolean; limit?: number } = {},
): Promise<{ items?: Qualification[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  const params = new URLSearchParams();
  params.set("status", filters.status ?? "pending");
  if (filters.includeJunk) params.set("includeJunk", "true");
  params.set("limit", String(filters.limit ?? 50));

  try {
    const res = await fetch(`${API_URL}/v1/conversation-qualifications?${params.toString()}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { items: Qualification[] };
    return { items: data.items };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Approve one proposal, creating the lead.
 *
 * The edits are the reviewer's, and they override what the model read. Only
 * fields the person actually changed are sent: an absent field means "keep
 * what the machine proposed", and sending the whole form back would turn every
 * untouched blank into a deliberate null.
 */
export async function approveQualificationAction(
  id: string,
  patch: {
    name?: string;
    phone?: string;
    email?: string;
    company?: string;
    notes?: string;
    value?: number;
  } = {},
): Promise<{ ok?: true; leadId?: string; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/conversation-qualifications/${id}/approve`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(patch),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { lead?: { leadId?: string } };
    revalidatePath("/owner/whatsapp-leads");
    revalidatePath("/owner/inbox");
    return { ok: true, leadId: data.lead?.leadId };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function rejectQualificationAction(
  id: string,
  reason?: string,
): Promise<{ ok?: true; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/conversation-qualifications/${id}/reject`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(reason ? { reason } : {}),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/whatsapp-leads");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}
