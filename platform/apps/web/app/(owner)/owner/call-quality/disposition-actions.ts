"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

export interface Disposition {
  id: string;
  key: string;
  label: string;
  lead_quality: "hot" | "medium" | "cold" | null;
  color: string;
  sort_order: number;
  is_active: boolean;
}

/**
 * Editing the outcome vocabulary (migration 0097).
 *
 * Both paths revalidate the CALL LOG as well as this page: the pickers there
 * are rendered from this list, and an outcome retired here that kept appearing
 * on the drawer until somebody hard-refreshed would be a settings page nobody
 * trusts.
 */
const TOUCHED = ["/owner/call-quality", "/owner/calls"];

export async function createDispositionAction(input: {
  label: string;
  leadQuality?: string | null;
  color?: string;
  sortOrder?: number;
}): Promise<{ disposition?: Disposition; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/owner/call-dispositions`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const body = (await res.json()) as { disposition: Disposition };
    for (const path of TOUCHED) revalidatePath(path);
    return { disposition: body.disposition };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function updateDispositionAction(
  id: string,
  update: Record<string, unknown>,
): Promise<{ error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/owner/call-dispositions/${id}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(update),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    for (const path of TOUCHED) revalidatePath(path);
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
