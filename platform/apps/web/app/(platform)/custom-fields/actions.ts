"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/operator-guard";
import { adminHeaders, API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Server actions for the custom-fields admin console (CRM Phase 1, E0.2).
 * Same shape as (platform)/crm/actions.ts deliberately — `requireOperator()`
 * is the first statement of every export, not merely gated by the layout;
 * see that file's `call()` and lib/operator-guard.ts for why.
 */

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
      const message = payload?.message;
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

function refresh() {
  revalidatePath("/custom-fields");
}

export async function createFieldAction(input: {
  objectType: "contact" | "account" | "deal";
  key: string;
  label: string;
  type: "text" | "number" | "date" | "boolean" | "picklist" | "multiselect" | "lookup";
  description?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  lookupObjectType?: "contact" | "account" | "deal";
  orgId?: string;
}): Promise<{ error?: string }> {
  await requireOperator();
  const { orgId, ...body } = input;
  const res = await call("/v1/custom-field-definitions", { method: "POST", body, orgId });
  if (res.error) return { error: res.error };
  refresh();
  return {};
}

export async function archiveFieldAction(id: string, orgId?: string): Promise<{ error?: string }> {
  await requireOperator();
  const res = await call(`/v1/custom-field-definitions/${id}`, { method: "DELETE", orgId });
  if (res.error) return { error: res.error };
  refresh();
  return {};
}
