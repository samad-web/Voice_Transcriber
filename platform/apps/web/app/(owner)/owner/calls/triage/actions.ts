"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../../actions";

export interface UnmatchedCall {
  id: string;
  direction: "incoming" | "outgoing";
  started_at: string;
  duration_s: number;
  status: string;
  remote_name: string | null;
  remote_number_prefix: string | null;
  remote_number_last3: string | null;
  has_number: boolean;
  telecaller: string | null;
  summary: string | null;
  lead_link_dismissed_at: string | null;
  lead_link_dismiss_note: string | null;
  dismissed_by: string | null;
}

export interface CandidateLead {
  id: string;
  title: string;
  contact_name: string | null;
  stage: string;
  status: string;
  contact_number_prefix: string | null;
  contact_number_last3: string | null;
  last_activity_at: string;
  same_number: boolean;
}

export interface TriageCounts {
  unmatched: number;
  dismissed: number;
  linked: number;
}

export interface ActionResult {
  error?: string;
  leadId?: string;
}

/**
 * The three verbs, plus the undo.
 *
 * Each one is a POST to `/v1/owner/call-triage/:id/...` rather than a PATCH
 * carrying a state, because they are not the same operation with a different
 * argument: Link needs a lead, Create makes one, Dismiss records a person's
 * judgement. A single endpoint taking `{action}` would have to validate three
 * disjoint bodies and would lose the route-level pinning guard-mounting.spec.ts
 * gives every one of them.
 */
async function post(path: string, body?: unknown): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/call-triage/${path}`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      // The API's own message where it sent one - "call is not in the
      // unmatched queue" tells a person what happened; "API 404" does not.
      const detail = await res
        .json()
        .then((j: { message?: string | string[] }) =>
          Array.isArray(j.message) ? j.message.join(", ") : j.message,
        )
        .catch(() => undefined);
      return { error: detail ?? `API ${res.status}` };
    }
    const json = (await res.json().catch(() => ({}))) as { leadId?: string };
    revalidatePath("/owner/calls/triage");
    return { leadId: json.leadId };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function linkCallAction(callId: string, leadId: string): Promise<ActionResult> {
  return post(`${callId}/link`, { leadId });
}

export async function createLeadFromCallAction(
  callId: string,
  title?: string,
): Promise<ActionResult> {
  return post(`${callId}/create-lead`, title ? { title } : {});
}

export async function dismissCallAction(callId: string, note?: string): Promise<ActionResult> {
  return post(`${callId}/dismiss`, note ? { note } : {});
}

export async function restoreCallAction(callId: string): Promise<ActionResult> {
  return post(`${callId}/restore`);
}

/**
 * Leads this call could belong to.
 *
 * A server action rather than a client fetch so the admin key never reaches
 * the browser - the same reason every read on this console goes through
 * `ownerGet`. Returns [] on failure: the picker degrades to "type a search and
 * nothing came back", which is recoverable, rather than throwing inside a
 * modal.
 */
export async function searchCandidatesAction(
  callId: string,
  q: string,
): Promise<{ leads: CandidateLead[] }> {
  const headers = await ownerHeaders();
  if (!headers) return { leads: [] };

  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  try {
    const res = await fetch(
      `${API_URL}/v1/owner/call-triage/${callId}/candidates?${params.toString()}`,
      { headers, cache: "no-store" },
    );
    if (!res.ok) return { leads: [] };
    return (await res.json()) as { leads: CandidateLead[] };
  } catch {
    return { leads: [] };
  }
}
