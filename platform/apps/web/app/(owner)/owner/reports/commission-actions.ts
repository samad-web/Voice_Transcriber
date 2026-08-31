"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";

/**
 * Commission plans (Phase 4). Same shape as products/actions.ts: the tenant
 * is re-resolved from the session via ownerHeaders() on every call, never
 * trusted from the client, and every mutation revalidates the reports page
 * it feeds — the same page renders both the plan list and the commission
 * report computed from it.
 */

export interface CommissionPlan {
  id: string;
  workspace_id: string | null;
  name: string;
  metric: "won_value" | "won_count" | "calls";
  rate_type: "percent" | "flat_per_unit";
  /** Postgres numeric — comes back as a string. Number() before formatting. */
  rate: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CommissionPlanInput {
  name: string;
  metric: CommissionPlan["metric"];
  rateType: CommissionPlan["rate_type"];
  rate: number;
  active?: boolean;
}

export type CommissionPlanPatch = Partial<CommissionPlanInput>;

async function message(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({}));
  const detail = (body as { message?: unknown }).message;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (typeof d === "string" ? d : ((d as { message?: string }).message ?? "")))
      .join("; ");
  }
  return typeof detail === "string" ? detail : `API ${res.status}`;
}

export async function createCommissionPlanAction(
  input: CommissionPlanInput,
): Promise<{ plan?: CommissionPlan; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/commission-plans`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: await message(res) };
    const data = (await res.json()) as { plan: CommissionPlan };
    revalidatePath("/owner/reports");
    return { plan: data.plan };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function updateCommissionPlanAction(
  id: string,
  patch: CommissionPlanPatch,
): Promise<{ plan?: CommissionPlan; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/commission-plans/${id}`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { error: await message(res) };
    const data = (await res.json()) as { plan: CommissionPlan };
    revalidatePath("/owner/reports");
    return { plan: data.plan };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function deleteCommissionPlanAction(id: string): Promise<{ error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/commission-plans/${id}`, {
      method: "DELETE",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await message(res) };
    revalidatePath("/owner/reports");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
