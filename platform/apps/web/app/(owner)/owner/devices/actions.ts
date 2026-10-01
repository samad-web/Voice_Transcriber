"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders } from "../actions";
import { apiErrorMessage } from "../lib/api-error";

/**
 * Handsets: the client's own pairing surface (migration 0107).
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
  /** Set when the handset was removed from the fleet (0087). */
  removedAt: string | null;
  /** When a returning phone last took this handset back (0130). */
  relinkedAt: string | null;
  /** A reinstall of this phone reconnects by itself - false until it runs 1.1.6+. */
  selfRecovery: boolean;
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

/** How long a handset has been quiet. Bands, not a timestamp - the question is
 *  "is this phone still with us", and an exact minute count does not help. */
export type DeviceStaleness = "never" | "<1h" | "1-24h" | "1-7d" | "stale";

/**
 * A row of `GET /v1/devices/fleet-health`, narrowed to what this page draws.
 *
 * The endpoint also returns `instanceId` and a `health` object (battery, free
 * storage, pending uploads, failure counts). Both are deliberately left off:
 * the reasons derived from them already arrive in `attentionReasons`, and
 * restating the raw numbers here would put a second, unexplained set of
 * thresholds in the browser next to the ones devices.controller.ts documents.
 */
export interface DeviceHealth {
  deviceId: string;
  staleness: DeviceStaleness;
  needsAttention: boolean;
  attentionReasons: string[];
}

export interface FleetHealthResponse {
  devices: DeviceHealth[];
}

/** Shown once. The raw token exists only in this response - only its hash is stored. */
export interface PairingToken {
  /** The token's row id - what the dialog watches. Not a secret: it enrols nothing. */
  pairingId: string;
  instanceId: string;
  adminKey: string;
  expiresAt: string;
  maxUses: number;
  /** Present on a re-link code: the handset whichever phone scans it becomes. */
  relinkDeviceId?: string;
}

/**
 * Where one pairing code stands (`GET /v1/owner/devices/pairing-token/:id`).
 *
 * `paired` carries the handset that used it, so the dialog can name the phone
 * it just watched arrive rather than saying "a device".
 */
export type PairingStatus =
  | { state: "waiting" | "expired"; expiresAt: string }
  | {
      state: "paired";
      expiresAt: string;
      device: {
        id: string;
        label: string | null;
        instanceName: string;
        pairedAt: string;
        /** The code brought an existing handset back rather than adding one (0130). */
        recovered: boolean;
        telecallerName: string | null;
        callCount: number;
      };
    };

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

/**
 * Has a phone used this code yet. Called by the open pairing dialog - on each
 * `device` change signal, and on a slow timer in case the signal is lost.
 *
 * An error is returned rather than thrown: this runs on a timer, and a single
 * failed tick (a redeploy, a blip to the database) must leave the QR on screen
 * and try again, not tear the dialog down.
 */
export async function pairingStatusAction(
  pairingId: string,
): Promise<{ status?: PairingStatus; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(
      `${API_URL}/v1/owner/devices/pairing-token/${encodeURIComponent(pairingId)}`,
      { headers, cache: "no-store" },
    );
    if (!res.ok) return { error: await apiErrorMessage(res) };
    return { status: (await res.json()) as PairingStatus };
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
 * Take a handset off the list for good.
 *
 * `outcome` says what actually happened, which the caller reports back: a
 * phone that never recorded anything is deleted outright, one that did is
 * de-enrolled so its calls keep resolving. The API decides which from the
 * data - see removeDevice - so this cannot promise the wrong one.
 */
export async function removeDeviceAction(
  id: string,
): Promise<{ error?: string; outcome?: "deleted" | "de-enrolled"; calls?: number }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/devices/${id}`, {
      method: "DELETE",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const data = (await res.json()) as { outcome: "deleted" | "de-enrolled"; calls: number };
    revalidatePath("/owner", "layout");
    return { outcome: data.outcome, calls: data.calls };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Undo a retire (0130). The phone still holds its key, so it re-enables at its
 * next check-in - which the API triggers with a push rather than waiting for
 * the hourly poll.
 */
export async function restoreDeviceAction(id: string): Promise<{ error?: string; woken?: boolean }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/devices/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const body = (await res.json()) as { woken?: boolean };
    revalidatePath("/owner", "layout");
    return { woken: body.woken === true };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * A pairing code bound to one existing handset (0130): whichever phone scans
 * it takes that handset over - its id, its telecaller, its call history. Same
 * shape as a pairing code, so the same dialog watches it.
 */
export async function mintRelinkTokenAction(
  deviceId: string,
): Promise<{ token?: PairingToken; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(
      `${API_URL}/v1/owner/devices/${encodeURIComponent(deviceId)}/relink-token`,
      { method: "POST", headers, cache: "no-store" },
    );
    if (!res.ok) return { error: await apiErrorMessage(res) };
    return { token: (await res.json()) as PairingToken };
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

// ── Message phones (migration 0150) ─────────────────────────────────────────

/** Mirrors `HandsetAlertDelivery` in @aura/shared - what one recipient's phone did with it. */
export type HandsetDelivery = "read" | "delivered" | "sending" | "not_reached" | "no_phone";

export interface HandsetRecipient {
  telecallerId: string;
  name: string;
  /** An active paired phone: something can collect the message. */
  hasPhone: boolean;
  /** That phone can be woken by a push, not only by its hourly check. */
  pushable: boolean;
  /** Their phone is known to run an app too old to show alerts. */
  needsUpdate: boolean;
}

export interface SentHandsetMessage {
  batchId: string;
  title: string;
  body: string | null;
  popup: boolean;
  sentAt: string;
  sentBy: string | null;
  recipients: Array<{
    telecallerId: string;
    name: string;
    delivery: HandsetDelivery;
    deliveredAt: string | null;
    openedAt: string | null;
  }>;
}

export interface HandsetAlertsOverview {
  recipients: HandsetRecipient[];
  sent: SentHandsetMessage[];
}

/** Re-read the sent list - the panel polls this while a message is still on its way. */
export async function handsetAlertsOverviewAction(): Promise<{ overview?: HandsetAlertsOverview; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/owner/handset-alerts`, { headers, cache: "no-store" });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    return { overview: (await res.json()) as HandsetAlertsOverview };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function sendHandsetMessageAction(input: {
  everyone: boolean;
  telecallerIds: string[];
  title?: string;
  body: string;
  popup: boolean;
}): Promise<{ recipients?: number; phonesWoken?: number; error?: string }> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };
  try {
    const res = await fetch(`${API_URL}/v1/owner/handset-alerts`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify(input),
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const out = (await res.json()) as { recipients: number; phonesWoken: number };
    return { recipients: out.recipients, phonesWoken: out.phonesWoken };
  } catch {
    return { error: "API unreachable" };
  }
}
