"use server";

import { revalidatePath } from "next/cache";
import { adminHeaders, API_URL } from "@/lib/server-api";

export interface ProvisionResult {
  error?: string;
  orgId?: string;
  instanceId?: string;
  instanceName?: string;
  adminKey?: string;
  expiresAt?: string;
  maxUses?: number;
}

/**
 * Provision a customer company: org (RLS tenant) + workspace + instance + the
 * first one-time enrollment key. The key comes back exactly once.
 */
export async function createTenantAction(input: {
  name: string;
  consentPolicy: string;
  retentionDays: number;
  ttlMinutes: number;
  maxUses: number;
}): Promise<ProvisionResult> {
  try {
    const res = await fetch(`${API_URL}/v1/admin/tenants`, {
      method: "POST",
      headers: adminHeaders,
      cache: "no-store",
      body: JSON.stringify({
        name: input.name,
        consentPolicy: input.consentPolicy,
        retentionDays: input.retentionDays,
        tokenTtlMinutes: input.ttlMinutes,
        tokenMaxUses: input.maxUses,
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
    };
  } catch {
    return { error: "API unreachable — is `pnpm --filter @aura/api dev` running?" };
  }
}
