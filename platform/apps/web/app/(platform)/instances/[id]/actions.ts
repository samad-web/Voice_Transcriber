"use server";

import { revalidatePath } from "next/cache";
import { OrgModule } from "@aura/shared";
import { call } from "@/lib/action-call";
import { requireOperator } from "@/lib/operator-guard";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";
import type { Credentials } from "../enrollment-credentials";

/**
 * The most dangerous file in the console: every action here takes an `orgId`
 * from its caller and sends the root admin key at it, and several of them
 * destroy data - erasure, device wipe, instance deletion - or mint an
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
  const res = await call<Credentials>(`/v1/instances/${input.instanceId}/keys`, {
    method: "POST",
    orgId: input.orgId,
    body: { tokenTtlMinutes: input.ttlMinutes, tokenMaxUses: input.maxUses },
  });
  if (res.error) return { error: res.error };
  revalidatePath(`/instances/${input.orgId}`);
  return {
    instanceId: res.data?.instanceId,
    adminKey: res.data?.adminKey,
    expiresAt: res.data?.expiresAt,
    maxUses: res.data?.maxUses,
  };
}

/**
 * Every org-level setting below - transcription, ASR, consent policy, app
 * lock - PATCHes this one endpoint: it is audited, and it bumps every
 * enrolled handset's config version like any other policy edit. Follows the
 * same de-duplication as `deviceAction()` further down - one fetch/error
 * path, thin wrappers per setting - rather than repeating the same
 * try/fetch/catch four times. `requireOperator()` and `revalidatePath` stay
 * in each wrapper rather than here, because which paths to revalidate differs
 * per setting (transcription and ASR also bump the calls explorer; consent
 * policy and the app lock do not).
 */
async function patchOrgPolicy(orgId: string, body: Record<string, unknown>): Promise<{ error?: string }> {
  const res = await call(`/v1/org/policy`, { method: "PATCH", body, orgId });
  if (res.error) return { error: res.error };
  return {};
}

/**
 * Turn transcription on or off for an instance. Rides the existing org policy
 * endpoint - it is one more org-level setting, and reusing it means the change
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
  const res = await patchOrgPolicy(input.orgId, { transcriptionEnabled: input.enabled });
  if (res.error) return res;
  revalidatePath(`/instances/${input.orgId}`);
  revalidatePath(`/instances/${input.orgId}/calls`);
  return {};
}

/**
 * Turn WhatsApp lead qualification on or off for an instance (0080/0082).
 *
 * Rides the same org policy endpoint as transcription, and for the same reason:
 * it is one more org-level setting, so reusing it means the change is audited
 * like every other policy edit. It bumps no device config - handsets know
 * nothing about this - so unlike transcription it revalidates only this page.
 */
export async function setWhatsAppQualificationAction(input: {
  orgId: string;
  enabled: boolean;
}): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await patchOrgPolicy(input.orgId, { whatsappQualificationEnabled: input.enabled });
  if (res.error) return res;
  revalidatePath(`/instances/${input.orgId}`);
  return {};
}

/**
 * Turn ONE module on or off for a tenant (org-modules.ts), leaving the rest of
 * its entitlement exactly as it was.
 *
 * THAT LAST PART IS THE WHOLE SIGNATURE. The endpoint behind this replaces
 * `enabled_modules` wholesale, and this action used to post a hardcoded
 * `["aura", "crm"]` - correct while CRM was the only toggle, and silently
 * destructive the moment a second one existed: turning CRM off would also
 * strip Call Intelligence, from a card that says nothing about it. So the
 * caller passes the tenant's CURRENT modules (the instance page already has
 * them) and this computes the difference.
 *
 * Unlike the org-policy settings above, this can have a side effect (seeding
 * roles/a default pipeline the first time CRM is enabled) so it rides the
 * dedicated admin endpoint next to that seeding logic, not `patchOrgPolicy`.
 * Disabling never deletes any CRM data it already seeded - CrmPermissionsGuard
 * is what actually revokes access - so re-enabling later needs no reseed.
 *
 * `admin/tenants/*` is `AdminController`'s cross-tenant surface (same as
 * `createTenantAction` in `instances/new/actions.ts`) - it takes the org id
 * as a URL param, not via `x-org-id`, so this uses `crossTenantHeaders`
 * directly rather than `call()`'s `orgId` option, which would send
 * `adminHeaders`' `x-org-id: DEV_ORG_ID` instead (harmless here since the
 * route ignores it, but the wrong credential to reach for).
 */
export async function setModuleEnabledAction(input: {
  orgId: string;
  module: OrgModule;
  enabled: boolean;
  /** The tenant's entitlement as the page rendering this toggle read it. */
  current: string[];
}): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  // Unknown strings are dropped rather than echoed back: the endpoint's zod
  // enum would reject the whole request over one stale value, which would turn
  // "a module was retired" into "no module can be toggled on this tenant".
  const next = new Set(
    input.current.filter((m): m is OrgModule => OrgModule.safeParse(m).success),
  );
  if (input.enabled) next.add(input.module);
  else next.delete(input.module);
  // Every tenant has an instance, workspace and devices, and the endpoint
  // requires at least one module - so "aura" is re-added last, after the
  // toggle, rather than being something a click could remove.
  next.add("aura");

  try {
    const res = await fetch(`${API_URL}/v1/admin/tenants/${input.orgId}/modules`, {
      method: "PATCH",
      headers: crossTenantHeaders,
      cache: "no-store",
      body: JSON.stringify({ modules: [...next] }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: `API ${res.status}: ${JSON.stringify(body.message ?? body)}` };
    }
    revalidatePath(`/instances/${input.orgId}`);
    return {};
  } catch {
    return { error: "API unreachable - is `pnpm --filter @aura/api dev` running?" };
  }
}

/**
 * Rewind a backlog of terminal calls for one instance.
 *
 * Used when transcription is switched back on: the calls that arrived while it
 * was off are sitting in TRANSCRIPTION_OFF with their audio intact, and this is
 * what picks them up. `sinceDays: null` means the entire history, which is why
 * the caller is made to choose rather than defaulting to it - a dormant instance
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
  const res = await call<{ requeued?: number }>(`/v1/calls/reprocess-backlog`, {
    method: "POST",
    body: rest,
    orgId,
  });
  if (res.error) return { error: res.error };
  revalidatePath(`/instances/${orgId}`);
  revalidatePath(`/instances/${orgId}/calls`);
  return { requeued: res.data?.requeued ?? 0 };
}

/**
 * Language, output mode and vocabulary for one instance.
 *
 * Rides the same org policy endpoint as the transcription toggle, for the same
 * reasons: audited, and it bumps device config versions with every other policy
 * edit. `null` for language or mode clears the setting back to the deployment
 * default - distinct from omitting the field, which leaves it untouched.
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
  const res = await patchOrgPolicy(orgId, rest);
  if (res.error) return res;
  revalidatePath(`/instances/${orgId}`);
  revalidatePath(`/instances/${orgId}/calls`);
  return {};
}

async function deviceAction(
  orgId: string,
  deviceId: string,
  verb: "logout" | "wipe",
): Promise<{ status?: string; error?: string }> {
  const res = await call<{ status?: string }>(`/v1/devices/${deviceId}/${verb}`, {
    method: "POST",
    orgId,
  });
  if (res.error) return { error: res.error };
  revalidatePath(`/instances/${orgId}`);
  return { status: res.data?.status ?? (verb === "wipe" ? "wiped" : "logged_out") };
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

/**
 * Remove a handset from the fleet - the action Logout and Wipe never covered,
 * since both leave the device sitting in the table forever.
 *
 * The API decides the two possible outcomes (a phone with no calls is
 * hard-deleted; one with calls is de-enrolled and kept for history), so this
 * only has to relay whichever one came back and let the confirmation dialog at
 * the call site phrase them differently.
 */
export async function deleteDeviceAction(
  orgId: string,
  deviceId: string,
): Promise<{ outcome?: "deleted" | "de-enrolled"; calls?: number; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<{ outcome: "deleted" | "de-enrolled"; calls: number }>(
    `/v1/devices/${deviceId}`,
    { method: "DELETE", orgId },
  );
  if (res.error) return { error: res.error };
  revalidatePath(`/instances/${orgId}`);
  return { outcome: res.data?.outcome, calls: res.data?.calls };
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
  const res = await patchOrgPolicy(input.orgId, {
    consentPolicy: input.consentPolicy,
    onConsentFailure: input.onConsentFailure,
    retentionDays: input.retentionDays,
    storeFullNumber: input.storeFullNumber,
  });
  if (res.error) return res;
  revalidatePath(`/instances/${input.orgId}`);
  return {};
}

/**
 * Set, change, or clear the mobile app-lock password for this instance.
 * Rides the org policy endpoint like the transcription toggle and ASR
 * settings - audited, and it bumps device config versions so every enrolled
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
  const res = await patchOrgPolicy(input.orgId, { appLockPassword: input.password });
  if (res.error) return res;
  revalidatePath(`/instances/${input.orgId}`);
  return {};
}

/**
 * Set (or correct) the telecaller holding one handset - name and an optional
 * employee/agent code - right where the device shows up as connected in the
 * console, instead of only after the fact from the org's own owner dashboard.
 * Calling it again on the same device edits the existing telecaller rather
 * than creating a new one, unless `reassign` is set - that mints a fresh
 * identity for a genuinely different person instead of renaming the last one.
 */
export async function setDeviceTelecallerAction(input: {
  orgId: string;
  deviceId: string;
  name: string;
  externalId: string | null;
  reassign?: boolean;
}): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  // telecaller-form.tsx already refuses to submit a blank name, but that is
  // client-side only - this action is an independently-addressable POST
  // endpoint (see the file banner above), so a caller that skips the form
  // entirely could otherwise blank out an existing telecaller's name.
  const name = input.name.trim();
  if (!name) {
    return { error: "Name is required." };
  }
  const res = await call(`/v1/devices/${input.deviceId}/telecaller`, {
    method: "PATCH",
    orgId: input.orgId,
    body: {
      name,
      externalId: input.externalId,
      reassign: input.reassign ?? false,
    },
  });
  if (res.error) return { error: res.error };
  revalidatePath(`/instances/${input.orgId}`);
  return {};
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
  const res = await call<{ name?: string; purged?: string[] }>(
    `/v1/instances/${instanceId}${purgeCalls ? "?purgeCalls=true" : ""}`,
    { method: "DELETE", orgId },
  );
  if (res.error) {
    // `call()` already formats a display-ready error string, but this one
    // case needs the structured body too - the API answers 409 with
    // {error: "instance_has_calls", calls, devices, message} so the caller
    // can offer the purge-and-retry confirmation instead of a dead end.
    const payload = res.rawBody as { message?: Record<string, unknown> } | undefined;
    const detail = (payload?.message ?? payload) as
      | { error?: string; calls?: number; devices?: number; message?: string }
      | undefined;
    if (res.status === 409 && detail?.error === "instance_has_calls") {
      return {
        blockedByCalls: { calls: detail.calls ?? 0, devices: detail.devices ?? 0 },
        error: detail.message,
      };
    }
    return { error: res.error };
  }
  revalidatePath("/instances");
  return { deleted: true, name: res.data?.name, purged: res.data?.purged };
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
 * and hands back the password once - the same one-time contract as an
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
  const res = await call<{ password?: string | null; owner?: { email?: string }; linkedExisting?: boolean }>(
    `/v1/owners`,
    {
      method: "POST",
      orgId: input.orgId,
      body: {
        email: input.email.trim(),
        name: input.name?.trim() || undefined,
        recordingsListen: input.recordingsListen,
      },
    },
  );
  if (res.error) return { error: res.error };
  revalidatePath(`/instances/${input.orgId}`);
  return {
    password: res.data?.password ?? null,
    email: res.data?.owner?.email,
    linkedExisting: Boolean(res.data?.linkedExisting),
  };
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
  const res = await call<{ password?: string }>(`/v1/owners/${userId}/password`, {
    method: "POST",
    orgId,
  });
  if (res.error) return { error: res.error };
  return { password: res.data?.password };
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
  const res = await call<{ loginDeleted?: boolean }>(`/v1/owners/${userId}`, {
    method: "DELETE",
    orgId,
  });
  if (res.error) return { error: res.error };
  revalidatePath(`/instances/${orgId}`);
  return { loginDeleted: Boolean(res.data?.loginDeleted) };
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
  const res = await call<ErasureReceipt>(`/v1/erasure-requests`, {
    method: "POST",
    orgId,
    body: { callId },
  });
  if (res.error) return { error: res.error };
  revalidatePath(`/instances/${orgId}`);
  return res.data ?? {};
}
