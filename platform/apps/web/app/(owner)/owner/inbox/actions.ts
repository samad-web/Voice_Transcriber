"use server";

import { revalidatePath } from "next/cache";
import type { ConversationChannel, ConversationStatus, MessageDirection } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

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
  messaging_channel_id: string | null;
  /**
   * Set when the thread arrived on somebody's own WhatsApp number (0125). The
   * API returns such a thread only to that person, so a non-null value here
   * always means "yours, and nobody else's".
   */
  private_to_user_id: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  unread_count: number;
  /**
   * The provider behind `messaging_channel_id`, for the 24-hour window notice.
   * Null on a thread with no channel attached. It is the PROVIDER's rule, not
   * the medium's, which is why the channel alone cannot answer it.
   */
  channel_provider: string | null;
  /**
   * This person asked to stop being messaged and nobody has released it
   * (migration 0100). The send route refuses, so the composer must not offer a
   * Send button that is going to 403.
   */
  opted_out: boolean;
  /**
   * The org has a reply drafter switched on (migration 0121), so the composer
   * offers "Draft reply". Only on a thread fetched one at a time; the list does
   * not carry it.
   */
  reply_drafter_active?: boolean;
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

export interface WasiTemplate {
  name: string;
  status: string;
  category?: string;
  language?: string;
}

export interface InboxFilters {
  status?: ConversationStatus;
  unmatchedOnly?: boolean;
  limit?: number;
  /** Rows to skip - the thread list's pager (CRM dashboard Phase 8). */
  offset?: number;
}

/**
 * The inbox list.
 *
 * Every call re-resolves the owner from the session via ownerHeaders() rather
 * than trusting anything the client passed - the same shape crm-actions.ts
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
  if (filters.offset) params.set("offset", String(filters.offset));

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
      replyDrafterActive?: boolean;
    };
    // Folded onto the conversation so every place that stores a fetched thread
    // carries it without being taught about it.
    return {
      conversation: { ...data.conversation, reply_drafter_active: data.replyDrafterActive === true },
      messages: data.messages,
    };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Route, claim, read or close a thread - plus, since Kailash gap Milestone 3,
 * the one narrow send action below. Safety rule 3 is kept by that action's
 * own shape (whatsapp-send.controller.ts): a human composes it, it goes to
 * the address already on the conversation, and it's off by default behind
 * WHATSAPP_SENDING_ENABLED - not by this file having no mutations at all.
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
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/inbox");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}

/** The channel's Meta-approved WhatsApp templates, for the composer's template picker. */
export async function fetchChannelTemplatesAction(
  channelId: string,
): Promise<{ templates?: WasiTemplate[]; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/messaging/channels/${channelId}/templates`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { templates: WasiTemplate[] };
    return { templates: data.templates };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Send one WhatsApp message into this conversation. See
 * whatsapp-send.controller.ts for the full gate chain this rides on - this
 * action does not duplicate any of it, it just relays whatever the API says
 * (including a friendly 503 when WHATSAPP_SENDING_ENABLED is off, or Wasi's
 * own rejection reason, e.g. an expired 24-hour session window).
 */
export async function sendWhatsAppMessageAction(
  conversationId: string,
  message: { type: "text"; body: string } | { type: "template"; template: string; params: Record<string, string> },
): Promise<{ ok?: true; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(message),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/inbox");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Ask the org's reply drafter (migration 0121) for a reply to this thread.
 *
 * Returns TEXT for the composer. It does not send, and nothing downstream of it
 * does: the person edits the draft and presses Send, which goes through
 * `sendWhatsAppMessageAction` above exactly like anything they typed.
 */
export async function draftReplyAction(conversationId: string): Promise<{ reply?: string; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/conversations/${conversationId}/draft-reply`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { reply: string };
    return { reply: data.reply };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Release an opt-out, because the customer said otherwise (migration 0100).
 *
 * Owner/manager only, enforced by OwnerRoleGuard on the API. The console still
 * gates the button on the viewer's role rather than letting them press it and
 * read a 403 - the same split SetupGate's `canDismiss` uses.
 */
export async function releaseOptOutAction(
  conversationId: string,
): Promise<{ released?: boolean; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/conversations/${conversationId}/opt-out/release`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { released: boolean };
    revalidatePath("/owner/inbox");
    return { released: data.released };
  } catch {
    return { error: "API unreachable" };
  }
}
