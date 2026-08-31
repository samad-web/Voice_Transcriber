"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

export interface CallIntegrityFlag {
  id: string;
  call_id: string | null;
  deal_id: string | null;
  flag_type: "no_deal_from_positive_call" | "outcome_status_contradiction" | "stalled_after_positive_call";
  details: Record<string, unknown>;
  status: "open" | "dismissed" | "resolved";
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  call_started_at: string | null;
  call_remote_name: string | null;
  deal_name: string | null;
}

export interface ActionResult {
  error?: string;
}

/**
 * Dismiss ("not actually a problem") or resolve ("fixed it") one flag from
 * apps/worker/src/pipeline/call-crm-integrity.ts's review queue (0070).
 */
export async function resolveCallIntegrityFlagAction(
  id: string,
  status: "dismissed" | "resolved",
): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/call-integrity-flags/${id}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath("/owner/call-quality");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
