import { createHmac, timingSafeEqual } from "node:crypto";
import { decryptSecret } from "@aura/db";

/**
 * Razorpay Payment Links - collection only, never a charge this platform
 * initiates on its own. A human clicks "Collect Payment" on an invoice; the
 * link is created with notify:{sms:false,email:false} so THEY share it, the
 * same shape proven in the Kailash reference build. An invoice can only ever
 * be marked paid by razorpay-webhook.controller.ts verifying a real signed
 * delivery - creating a link here never touches `invoices.status`.
 */

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string | null;
}

/**
 * Tenant-then-env precedence, same shape this codebase already uses for
 * CRM-connector/email config: an org with its own Razorpay account uses it,
 * one without falls back to the platform's env vars so a fresh org can start
 * collecting payment without configuring anything first.
 */
export function resolveRazorpayCredentials(
  orgRow: { key_id: string | null; key_secret: string | null; webhook_secret: string | null; enabled: boolean } | null,
  env: NodeJS.ProcessEnv = process.env,
): RazorpayCredentials | null {
  if (orgRow?.enabled && orgRow.key_id && orgRow.key_secret) {
    return {
      keyId: orgRow.key_id,
      keySecret: decryptSecret(orgRow.key_secret) ?? "",
      webhookSecret: decryptSecret(orgRow.webhook_secret),
    };
  }
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
    return {
      keyId: env.RAZORPAY_KEY_ID,
      keySecret: env.RAZORPAY_KEY_SECRET,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? null,
    };
  }
  return null;
}

export interface PaymentLinkRequest {
  amount: number;
  currency: string;
  description: string;
  referenceId: string;
  customerName?: string | null;
  customerEmail?: string | null;
  customerContact?: string | null;
}

export interface PaymentLinkResult {
  id: string;
  shortUrl: string;
}

export async function createPaymentLink(
  creds: RazorpayCredentials,
  req: PaymentLinkRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<PaymentLinkResult> {
  const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
  const res = await fetchImpl("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({
      // Amount is in the smallest currency unit (paise for INR) - Razorpay's
      // own convention, not this app's; the API layer converts before calling in.
      amount: Math.round(req.amount * 100),
      currency: req.currency,
      description: req.description,
      reference_id: req.referenceId,
      customer: {
        name: req.customerName ?? undefined,
        email: req.customerEmail ?? undefined,
        contact: req.customerContact ?? undefined,
      },
      notify: { sms: false, email: false },
      notes: { referenceId: req.referenceId },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Razorpay rejected the payment link (${res.status}): ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { id: string; short_url: string };
  return { id: body.id, shortUrl: body.short_url };
}

/**
 * Verifies Razorpay's `x-razorpay-signature` header against the RAW request
 * body bytes (not the re-serialised parsed object - see main.ts's `rawBody`
 * comment for why that distinction matters). Constant-time compare, same
 * technique used everywhere else in this codebase that checks an HMAC.
 */
export function verifyRazorpaySignature(rawBody: Buffer, signatureHeader: string | undefined, webhookSecret: string): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
