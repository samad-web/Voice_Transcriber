"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/operator-guard";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Sales targets (PRD Layer 5). Operator console, beside /custom-fields,
 * /roles and /automations — the other org-configuration surfaces.
 *
 * `requireOperator()` is the first statement of every export rather than
 * relying on the layout: a server action is its own entry point.
 */

export interface SalesTarget {
  id: string;
  owner_user_id: string | null;
  owner_name: string | null;
  period_start: string;
  period_end: string;
  metric: "won_value" | "won_count";
  target_value: string | number;
  notes: string | null;
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown; orgId: string },
): Promise<{ data?: T; error?: string }> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method,
      headers: orgHeaders(init.orgId),
      cache: "no-store",
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (payload as { message?: unknown })?.message;
      const text = Array.isArray(message)
        ? message
            .map((m: { path?: string[]; message?: string }) =>
              `${m.path?.join(".") ?? ""} ${m.message ?? ""}`.trim(),
            )
            .join("; ")
        : (message ?? JSON.stringify(payload));
      return { error: `API ${res.status}: ${text}` };
    }
    return { data: payload as T };
  } catch {
    return { error: "API unreachable — is the API running?" };
  }
}

export async function createTargetAction(input: {
  orgId: string;
  ownerUserId?: string | null;
  periodStart: string;
  periodEnd: string;
  metric: "won_value" | "won_count";
  targetValue: number;
  notes?: string | null;
}): Promise<{ error?: string }> {
  await requireOperator();
  const { orgId, ...body } = input;
  const res = await call("/v1/targets", { method: "POST", body, orgId });
  if (!res.error) revalidatePath("/targets");
  return { error: res.error };
}

export async function deleteTargetAction(id: string, orgId: string): Promise<{ error?: string }> {
  await requireOperator();
  const res = await call(`/v1/targets/${id}`, { method: "DELETE", orgId });
  if (!res.error) revalidatePath("/targets");
  return { error: res.error };
}
