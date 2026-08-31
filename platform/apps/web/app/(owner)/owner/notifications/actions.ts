"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

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
  kind: "task_assigned" | "task_due" | "deal_stage_changed" | "deal_idle" | "automation";
  title: string;
  body: string | null;
  link_path: string | null;
  deal_id: string | null;
  contact_id: string | null;
  task_id: string | null;
  read_at: string | null;
  created_at: string;
}

export async function fetchNotificationsAction(): Promise<{
  notifications: NotificationRow[];
  unread: number;
  error?: string;
}> {
  const headers = await ownerHeaders();
  if (!headers) return { notifications: [], unread: 0, error: "Not signed in" };

  try {
    const res = await fetch(`${API_URL}/v1/notifications?limit=30`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { notifications: [], unread: 0, error: `API ${res.status}` };
    return (await res.json()) as { notifications: NotificationRow[]; unread: number };
  } catch {
    return { notifications: [], unread: 0, error: "API unreachable" };
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
