"use server";

import { revalidatePath } from "next/cache";
import type { LeadRoutingRuleInput, LeadRoutingTargetInput } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * Every write here changes who leads land on, so the board, the leads list and
 * the dashboard all read differently afterwards. Revalidating only this page
 * would leave a manager looking at a board that still shows the old owner and
 * reporting it as the rule not working.
 */
const TOUCHED = ["/owner/lead-routing", "/owner/leads", "/owner/board", "/owner"];

function revalidate(): void {
  for (const path of TOUCHED) revalidatePath(path);
}

async function call<T>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
): Promise<{ data?: T; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/lead-routing${path}`, {
      method,
      headers,
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidate();
    return { data: (await res.json()) as T };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function createRuleAction(
  draft: LeadRoutingRuleInput,
): Promise<{ data?: { rule: { id: string } }; error?: string }> {
  return call("/rules", "POST", draft);
}

export async function updateRuleAction(
  id: string,
  patch: Partial<LeadRoutingRuleInput>,
): Promise<{ data?: unknown; error?: string }> {
  return call(`/rules/${id}`, "PATCH", patch);
}

export async function deleteRuleAction(id: string): Promise<{ error?: string }> {
  return call(`/rules/${id}`, "DELETE");
}

/**
 * The whole target list, not one row.
 *
 * A percentage split is one value spread across several rows: there is no
 * order of individual edits that gets from 50/30/20 to 40/40/20 without
 * passing through a total that is not 100. Sending the set makes that
 * intermediate state unreachable instead of merely rejected.
 */
export async function setTargetsAction(
  ruleId: string,
  targets: LeadRoutingTargetInput[],
): Promise<{ error?: string }> {
  return call(`/rules/${ruleId}/targets`, "PUT", { targets });
}

export async function resetWindowAction(ruleId: string): Promise<{ error?: string }> {
  return call(`/rules/${ruleId}/reset`, "POST");
}

export interface BackfillResult {
  considered: number;
  assigned: number;
  skipped: Array<{ reason: string; count: number }>;
  remaining: number;
}

export async function backfillAction(
  limit: number,
): Promise<{ data?: BackfillResult; error?: string }> {
  return call<BackfillResult>("/backfill", "POST", { limit });
}
