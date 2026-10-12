"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders, type ActionResult } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * Asking for a plan change, and starting a trial (§9.5, §9.6).
 *
 * ── NOTHING HERE CHARGES ANYBODY ────────────────────────────────────────────
 *
 * There is no payment provider (the project owner's decision, 2026-10-10). An
 * upgrade creates a `plan_change_requests` row and notifies the operator, who
 * applies it in /admin. When a provider exists, its webhook resolves the same
 * row and nothing in this file changes.
 */
export async function requestPlanChangeAction(input: {
  kind: "upgrade" | "downgrade" | "cancel" | "demo";
  planKey?: string;
  note?: string;
}): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/insights/plan/request`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/plan");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

export async function startTrialAction(planKey: string): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/insights/plan/trial`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ planKey }),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    // Every surface a plan governs. The entitlement cache is invalidated by
    // the API within seconds (§9.6), so these paths re-render against the new
    // tier rather than the old one.
    revalidatePath("/owner/plan");
    revalidatePath("/owner/kpi");
    revalidatePath("/owner/settings/performance");
    revalidatePath("/owner/api-platform");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
