"use server";

import { revalidatePath } from "next/cache";
import { validateCallAccessWindow } from "@aura/shared";
import { call } from "@/lib/action-call";
import { requireOperator } from "@/lib/operator-guard";

/**
 * Asking a customer for permission to open their call logs (migration 0122).
 *
 * Every export opens with `await requireOperator()` as its first statement,
 * for the reason lib/operator-guard.ts sets out at length: a Server Action is
 * an independently-addressable POST with an id that ships in the client
 * bundle, and these take an `orgId` from their caller.
 *
 * Note what these actions can and cannot do. They can ASK, and they can carry
 * a code the customer read out. They cannot approve - there is no operator
 * route that grants anything, by design, and `OwnerRoleGuard` on the deciding
 * routes refuses the bare admin key this console holds.
 */

export interface CallAccessState {
  gateEnabled: boolean;
  requests: {
    id: string;
    status: "pending" | "approved" | "denied" | "revoked";
    reason: string;
    requested_start: string;
    requested_end: string;
    granted_start: string | null;
    granted_end: string | null;
    decided_at: string | null;
    decided_via: "console" | "otp" | null;
    attempts: number;
    otp_sent_at: string | null;
    otp_sent_to_last3: string | null;
    otp_expires_at: string | null;
    created_at: string;
  }[];
}

export async function getCallAccessStateAction(
  orgId: string,
): Promise<{ state?: CallAccessState; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<CallAccessState>("/v1/call-access/mine", { method: "GET", orgId });
  if (res.error) return { error: res.error };
  return { state: res.data };
}

export async function requestCallAccessAction(
  orgId: string,
  reason: string,
  requestedStart: string,
  requestedEnd: string,
): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }

  const trimmed = reason.trim();
  if (!trimmed) {
    return { error: "Say why you need access - the customer sees this and decides on it." };
  }
  const window = validateCallAccessWindow(requestedStart, requestedEnd);
  if (!window.ok) return { error: window.message };

  const res = await call("/v1/call-access/requests", {
    method: "POST",
    orgId,
    body: { reason: trimmed, requestedStart, requestedEnd },
  });
  if (res.error) return { error: res.error };

  revalidatePath("/calls");
  revalidatePath(`/instances/${orgId}/calls`);
  return {};
}

/**
 * Ask for a one-time code to go to the customer's administrator.
 *
 * THIS SENDS A REAL WHATSAPP MESSAGE TO A REAL PERSON, and is switched off
 * unless the deployment sets both `CALL_ACCESS_OTP_ENABLED=true` and
 * `WHATSAPP_SENDING_ENABLED=true`. Neither is set anywhere in this repository,
 * so out of the box this returns a 503 pointing at console approval - which
 * sends nothing anywhere.
 */
export async function sendCallAccessOtpAction(
  orgId: string,
  requestId: string,
): Promise<{ toLast3?: string | null; expiresAt?: string; error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call<{ toLast3: string | null; expiresAt: string }>(
    `/v1/call-access/requests/${requestId}/otp`,
    { method: "POST", orgId },
  );
  if (res.error) return { error: res.error };
  return { toLast3: res.data?.toLast3, expiresAt: res.data?.expiresAt };
}

export async function redeemCallAccessOtpAction(
  orgId: string,
  requestId: string,
  code: string,
): Promise<{ error?: string }> {
  try {
    await requireOperator();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await call(`/v1/call-access/requests/${requestId}/redeem`, {
    method: "POST",
    orgId,
    body: { code: code.trim() },
  });
  if (res.error) return { error: res.error };

  revalidatePath("/calls");
  revalidatePath(`/instances/${orgId}/calls`);
  return {};
}
