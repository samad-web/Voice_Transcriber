"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { LIST_DEFINITIONS, viewQueryFrom, type ListKey, type SavedView } from "@/lib/list-views";
import { errorText, ownerHeaders } from "../actions";

/**
 * Saved views (migration 0108) - a person's named filters for one list.
 *
 * The API narrows every statement to the signed-in person, so these actions
 * pass no user id; `ownerHeaders()` resolves it from the session, never from
 * the client. The query is re-normalised HERE against the list's whitelist
 * (lib/list-views.ts), whatever the browser sent - a server action is a public
 * endpoint.
 */

export interface SavedViewResult {
  error?: string;
  view?: SavedView;
}

export async function createSavedViewAction(
  list: ListKey,
  name: string,
  query: Record<string, string>,
): Promise<SavedViewResult> {
  if (!(list in LIST_DEFINITIONS)) return { error: "Unknown list" };
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/saved-views`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ list, name, query: viewQueryFrom(list, query) }),
    });
    if (!res.ok) return { error: await errorText(res) };
    const data = (await res.json()) as { view: SavedView };
    revalidatePath(LIST_DEFINITIONS[list].path);
    return { view: data.view };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function renameSavedViewAction(list: ListKey, id: string, name: string): Promise<SavedViewResult> {
  if (!(list in LIST_DEFINITIONS)) return { error: "Unknown list" };
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/saved-views/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return { error: await errorText(res) };
    const data = (await res.json()) as { view: SavedView };
    revalidatePath(LIST_DEFINITIONS[list].path);
    return { view: data.view };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function deleteSavedViewAction(list: ListKey, id: string): Promise<{ error?: string }> {
  if (!(list in LIST_DEFINITIONS)) return { error: "Unknown list" };
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/saved-views/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await errorText(res) };
    revalidatePath(LIST_DEFINITIONS[list].path);
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
