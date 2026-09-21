"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/* ── My WhatsApp: a person's own number, linked from their inbox (0125) ─────
 *
 * Moved here from the WhatsApp Setup page. A personal number used to be one
 * per organisation, linked by an owner; it is now one per PERSON, linked by
 * that person, and its chats are private to them. The inbox is where those
 * chats are read, so it is where the number is linked - and it is a page the
 * people who need this (telecallers, sales) can reach, which Setup was not.
 *
 * Every call carries the signed-in person (`ownerHeaders` sends
 * `x-caller-user-id`), and the API acts only on THAT person's channel. There
 * is no action here that names anybody else.
 */

export interface PersonalWhatsAppStatus {
  /** The DEPLOYMENT can offer this at all - distinct from "you have not done it". */
  available: boolean;
  connected: boolean;
  number: string | null;
  channelId: string | null;
  detail: string | null;
}

export interface PersonalWhatsAppPairing {
  connected: boolean;
  pairingCode?: string | null;
  qrImage?: string | null;
  qrCode?: string | null;
  number: string | null;
  channelId: string | null;
  detail: string | null;
}

/**
 * Returns a fully "not available" shape rather than an error when the API is
 * unreachable: the inbox works without this card, and replacing the whole
 * page with an error because one card could not load is the worse failure.
 */
export async function personalWhatsAppStatusAction(): Promise<PersonalWhatsAppStatus> {
  const offline: PersonalWhatsAppStatus = {
    available: false,
    connected: false,
    number: null,
    channelId: null,
    detail: null,
  };
  const headers = await ownerHeaders();
  if (!headers) return offline;
  try {
    const res = await fetch(`${API_URL}/v1/messaging/whatsapp-personal`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return offline;
    return (await res.json()) as PersonalWhatsAppStatus;
  } catch {
    return offline;
  }
}

export async function startPersonalWhatsAppAction(input: {
  phone: string;
  method: "code" | "qr";
}): Promise<{ pairing?: PersonalWhatsAppPairing; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in" };
  try {
    const res = await fetch(`${API_URL}/v1/messaging/whatsapp-personal`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    return { pairing: (await res.json()) as PersonalWhatsAppPairing };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Polled while the person is at their phone.
 *
 * Never returns an error shape: a failed poll is one missed tick, and the
 * caller simply tries again. Surfacing "API unreachable" mid-pairing would put
 * a red banner over a flow that is about to succeed on the next request.
 */
export async function pollPersonalWhatsAppAction(): Promise<{ connected: boolean }> {
  const headers = await ownerHeaders();
  if (!headers) return { connected: false };
  try {
    const res = await fetch(`${API_URL}/v1/messaging/whatsapp-personal/poll`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { connected: false };
    const body = (await res.json()) as { connected?: boolean };
    if (body.connected) revalidatePath("/owner/inbox");
    return { connected: Boolean(body.connected) };
  } catch {
    return { connected: false };
  }
}

export async function disconnectPersonalWhatsAppAction(): Promise<{ ok?: true; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in" };
  try {
    const res = await fetch(`${API_URL}/v1/messaging/whatsapp-personal`, {
      method: "DELETE",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/inbox");
    return { ok: true };
  } catch {
    return { error: "API unreachable" };
  }
}
