"use server";

import { revalidatePath } from "next/cache";
import type { OrgFeature, OrgModule, WhatsAppProvider } from "@aura/shared";
import { requireOperator } from "@/lib/operator-guard";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";

/**
 * Provisioning actions for the platform-admin console.
 *
 * ── EVERY EXPORT OPENS WITH requireOperator() ───────────────────────────────
 *
 * The same discipline `(platform)/instances/[id]/actions.ts` documents, and it
 * matters more here, not less: these span EVERY tenant. `(admin)/layout.tsx`
 * decides what a browser is shown; it never runs for a Server Action, which is
 * an independently-addressable POST endpoint. A missing guard on one of these
 * is "any signed-in account can provision themselves a tenant", not "a page
 * looks wrong".
 *
 * They send `crossTenantHeaders` - the admin key with no `x-org-id` - because
 * creating a tenant happens before any org exists to scope to, and the module
 * grid spans tenants by definition.
 */

interface ActionResult {
  error?: string;
}

/** One shape for both calls, so failures read the same way in the UI. */
async function post<T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<{ data?: T; error?: string }> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (payload as { message?: unknown }).message;
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

export interface ProvisionResult extends ActionResult {
  orgId?: string;
  instanceId?: string;
  /** Shown exactly once - only its hash is stored. */
  enrollmentKey?: string;
  expiresAt?: string;
}

/**
 * Provision a whole environment: organization, workspace, first instance and
 * its one-time enrollment key, with modules and features chosen up front.
 *
 * The modules/features go in the CREATE call rather than being patched
 * afterwards because `seedCrmDefaults` runs inside the same transaction - a
 * tenant created without CRM and then granted it in a second request is an org
 * that briefly existed with no roles and no pipeline, and anything that read it
 * in that window (a worker picking up a call, an owner logging straight in) saw
 * a half-built tenant.
 */
export async function provisionTenantAction(input: {
  name: string;
  workspaceName: string;
  region?: string;
  modules: OrgModule[];
  features: OrgFeature[];
  whatsappProvider: WhatsAppProvider;
}): Promise<ProvisionResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }

  const res = await post<{
    tenant: { id: string; instance: { id: string } };
    enrollment: { adminKey: string; expiresAt: string };
  }>("/v1/admin/tenants", "POST", {
    name: input.name,
    workspaceName: input.workspaceName || "Default",
    ...(input.region ? { region: input.region } : {}),
    modules: input.modules,
    features: input.features,
    whatsappProvider: input.whatsappProvider,
  });
  if (res.error) return { error: res.error };

  revalidatePath("/admin");
  return {
    orgId: res.data?.tenant.id,
    instanceId: res.data?.tenant.instance.id,
    enrollmentKey: res.data?.enrollment.adminKey,
    expiresAt: res.data?.enrollment.expiresAt,
  };
}

/**
 * Change one tenant's provisioning: modules, features, WhatsApp provider.
 *
 * All three optional and sent together for the reason the API's own body
 * documents - features are reconciled against the module set being written, so
 * "turn CRM on and enable Invoices" has to be one request or the second half is
 * refused against a row that does not have CRM yet.
 */
export async function updateProvisioningAction(
  orgId: string,
  patch: {
    modules?: OrgModule[];
    features?: OrgFeature[];
    whatsappProvider?: WhatsAppProvider;
  },
): Promise<ActionResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }

  const res = await post(`/v1/admin/tenants/${orgId}/modules`, "PATCH", patch);
  if (res.error) return { error: res.error };
  revalidatePath("/admin");
  return {};
}
