"use server";

import { revalidatePath } from "next/cache";
import { requireOperator } from "@/lib/operator-guard";
import { API_URL, orgHeaders } from "@/lib/server-api";
import type { Credentials } from "../enrollment-credentials";

/**
 * The most dangerous file in the console: every action here takes an `orgId`
 * from its caller and sends the root admin key at it, and several of them
 * destroy data — erasure, device wipe, instance deletion — or mint an
 * enrollment credential for a handset.
 *
 * So every exported function opens with `requireOperator()`, before anything
 * else. Each one is an independently-addressable POST endpoint that the
 * `(platform)` layout's operator gate never runs for; the layout decides what a
 * browser is *shown*, not what may be *invoked*. See lib/operator-guard.ts.
 */

/** Mint an extra enrollment key for an existing instance. Shown once. */
export async function mintKeyAction(input: {
  orgId: string;
  instanceId: string;
  ttlMinutes: number;
  maxUses: number;
}): Promise<Credentials & { error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
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

/**
 * Turn transcription on or off for an instance. Rides the existing org policy
 * endpoint — it is one more org-level setting, and reusing it means the change
 * is audited and bumps device config versions like every other policy edit.
 */
export async function setTranscriptionEnabledAction(input: {
  orgId: string;
  enabled: boolean;
}): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/org/policy`, {
      method: "PATCH",
      headers: orgHeaders(input.orgId),
      cache: "no-store",
      body: JSON.stringify({ transcriptionEnabled: input.enabled }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath(`/instances/${input.orgId}`);
    revalidatePath(`/instances/${input.orgId}/calls`);
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Rewind a backlog of terminal calls for one instance.
 *
 * Used when transcription is switched back on: the calls that arrived while it
 * was off are sitting in TRANSCRIPTION_OFF with their audio intact, and this is
 * what picks them up. `sinceDays: null` means the entire history, which is why
 * the caller is made to choose rather than defaulting to it — a dormant instance
 * can hold months of stored audio and transcribing it costs real money.
 */
export async function reprocessBacklogAction(input: {
  orgId: string;
  statuses: string[];
  sinceDays: number | null;
}): Promise<{ requeued?: number; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const { orgId, ...rest } = input;
  try {
    const res = await fetch(`${API_URL}/v1/calls/reprocess-backlog`, {
      method: "POST",
      headers: orgHeaders(orgId),
      cache: "no-store",
      body: JSON.stringify(rest),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    const data = (await res.json()) as { requeued?: number };
    revalidatePath(`/instances/${orgId}`);
    revalidatePath(`/instances/${orgId}/calls`);
    return { requeued: data.requeued ?? 0 };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Language, output mode and vocabulary for one instance.
 *
 * Rides the same org policy endpoint as the transcription toggle, for the same
 * reasons: audited, and it bumps device config versions with every other policy
 * edit. `null` for language or mode clears the setting back to the deployment
 * default — distinct from omitting the field, which leaves it untouched.
 */
export async function setAsrSettingsAction(input: {
  orgId: string;
  asrLanguage?: string | null;
  asrMode?: string | null;
  vocabulary?: string[];
}): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const { orgId, ...rest } = input;
  try {
    const res = await fetch(`${API_URL}/v1/org/policy`, {
      method: "PATCH",
      headers: orgHeaders(orgId),
      cache: "no-store",
      body: JSON.stringify(rest),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath(`/instances/${orgId}`);
    revalidatePath(`/instances/${orgId}/calls`);
    return {};
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

export async function logoutDeviceAction(
  orgId: string,
  deviceId: string,
): Promise<{ status?: string; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  return deviceAction(orgId, deviceId, "logout");
}

/** Remote wipe. Destructive and irreversible for the handset it lands on. */
export async function wipeDeviceAction(
  orgId: string,
  deviceId: string,
): Promise<{ status?: string; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
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
  storeFullNumber?: boolean;
}): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/org/policy`, {
      method: "PATCH",
      headers: orgHeaders(input.orgId),
      cache: "no-store",
      body: JSON.stringify({
        consentPolicy: input.consentPolicy,
        onConsentFailure: input.onConsentFailure,
        retentionDays: input.retentionDays,
        storeFullNumber: input.storeFullNumber,
      }),
    });
    if (!res.ok) return { error: `API ${res.status}` };
    revalidatePath(`/instances/${input.orgId}`);
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Set, change, or clear the mobile app-lock password for this instance.
 * Rides the org policy endpoint like the transcription toggle and ASR
 * settings — audited, and it bumps device config versions so every enrolled
 * handset picks the change up on its next config refresh. `password: null`
 * clears the lock for the whole fleet under this org.
 */
export async function setAppLockPasswordAction(input: {
  orgId: string;
  password: string | null;
}): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/org/policy`, {
      method: "PATCH",
      headers: orgHeaders(input.orgId),
      cache: "no-store",
      body: JSON.stringify({ appLockPassword: input.password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath(`/instances/${input.orgId}`);
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Set (or correct) the telecaller holding one handset — name and an optional
 * employee/agent code — right where the device shows up as connected in the
 * console, instead of only after the fact from the org's own owner dashboard.
 * Calling it again on the same device edits the existing telecaller rather
 * than creating a new one.
 */
export async function setDeviceTelecallerAction(input: {
  orgId: string;
  deviceId: string;
  name: string;
  externalId: string | null;
}): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/devices/${input.deviceId}/telecaller`, {
      method: "PATCH",
      headers: orgHeaders(input.orgId),
      cache: "no-store",
      body: JSON.stringify({ name: input.name, externalId: input.externalId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
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
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
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

export interface OwnerResult {
  error?: string;
  /** Returned exactly once, on creation or reset. */
  password?: string | null;
  email?: string;
  /** True when an existing account was attached instead of a new one created. */
  linkedExisting?: boolean;
}

/**
 * Create a console login for this customer's owner.
 *
 * The API provisions the Supabase Auth user and the org membership together,
 * and hands back the password once — the same one-time contract as an
 * enrollment key, since nothing stores it in readable form afterwards.
 */
export async function createOwnerAction(input: {
  orgId: string;
  email: string;
  name?: string;
  recordingsListen: boolean;
}): Promise<OwnerResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/owners`, {
      method: "POST",
      headers: orgHeaders(input.orgId),
      cache: "no-store",
      body: JSON.stringify({
        email: input.email.trim(),
        name: input.name?.trim() || undefined,
        recordingsListen: input.recordingsListen,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.message ?? body?.error ?? body;
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    revalidatePath(`/instances/${input.orgId}`);
    return {
      password: body.password ?? null,
      email: body.owner?.email,
      linkedExisting: Boolean(body.linkedExisting),
    };
  } catch {
    return { error: "API unreachable" };
  }
}

/** Issue a fresh password for an owner who has lost theirs. Shown once. */
export async function resetOwnerPasswordAction(
  orgId: string,
  userId: string,
): Promise<OwnerResult> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/owners/${userId}/password`, {
      method: "POST",
      headers: orgHeaders(orgId),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.message ?? body;
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    return { password: body.password };
  } catch {
    return { error: "API unreachable" };
  }
}

/** Remove an owner's access to this instance. */
export async function revokeOwnerAction(
  orgId: string,
  userId: string,
): Promise<{ error?: string; loginDeleted?: boolean }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  try {
    const res = await fetch(`${API_URL}/v1/owners/${userId}`, {
      method: "DELETE",
      headers: orgHeaders(orgId),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = body?.message ?? body;
      return { error: typeof detail === "string" ? detail : `API ${res.status}` };
    }
    revalidatePath(`/instances/${orgId}`);
    return { loginDeleted: Boolean(body.loginDeleted) };
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
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
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
