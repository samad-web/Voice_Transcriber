"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * Handsets: the client's own pairing surface (migration 0096).
 *
 * The capability lives on the membership and is enforced in the API, not here.
 * These actions carry no permission logic of their own on purpose - a server
 * action that decided who may pair would be a second copy of the rule, and the
 * copy is the one that drifts.
 */

export interface OwnerDevice {
  id: string;
  label: string | null;
  status: "active" | "logged_out" | "wiped" | "lost";
  osVersion: string | null;
  appVersion: string | null;
  captureCapability: string | null;
  pairedAt: string;
  instanceName: string;
  telecallerName: string | null;
  lastCallAt: string | null;
  callCount: number;
}

export interface DevicesResponse {
  devices: OwnerDevice[];
  instances: Array<{ id: string; name: string }>;
  canPair: boolean;
  canRevoke: boolean;
}

/** Shown once. The raw token exists only in this response - only its hash is stored. */
export interface PairingToken {
  instanceId: string;
  adminKey: string;
  expiresAt: string;
  maxUses: number;
}

export async function mintPairingTokenAction(
  instanceId?: string,
): Promise<{ token?: PairingToken; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/devices/pairing-token`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(instanceId ? { instanceId } : {}),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    return { token: (await res.json()) as PairingToken };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function revokeDeviceAction(id: string): Promise<{ error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/devices/${id}/revoke`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    // The layout too: pairing the first handset completes a setup-checklist
    // step, and the banner lives in the layout rather than on this page.
    revalidatePath("/owner", "layout");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Called after the handset checks in, so the freshly paired device appears
 * without the person hunting for a refresh button - and so the setup
 * checklist re-evaluates.
 */
export async function refreshDevicesAction(): Promise<void> {
  revalidatePath("/owner", "layout");
}
