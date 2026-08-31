"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/operator-guard";
import { adminHeaders, API_URL, orgHeaders } from "@/lib/server-api";
import type { PermissionGrant, PermissionGrantRow, Role } from "./types";

/**
 * Server actions for the roles/permissions admin console (CRM Phase 1,
 * E0.4). Same shape as (platform)/crm/actions.ts and (platform)/
 * custom-fields/actions.ts - `requireOperator()` is the first statement of
 * every export; see lib/operator-guard.ts for why that can't live in the
 * layout instead.
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
    return { error: "API unreachable - is the API running?" };
  }
}

function refresh() {
  revalidatePath("/roles");
}

export async function createRoleAction(input: {
  key: string;
  name: string;
  description?: string;
  orgId?: string;
}): Promise<{ error?: string; role?: Role }> {
  await requireOperator();
  const { orgId, ...body } = input;
  const res = await call<{ role: Role }>("/v1/roles", { method: "POST", body, orgId });
  if (res.error) return { error: res.error };
  refresh();
  return { role: res.data?.role };
}

export async function fetchRolePermissionsAction(
  roleId: string,
  orgId?: string,
): Promise<{ error?: string; grants?: PermissionGrantRow[] }> {
  await requireOperator();
  const res = await call<{ grants: PermissionGrantRow[] }>(`/v1/roles/${roleId}/permissions`, {
    method: "GET",
    orgId,
  });
  if (res.error) return { error: res.error };
  return { grants: res.data?.grants ?? [] };
}

export async function saveRolePermissionsAction(
  roleId: string,
  grants: PermissionGrant[],
  orgId?: string,
): Promise<{ error?: string }> {
  await requireOperator();
  const res = await call(`/v1/roles/${roleId}/permissions`, {
    method: "PUT",
    body: { grants },
    orgId,
  });
  if (res.error) return { error: res.error };
  refresh();
  return {};
}
