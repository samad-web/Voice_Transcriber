"use server";

import { revalidatePath } from "next/cache";
import type { ConversationChannel, ConversationStatus, MessageDirection } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

/** One thread in the inbox list. */
export interface Conversation {
  id: string;
  channel: ConversationChannel;
  peer_address: string;
  peer_label: string | null;
  contact_id: string | null;
  contact_name: string | null;
  status: ConversationStatus;
  assigned_user_id: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  unread_count: number;
}

export interface ConversationMessage {
  id: string;
  direction: MessageDirection;
  channel: ConversationChannel;
  status: string;
  from_address: string | null;
  to_address: string | null;
  subject: string | null;
  body: string | null;
  error: string | null;
  occurred_at: string;
}

export interface InboxFilters {
  status?: ConversationStatus;
  unmatchedOnly?: boolean;
  limit?: number;
}

/**
 * The inbox list.
 *
 * Every call re-resolves the owner from the session via ownerHeaders() rather
 * than trusting anything the client passed — the same shape crm-actions.ts
 * uses, and the reason a client component can never widen its own scope.
 */
export async function listConversationsAction(
  filters: InboxFilters = {},
): Promise<{ conversations?: Conversation[]; total?: number; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.unmatchedOnly) params.set("unmatchedOnly", "true");
  params.set("limit", String(filters.limit ?? 50));

  try {
    const res = await fetch(`${API_URL}/v1/conversations?${params.toString()}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as { conversations: Conversation[]; total: number };
    return { conversations: data.conversations, total: data.total };
  } catch {
    return { error: "API unreachable" };
  }
}

/** One thread plus its messages, for the reading pane. */
export async function fetchThreadAction(
  id: string,
): Promise<{ conversation?: Conversation; messages?: ConversationMessage[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/conversations/${id}`, { headers, cache: "no-store" });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json()) as {
      conversation: Conversation;
      messages: ConversationMessage[];
    };
    return { conversation: data.conversation, messages: data.messages };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Route, claim, read or close a thread.
 *
 * Deliberately the only mutation this page has. There is no reply action
 * because there is no reply ROUTE — safety rule 3 keeps sending on the narrow
 * human-composed path, and adding a send here would be the exact hole the
 * rule exists to prevent.
 */
export async function updateConversationAction(
  id: string,
  patch: {
    status?: ConversationStatus;
    assignedUserId?: string | null;
    contactId?: string | null;
    markRead?: boolean;
  },
): Promise<{ ok?: true; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/conversations/${id}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = (body as { message?: unknown })?.message ?? body;
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    revalidatePath("/owner/inbox");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}
