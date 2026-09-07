import { createHmac, timingSafeEqual } from "node:crypto";
import { decryptSecret } from "@aura/db";

/**
 * Stripe, for the invoices Razorpay is the wrong gateway for.
 *
 * A deliberate near-twin of razorpay.ts: same credential resolution, same
 * "creating a link never marks anything paid" rule, same fetch-only
 * implementation with no SDK. The two files are siblings rather than one
 * abstraction because the gateways genuinely differ where it matters - Stripe
 * signs with a timestamped scheme and takes amounts in the currency's minor
 * unit only for some currencies - and an interface that hid those differences
 * would have to be re-read every time either one changed.
 *
 * ── NO SDK, ON PURPOSE ──────────────────────────────────────────────────────
 *
 * Two endpoints and one signature check. Stripe's Node library is a large
 * dependency that pins its own API version and pulls a transitive tree into a
 * service that currently has none; razorpay.ts made the same call for the same
 * reason and has needed nothing since.
 */

export interface StripeCredentials {
  /** Publishable key - not a secret, kept so the console can name the account. */
  publishableKey: string;
  secretKey: string;
  webhookSecret: string | null;
}

/**
 * Tenant-then-env precedence, identical to Razorpay's: an org with its own
 * Stripe account uses it, one without falls back to the platform's env vars.
 */
export function resolveStripeCredentials(
  orgRow: {
    key_id: string | null;
    key_secret: string | null;
    webhook_secret: string | null;
    enabled: boolean;
  } | null,
  env: NodeJS.ProcessEnv = process.env,
): StripeCredentials | null {
  if (orgRow?.enabled && orgRow.key_id && orgRow.key_secret) {
    return {
      publishableKey: orgRow.key_id,
      secretKey: decryptSecret(orgRow.key_secret) ?? "",
      webhookSecret: decryptSecret(orgRow.webhook_secret),
    };
  }
  if (env.STRIPE_SECRET_KEY) {
    return {
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? "",
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    };
  }
  return null;
}

export interface StripeLinkRequest {
  amount: number;
  currency: string;
  description: string;
  /** The invoice id. Comes back on the webhook as client_reference_id. */
  referenceId: string;
  customerEmail?: string | null;
}

export interface StripeLinkResult {
  id: string;
  url: string;
}

/**
 * Currencies Stripe counts in whole units rather than hundredths.
 *
 * Getting this wrong is not a rounding error - it is a bill for a hundred
 * times the right amount, or a hundredth. Yen and won have no minor unit at
 * all, so `¥5000` is `5000` and not `500000`. This is the shortest list that
 * covers what an Indian SMB invoicing abroad actually sees; anything else
 * falls through to the standard two-decimal rule, which is correct for INR,
 * USD, EUR, GBP and AED.
 */
const ZERO_DECIMAL = new Set(["jpy", "krw", "vnd", "clp", "isk", "ugx", "xaf", "xof"]);

export function toMinorUnits(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase())
    ? Math.round(amount)
    : Math.round(amount * 100);
}

/**
 * A Checkout Session: Stripe's hosted payment page for one amount.
 *
 * Checkout and not a Payment Link, because a Payment Link is a REUSABLE object
 * - the same URL can be paid any number of times by anyone who has it, which
 * for an invoice is exactly wrong. A session is for one payment and expires.
 *
 * The form encoding is Stripe's own: it takes
 * application/x-www-form-urlencoded with bracketed nested keys, not JSON. That
 * is why this builds a URLSearchParams rather than a body object.
 */
export async function createCheckoutSession(
  creds: StripeCredentials,
  req: StripeLinkRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<StripeLinkResult> {
  const form = new URLSearchParams({
    mode: "payment",
    // Carried through to the webhook, and the only thing that ties the payment
    // back to an invoice. Stripe echoes it verbatim.
    client_reference_id: req.referenceId,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": req.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(toMinorUnits(req.amount, req.currency)),
    "line_items[0][price_data][product_data][name]": req.description.slice(0, 250),
    // Stripe requires a return URL. It is deliberately NOT a page that marks
    // anything paid: a browser arriving at a success URL proves only that a
    // browser arrived. The signed webhook is the only thing that moves an
    // invoice to paid, which is the rule 0060 states and this preserves.
    success_url: `${process.env.PUBLIC_APP_URL ?? "https://aura.local"}/pay/thanks`,
    cancel_url: `${process.env.PUBLIC_APP_URL ?? "https://aura.local"}/pay/cancelled`,
  });
  if (req.customerEmail) form.set("customer_email", req.customerEmail);

  const res = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${creds.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(detail?.error?.message ?? `Stripe refused the request (${res.status})`);
  }
  const body = (await res.json()) as { id?: string; url?: string };
  if (!body.id || !body.url) throw new Error("Stripe returned a session with no URL");
  return { id: body.id, url: body.url };
}

/**
 * Verify `Stripe-Signature`.
 *
 * The header is `t=<unix>,v1=<hex>,v1=<hex>` and the signed payload is
 * `${t}.${rawBody}` - the timestamp is INSIDE the signed material, which is
 * what makes a replay detectable at all. Several `v1` values can appear during
 * a secret rotation and any one matching is a pass.
 *
 * The tolerance is not optional politeness. Without it a delivery captured
 * today is valid forever, so an attacker who once saw a "payment succeeded"
 * body could mark any future invoice paid by replaying it. Five minutes is
 * Stripe's own recommendation.
 */
export function verifyStripeSignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
  toleranceSeconds = 300,
  now: number = Date.now(),
): boolean {
  if (!header || !secret) return false;

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") timestamp = value;
    else if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return false;
  if (Math.abs(now / 1000 - sentAt) > toleranceSeconds) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${raw.toString("utf8")}`)
    .digest("hex");

  return signatures.some((candidate) => {
    // Length first: timingSafeEqual throws rather than returning false when
    // the buffers differ in size.
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(expected, "utf8"));
  });
}

export interface StripePaidEvent {
  eventId: string;
  sessionId: string;
  paymentIntentId: string | null;
  invoiceId: string | null;
  amount: number;
  currency: string;
}

/**
 * The one event that means money arrived.
 *
 * `checkout.session.completed` with `payment_status: "paid"` - both, because
 * a completed session in a delayed-settlement flow (bank debits) is completed
 * and NOT paid, and treating those as payment would mark invoices settled days
 * before the money exists. Everything else returns null and is acknowledged
 * without acting, which is what stops Stripe retrying it forever.
 */
export function parseStripePaid(body: unknown): StripePaidEvent | null {
  const event = body as {
    id?: string;
    type?: string;
    data?: {
      object?: {
        id?: string;
        payment_intent?: string;
        client_reference_id?: string;
        payment_status?: string;
        amount_total?: number;
        currency?: string;
      };
    };
  };
  if (!event?.id || event.type !== "checkout.session.completed") return null;

  const session = event.data?.object;
  if (!session?.id || session.payment_status !== "paid") return null;

  return {
    eventId: event.id,
    sessionId: session.id,
    paymentIntentId: session.payment_intent ?? null,
    invoiceId: session.client_reference_id ?? null,
    // Back to major units for the ledger, which stores what a person would
    // read on the invoice.
    amount: fromMinorUnits(session.amount_total ?? 0, session.currency ?? "usd"),
    currency: (session.currency ?? "usd").toUpperCase(),
  };
}

export function fromMinorUnits(amount: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toLowerCase()) ? amount : amount / 100;
}
