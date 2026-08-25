"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/operator-guard";
import { adminHeaders, API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Automation rules (PRD Layer 2). Operator console, alongside /custom-fields
 * and /roles — the other two org-configuration surfaces.
 *
 * Same shape as (platform)/custom-fields/actions.ts deliberately, including
 * `requireOperator()` as the first statement of every export rather than
 * relying on the layout: a server action is its own entry point.
 */

export interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  conditions: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  status: "active" | "paused";
  run_count: string | number;
  last_run_at: string | null;
  created_at: string;
}

export interface AutomationRun {
  id: string;
  rule_id: string;
  rule_name: string;
  subject_type: string;
  subject_id: string;
  matched: boolean;
  outcome: Array<{ type: string; ok: boolean; detail?: string }>;
  error: string | null;
  created_at: string;
}

async function call<T>(
  path: string,
  init: { method: string; body?: unknown; orgId?: string },
): Promise<{ data?: T; error?: string }> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: init.method,
      headers: init.orgId ? orgHeaders(init.orgId) : adminHeaders,
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

export async function createAutomationAction(input: {
  orgId?: string;
  name: string;
  description?: string | null;
  trigger: string;
  conditions?: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  status?: "active" | "paused";
}): Promise<{ error?: string }> {
  await requireOperator();
  const { orgId, ...body } = input;
  const res = await call("/v1/automations", { method: "POST", body, orgId });
  if (!res.error) revalidatePath("/automations");
  return { error: res.error };
}

export async function updateAutomationAction(
  id: string,
  input: Record<string, unknown> & { orgId?: string },
): Promise<{ error?: string }> {
  await requireOperator();
  const { orgId, ...body } = input;
  const res = await call(`/v1/automations/${id}`, { method: "PATCH", body, orgId });
  if (!res.error) revalidatePath("/automations");
  return { error: res.error };
}

export async function deleteAutomationAction(
  id: string,
  orgId?: string,
): Promise<{ error?: string }> {
  await requireOperator();
  const res = await call(`/v1/automations/${id}`, { method: "DELETE", orgId });
  if (!res.error) revalidatePath("/automations");
  return { error: res.error };
}
