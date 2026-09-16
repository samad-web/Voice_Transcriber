"use server";

import { revalidatePath } from "next/cache";
import type { NotificationKind } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * The signed-in user's own notifications (migration 0048).
 *
 * Every one of these re-resolves the caller from the session via
 * `ownerHeaders()` - a server action is a public endpoint, so an id passed in
 * from the client would be an id anybody could pass in. The API then scopes
 * every query to that user; there is no route that reads somebody else's.
 */

export interface NotificationRow {
  id: string;
  /** A string, not only NotificationKind: a newer worker may write a kind this console predates. */
  kind: NotificationKind | (string & {});
  title: string;
  body: string | null;
  link_path: string | null;
  deal_id: string | null;
  contact_id: string | null;
  task_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationList {
  notifications: NotificationRow[];
  unread: number;
  /** Rows waiting for this person's digest hour (0109) - not listed, not counted as unread. */
  held: number;
  nextDeliveryAt: string | null;
  error?: string;
}

const EMPTY: NotificationList = { notifications: [], unread: 0, held: 0, nextDeliveryAt: null };

export async function fetchNotificationsAction(): Promise<NotificationList> {
  const headers = await ownerHeaders();
  if (!headers) return { ...EMPTY, error: "Not signed in" };

  try {
    const res = await fetch(`${API_URL}/v1/notifications?limit=30`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { ...EMPTY, error: `API ${res.status}` };
    const data = (await res.json()) as Partial<NotificationList>;
    return {
      notifications: data.notifications ?? [],
      unread: data.unread ?? 0,
      // Absent from an API deployed before 0109: nothing is held there.
      held: data.held ?? 0,
      nextDeliveryAt: data.nextDeliveryAt ?? null,
    };
  } catch {
    return { ...EMPTY, error: "API unreachable" };
  }
}

export async function markNotificationReadAction(id: string): Promise<{ error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in" };

  try {
    const res = await fetch(`${API_URL}/v1/notifications/${id}/read`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/owner");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

export async function markAllNotificationsReadAction(): Promise<{ error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in" };

  try {
    const res = await fetch(`${API_URL}/v1/notifications/read-all`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/owner");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

export interface NotificationPreferences {
  digestKinds: NotificationKind[];
  digestHour: number;
  nextDigestAt: string | null;
  held: number;
}

/**
 * Instant vs digest, per kind. Nothing here sends anything anywhere: a digest
 * is the same in-app rows, shown together at the chosen hour.
 */
export async function saveNotificationPreferencesAction(input: {
  digestKinds: NotificationKind[];
  digestHour: number;
}): Promise<{ preferences?: NotificationPreferences; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in" };

  try {
    const res = await fetch(`${API_URL}/v1/notifications/preferences`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/notifications");
    return { preferences: (await res.json()) as NotificationPreferences };
  } catch {
    return { error: "API unreachable" };
  }
}

/** Owner/manager only - the API refuses everyone else, and so does the page. */
export async function saveResponseSlaAction(minutes: number): Promise<{ minutes?: number; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/lead-routing/response-sla`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ minutes }),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/notifications");
    return (await res.json()) as { minutes: number };
  } catch {
    return { error: "API unreachable" };
  }
}
