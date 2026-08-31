"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/operator-guard";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";

export interface ProvisionResult {
  error?: string;
  orgId?: string;
  instanceId?: string;
  instanceName?: string;
  adminKey?: string;
  expiresAt?: string;
  maxUses?: number;
  enabledModules?: string[];
}

/**
 * Provision a customer company: org (RLS tenant) + workspace + instance + the
 * first one-time enrollment key. The key comes back exactly once.
 *
 * Operator-only, asserted here rather than relying on the `(platform)` layout:
 * this is an independently-addressable POST endpoint and the layout runs only on
 * a render (see lib/operator-guard.ts). Unguarded, any signed-in account could
 * create tenants at will - and it sends the cross-tenant root key to do it.
 */
export async function createTenantAction(input: {
  name: string;
  consentPolicy: string;
  retentionDays: number;
  ttlMinutes: number;
  maxUses: number;
  enableCrm: boolean;
}): Promise<ProvisionResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/admin/tenants`, {
      method: "POST",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({
        name: input.name,
        consentPolicy: input.consentPolicy,
        retentionDays: input.retentionDays,
        tokenTtlMinutes: input.ttlMinutes,
        tokenMaxUses: input.maxUses,
        enableCrm: input.enableCrm,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    revalidatePath("/instances");
    return {
      orgId: data.enrollment.orgId,
      instanceId: data.enrollment.instanceId,
      instanceName: data.tenant.name,
      adminKey: data.enrollment.adminKey,
      expiresAt: data.enrollment.expiresAt,
      maxUses: data.enrollment.maxUses,
      enabledModules: data.tenant.enabled_modules,
    };
  } catch {
    return { error: "API unreachable - is `pnpm --filter @aura/api dev` running?" };
  }
}
