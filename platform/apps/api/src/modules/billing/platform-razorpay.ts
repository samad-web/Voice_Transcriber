import { REGION_CURRENCY, type BillingRegion } from "@aura/shared";
import { verifyRazorpaySignature } from "../invoices/razorpay";

/**
 * The platform's own Razorpay wiring: us collecting a subscription fee from a
 * tenant. A PLACEHOLDER by design, and the shape the real thing will take.
 *
 * ── WHY THIS IS NOT `modules/invoices/razorpay.ts` ──────────────────────────
 *
 * That file is the TENANT's gateway, collecting from THEIR customers against
 * an invoice they raised, with the tenant's own key falling back to the
 * platform's env vars. This is the opposite direction: the platform charging
 * the tenant for a plan. The credentials are always ours, never a tenant's,
 * and a tenant key reaching this path would mean a customer paying their own
 * Razorpay account for our subscription.
 *
 * The HMAC verification IS shared - `verifyRazorpaySignature` is imported
 * rather than re-implemented, because a second constant-time compare is a
 * second chance to get one wrong.
 *
 * ── NO LIVE CALLS UNTIL THE TEST KEYS ARRIVE ────────────────────────────────
 *
 * The project owner's decision, and the price list says it plainly: "the plan
 * catalogue, handset cap, retention clocks and top-up accounting can all be
 * built and tested with the gateway stubbed, and should be. Razorpay goes in
 * behind environment keys with no live calls until the test keys arrive."
 *
 * So `resolvePlatformGateway` returns `manual` whenever the keys are absent,
 * and `manual` is a complete, working path: an order is recorded, the owner is
 * told we will invoice them, and an operator settles it. Assigning a plan by
 * hand after a manual invoice is a perfectly good way to sell the first twenty
 * accounts, and it lets the tiers be proven before collecting money for them
 * is automated. Nothing in this file is reached at all until
 * `RAZORPAY_PLATFORM_KEY_ID` and `RAZORPAY_PLATFORM_KEY_SECRET` are set.
 *
 * ── RAZORPAY CANNOT SETTLE DIRHAMS ──────────────────────────────────────────
 *
 * Razorpay is an India gateway. The UAE needs its own, which is an open
 * decision on the price list and is the reason the billing layer must not
 * assume one provider. An AED order therefore resolves to `manual` with a
 * named reason rather than being sent to a gateway that would reject it - and
 * the UAE is not sellable today anyway, so this refusal is a second line
 * behind the `sellable` flag rather than the only one.
 */

export interface PlatformGatewayCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string | null;
}

export type GatewayResolution =
  | { provider: "razorpay"; creds: PlatformGatewayCredentials }
  | { provider: "manual"; reason: GatewayUnavailableReason };

/**
 * Why an order is being settled by hand. Carried to the owner verbatim, so the
 * reason a checkout did not open a payment page is never a mystery.
 */
export type GatewayUnavailableReason =
  /** No platform keys in the environment. The expected state today. */
  | "not_configured"
  /** A currency this gateway cannot settle - AED on Razorpay. */
  | "currency_unsupported";

/**
 * Which gateway, if any, may take this order.
 *
 * Takes the CURRENCY rather than the region, because the currency is what a
 * gateway either settles or does not, and because a future second gateway will
 * be chosen on exactly that axis.
 */
export function resolvePlatformGateway(
  currency: string,
  env: NodeJS.ProcessEnv = process.env,
): GatewayResolution {
  if (currency.toUpperCase() !== "INR") {
    return { provider: "manual", reason: "currency_unsupported" };
  }
  const keyId = env.RAZORPAY_PLATFORM_KEY_ID;
  const keySecret = env.RAZORPAY_PLATFORM_KEY_SECRET;
  if (!keyId || !keySecret) {
    return { provider: "manual", reason: "not_configured" };
  }
  return {
    provider: "razorpay",
    creds: {
      keyId,
      keySecret,
      webhookSecret: env.RAZORPAY_PLATFORM_WEBHOOK_SECRET ?? null,
    },
  };
}

/** The currency a region is billed in, for a caller that only knows the region. */
export function currencyForRegion(region: BillingRegion): string {
  return REGION_CURRENCY[region];
}

export interface PlatformOrderRequest {
  /** Minor units. Razorpay's own unit, and the one `billing_orders` stores. */
  amountMinor: number;
  currency: string;
  /** Our `billing_orders.id`, echoed back on every webhook. */
  receipt: string;
  notes?: Record<string, string>;
}

export interface PlatformOrderResult {
  /** `order_...`, stored as `billing_orders.provider_order_id`. */
  id: string;
  amountMinor: number;
  currency: string;
}

/**
 * Create a Razorpay Order.
 *
 * An ORDER rather than a Payment Link, which is the one meaningful difference
 * from the tenant-invoice path next door. A link is a URL a human shares; an
 * order is a handle a checkout widget completes against, which is what a
 * self-serve upgrade button needs. `receipt` carries our own order id so a
 * webhook can find the row without trusting anything in `notes`.
 *
 * `amountMinor` is passed through UNCHANGED. The invoice path multiplies by
 * 100 because its callers hold major units; every amount in this layer is
 * already minor units from `pricing.ts`, and a second multiplication here
 * would charge a hundred times the price. That is the single most expensive
 * mistake available in this file, which is why the parameter is named
 * `amountMinor` rather than `amount`.
 */
export async function createPlatformOrder(
  creds: PlatformGatewayCredentials,
  req: PlatformOrderRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<PlatformOrderResult> {
  const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
  const res = await fetchImpl("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({
      amount: req.amountMinor,
      currency: req.currency,
      receipt: req.receipt,
      // The platform never auto-captures: capture follows a verified webhook,
      // so that the only thing that can mark an order paid is a signed
      // delivery this code checked.
      payment_capture: 1,
      notes: { ...req.notes, auraOrderId: req.receipt },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Razorpay rejected the order (${res.status}): ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { id: string; amount: number; currency: string };
  return { id: body.id, amountMinor: body.amount, currency: body.currency };
}

/** Re-exported so a caller needs one import for the whole gateway surface. */
export const verifyPlatformSignature = verifyRazorpaySignature;

export interface PlatformCapture {
  /** `order_...` - what ties the delivery to a `billing_orders` row. */
  providerOrderId: string;
  /** `pay_...` - stored so a refund has something to name. */
  paymentId: string;
  amountMinor: number;
  currency: string;
}

/**
 * The captured payment inside an `order.paid` or `payment.captured` delivery.
 *
 * Null when the entity is missing, carries no order id, or is not `captured` -
 * an `authorized` payment is not money yet. The caller acknowledges a null and
 * does nothing, because a 200 with no effect is what stops Razorpay retrying
 * something we have decided to ignore.
 *
 * The AMOUNT comes from the payment, not the order: the order says what was
 * asked for and the payment says what was taken. The caller compares it to the
 * frozen `billing_orders.total_minor` and refuses a mismatch rather than
 * granting a plan for a partial payment.
 */
export function parsePlatformCapture(body: unknown): PlatformCapture | null {
  const entity = (body as { payload?: { payment?: { entity?: Record<string, unknown> } } })?.payload
    ?.payment?.entity;
  if (!entity) return null;
  const { id, order_id: orderId, amount, currency, status } = entity;
  if (typeof id !== "string" || !id) return null;
  if (typeof orderId !== "string" || !orderId) return null;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  if (typeof currency !== "string" || !currency) return null;
  if (status !== undefined && status !== "captured") return null;
  return {
    providerOrderId: orderId,
    paymentId: id,
    // Minor units in, minor units out. No division, for the same reason
    // createPlatformOrder does no multiplication.
    amountMinor: amount,
    currency: currency.toUpperCase(),
  };
}

/**
 * The provider's own event id, which is the idempotency key.
 *
 * Razorpay sends `x-razorpay-event-id` as a header and does not repeat it in
 * the body, so a delivery without it cannot be de-duplicated. The caller
 * refuses those rather than inventing a key from the payload: a synthesised
 * key that happened to collide would silently drop a real payment, and one
 * that happened not to collide would apply a retry twice.
 */
export function platformEventId(headers: Record<string, unknown>): string | null {
  const raw = headers["x-razorpay-event-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
