"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders, type ActionResult } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * The review queue's opt-out verdicts (migration 0109). The WhatsApp and
 * duplicate verdicts reuse the actions their own pages already call
 * (`whatsapp-leads/actions.ts`, `crm-actions.ts`), so there is one definition
 * of what approving a lead or merging two records sends to the API.
 *
 * `done: false` with no error means somebody else decided it first - the card
 * is dropped either way, and the console says so rather than showing a failure.
 */

async function verdict(id: string, action: "confirm" | "dismiss"): Promise<ActionResult & { done?: boolean }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/opt-outs/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { confirmed?: boolean; dismissed?: boolean };
    revalidatePath("/owner/review");
    revalidatePath("/owner/inbox");
    return { done: Boolean(data.confirmed ?? data.dismissed) };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function confirmOptOutAction(id: string) {
  return verdict(id, "confirm");
}

export async function dismissOptOutAction(id: string) {
  return verdict(id, "dismiss");
}
