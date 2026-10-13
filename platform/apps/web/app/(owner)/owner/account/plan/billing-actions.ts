"use server";

import { revalidatePath } from "next/cache";
import { API_URL } from "@/lib/server-api";
import { ownerHeaders, type ActionResult } from "../../actions";
import { apiErrorMessage } from "../../lib/api-error";

/**
 * Starting a payment for a capture plan or a top-up (migration 0197).
 *
 * ── NOTHING HERE GRANTS ANYTHING ────────────────────────────────────────────
 *
 * Both actions create a `billing_orders` row and, if the platform's Razorpay
 * keys are configured, ask the gateway for an order handle. Neither touches
 * `org_subscriptions`, `enabled_modules` or any meter. A tenant moves between
 * tiers in exactly two places: an operator settling the order, or a
 * signature-verified webhook. So an abandoned checkout leaves a pending order
 * and nothing else, and an owner cannot upgrade themselves by starting a
 * payment they never complete.
 *
 * ── `manual` IS A COMPLETE ANSWER, NOT A FAILURE ────────────────────────────
 *
 * With no keys configured - the state today, by the project owner's decision -
 * every order comes back `gateway: "manual"` with a named reason. That is how
 * the first accounts are sold: we invoice out of band, the money arrives, and
 * an operator settles the order. The page says so rather than showing an error.
 */

export interface CheckoutOutcome extends ActionResult {
  orderId?: string;
  gateway?: "razorpay" | "manual";
  gatewayReason?: "not_configured" | "currency_unsupported" | null;
  /** Razorpay's order handle, for a checkout widget. Absent on the manual path. */
  providerOrderId?: string | null;
  /** The PUBLIC key id. The secret never leaves the API. */
  providerKeyId?: string | null;
  totalMinor?: number;
  currency?: string;
}

/** Every surface a plan governs, re-rendered after an order lands. */
function revalidatePlanSurfaces(): void {
  revalidatePath("/owner/account/plan");
  revalidatePath("/owner/settings");
  revalidatePath("/owner");
}

export async function startCheckoutAction(input: {
  planKey: string;
  period: "annual" | "monthly";
}): Promise<CheckoutOutcome> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/billing/checkout`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const body = (await res.json()) as {
      orderId: string;
      gateway: "razorpay" | "manual";
      gatewayReason: CheckoutOutcome["gatewayReason"];
      providerOrderId: string | null;
      providerKeyId: string | null;
      quote: { totalMinor: number; currency: string };
    };
    revalidatePlanSurfaces();
    return {
      orderId: body.orderId,
      gateway: body.gateway,
      gatewayReason: body.gatewayReason,
      providerOrderId: body.providerOrderId,
      providerKeyId: body.providerKeyId,
      totalMinor: body.quote.totalMinor,
      currency: body.quote.currency,
    };
  } catch {
    return { error: "API unreachable" };
  }
}

export async function buyTopupAction(input: {
  addonKey: string;
  units: number;
}): Promise<CheckoutOutcome> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/billing/topup`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    const body = (await res.json()) as {
      orderId: string;
      gateway: "razorpay" | "manual";
      gatewayReason: CheckoutOutcome["gatewayReason"];
      providerOrderId: string | null;
      providerKeyId: string | null;
      quote: { totalMinor: number; currency: string };
    };
    revalidatePlanSurfaces();
    return {
      orderId: body.orderId,
      gateway: body.gateway,
      gatewayReason: body.gatewayReason,
      providerOrderId: body.providerOrderId,
      providerKeyId: body.providerKeyId,
      totalMinor: body.quote.totalMinor,
      currency: body.quote.currency,
    };
  } catch {
    return { error: "API unreachable" };
  }
}

/**
 * Switch auto top-up on or off, with the owner's own monthly ceiling.
 *
 * The ceiling is mandatory to switch it on and the table's CHECK enforces it,
 * so this cannot forget. An auto-charge that renews itself without a cap is
 * how a surprise bill becomes a chargeback, and the ceiling costs us nothing
 * to offer.
 */
export async function setAutoTopupAction(input: {
  enabled: boolean;
  addonKey?: string;
  capMinor?: number;
}): Promise<ActionResult> {
  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/owner/billing/auto-topup`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return { error: await apiErrorMessage(res) };
    revalidatePath("/owner/account/plan");
    return {};
  } catch {
    return { error: "API unreachable" };
  }
}
