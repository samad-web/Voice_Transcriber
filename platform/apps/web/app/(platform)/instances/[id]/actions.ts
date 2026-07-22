"use server";

import { revalidatePath } from "next/cache";
import { API_URL, orgHeaders } from "@/lib/server-api";
import type { Credentials } from "../enrollment-credentials";

/** Mint an extra enrollment key for an existing instance. Shown once. */
export async function mintKeyAction(input: {
  orgId: string;
  instanceId: string;
  ttlMinutes: number;
  maxUses: number;
}): Promise<Credentials & { error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/instances/${input.instanceId}/keys`, {
      method: "POST",
      headers: orgHeaders(input.orgId),
      cache: "no-store",
      body: JSON.stringify({
        tokenTtlMinutes: input.ttlMinutes,
        tokenMaxUses: input.maxUses,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = await res.json();
    revalidatePath(`/instances/${input.orgId}`);
    return {
      instanceId: data.instanceId,
      adminKey: data.adminKey,
      expiresAt: data.expiresAt,
      maxUses: data.maxUses,
    };
  } catch {
    return { error: "API unreachable" };
  }
}

async function deviceAction(
  orgId: string,
  deviceId: string,
  verb: "logout" | "wipe",
): Promise<{ status?: string; error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/devices/${deviceId}/${verb}`, {
      method: "POST",
      headers: orgHeaders(orgId),
      cache: "no-store",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const data = (await res.json().catch(() => ({}))) as { status?: string };
    revalidatePath(`/instances/${orgId}`);
    return { status: data.status ?? (verb === "wipe" ? "wiped" : "logged_out") };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function logoutDeviceAction(orgId: string, deviceId: string) {
  return deviceAction(orgId, deviceId, "logout");
}

export async function wipeDeviceAction(orgId: string, deviceId: string) {
  return deviceAction(orgId, deviceId, "wipe");
}

/**
 * Consent regime + retention for this customer. The API bumps every instance's
 * config_version so enrolled handsets pick the new policy up on next refresh.
 */
export async function updatePolicyAction(input: {
  orgId: string;
  consentPolicy: string;
  onConsentFailure: string;
  retentionDays: number;
}): Promise<{ error?: string }> {
  try {
    const res = await fetch(`${API_URL}/v1/org/policy`, {
      method: "PATCH",
      headers: orgHeaders(input.orgId),
      cache: "no-store",
      body: JSON.stringify({
        consentPolicy: input.consentPolicy,
        onConsentFailure: input.onConsentFailure,
        retentionDays: input.retentionDays,
      }),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath(`/instances/${input.orgId}`);
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

export interface DeleteInstanceResult {
  deleted?: boolean;
  name?: string;
  purged?: string[];
  error?: string;
  /** Set when the instance still holds calls and `purgeCalls` was not passed. */
  blockedByCalls?: { calls: number; devices: number };
}

/**
 * Decommission an instance. Without `purgeCalls` the API refuses whenever call
 * history would be destroyed; the caller surfaces that as the second-step
 * confirmation rather than treating it as a plain error.
 */
export async function deleteInstanceAction(
  orgId: string,
  instanceId: string,
  purgeCalls = false,
): Promise<DeleteInstanceResult> {
  try {
    const res = await fetch(
      `${API_URL}/v1/instances/${instanceId}${purgeCalls ? "?purgeCalls=true" : ""}`,
      { method: "DELETE", headers: orgHeaders(orgId), cache: "no-store" },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.message ?? body;
      if (res.status === 409 && detail?.error === "instance_has_calls") {
        return {
          blockedByCalls: { calls: detail.calls, devices: detail.devices },
          error: detail.message,
        };
      }
      return { error: `API ${res.status}: ${JSON.stringify(detail)}` };
    }
    revalidatePath("/instances");
    return { deleted: true, name: body.name, purged: body.purged };
  } catch {
    return { error: "API unreachable" };
  }
}

export interface ErasureReceipt {
  error?: string;
  status?: string;
  callId?: string;
  purged?: string[];
  erasedAtUtc?: string;
  signature?: string;
  receiptHash?: string;
}

/** Cascading erasure within this customer's tenant. */
export async function triggerErasureAction(
  orgId: string,
  callId: string,
): Promise<ErasureReceipt> {
  try {
    const res = await fetch(`${API_URL}/v1/erasure-requests`, {
      method: "POST",
      headers: orgHeaders(orgId),
      cache: "no-store",
      body: JSON.stringify({ callId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath(`/instances/${orgId}`);
    return (await res.json()) as ErasureReceipt;
  } catch {
    return { error: "API unreachable — is the API running?" };
  }
}
