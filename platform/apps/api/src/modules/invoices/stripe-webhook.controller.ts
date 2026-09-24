import { Controller, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { DbService } from "../../db/db.service";
import { RealtimeService } from "../realtime/realtime.service";
import { applyGatewayPayment, auditMeta, type ApplyOutcome } from "./apply-gateway-payment";
import { parseStripePaid, resolveStripeCredentials, verifyStripeSignature } from "./stripe";

/**
 * One shared endpoint for every org's Stripe account (migration 0099).
 *
 * A deliberate twin of razorpay-webhook.controller.ts, including the order of
 * operations, which is the part that matters: resolve the candidate org from
 * the (untrusted) session id FIRST, then verify the signature with THAT org's
 * own secret. Verifying first is impossible here - which secret to use is
 * exactly what is unknown until the org is known - and the untrusted lookup is
 * safe because it only selects a row; nothing is written before the signature
 * passes.
 *
 * Unauthenticated by necessity: Stripe cannot present an admin key. Registered
 * in guard-mounting.spec.ts's UNGUARDED list, same class of exception as the
 * Razorpay and messaging webhooks.
 *
 * ── ALWAYS 200 ──────────────────────────────────────────────────────────────
 *
 * Unknown session, bad signature, an event we do not act on - all answered
 * `{ ok: true }`. A non-2xx makes Stripe retry with backoff for three days, so
 * a delivery this app has decided to ignore would be re-delivered hundreds of
 * times. The distinction between "processed" and "ignored" is deliberately not
 * disclosed to the caller either.
 *
 * ── THIS IS THE ONLY WAY AN INVOICE BECOMES PAID THROUGH STRIPE ─────────────
 *
 * Creating a checkout session does not, and neither does a browser arriving at
 * the success URL - which proves only that a browser arrived. The rule 0060
 * states for Razorpay holds here without exception.
 */
@Controller("webhooks/stripe")
export class StripeWebhookController {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  @Post()
  async receive(@Req() req: RawBodyRequest<Request>) {
    const rawBody = req.rawBody;
    const signature = req.headers["stripe-signature"] as string | undefined;
    if (!rawBody) return { ok: true };

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: true };
    }

    const paid = parseStripePaid(parsed);
    if (!paid) return { ok: true };

    const admin = this.db.adminPool();
    const {
      rows: [row],
    } = await admin.query<{ org_id: string; invoice_id: string; payment_row_id: string }>(
      `SELECT p.org_id, p.invoice_id, p.id AS payment_row_id
         FROM payments p
        WHERE p.stripe_session_id = $1`,
      [paid.sessionId],
    );
    if (!row) return { ok: true };

    const {
      rows: [config],
    } = await admin.query(
      `SELECT key_id, key_secret, webhook_secret, enabled
         FROM payment_gateway_config WHERE org_id = $1 AND provider = 'stripe'`,
      [row.org_id],
    );
    const creds = resolveStripeCredentials(config ?? null);
    // No webhook secret means we cannot tell a real delivery from a forged
    // one, so nothing is believed. Refusing to act is the only safe answer -
    // the alternative is an endpoint anybody can POST "paid" to.
    if (!creds?.webhookSecret) return { ok: true };
    if (!verifyStripeSignature(rawBody, signature, creds.webhookSecret)) return { ok: true };

    // Idempotent on the payment intent (payments.gateway_payment_id, unique per
    // provider - migration 0139), not on the event id: Stripe gives every
    // delivery its own event id, so an event-id key would credit a second
    // event about the same payment. Credits `amount_total` - what Stripe
    // took - capped at the outstanding balance, in the same transaction as the
    // claim. See apply-gateway-payment.ts.
    // A "paid" session reporting no amount has nothing honest to credit.
    if (!(paid.amount > 0)) return { ok: true };
    const gatewayPaymentId = paid.paymentIntentId ?? paid.sessionId;
    let outcome: ApplyOutcome = { applied: false, reason: "duplicate" };
    try {
      outcome = await this.db.withOrg(row.org_id, async (client) => {
        const result = await applyGatewayPayment(client, {
          paymentRowId: row.payment_row_id,
          invoiceId: row.invoice_id,
          provider: "stripe",
          gatewayPaymentId,
          amountCaptured: paid.amount,
          currency: paid.currency,
          stripePaymentIntentId: paid.paymentIntentId,
        });
        if (result.applied) {
          await client.query(
            `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
             VALUES ($1, 'system', 'stripe-webhook', 'payment.captured', 'invoice', $2, $3)`,
            [row.org_id, row.invoice_id, JSON.stringify(auditMeta(gatewayPaymentId, paid.amount, paid.currency, result))],
          );
        }
        return result;
      });
    } catch (err: any) {
      // 23505: the intent is already held by another org's row - a crossed or
      // forged delivery. Acknowledged, never credited twice.
      if (err?.code !== "23505") throw err;
    }

    // Parity with Razorpay: someone is watching this invoice for "paid". The
    // global interceptor cannot announce this route (no tenant guard ran), and
    // only a delivery that actually applied money announces anything.
    if (outcome.applied) {
      this.realtime.publish({
        orgId: row.org_id,
        topic: "invoice",
        action: "updated",
        id: row.invoice_id,
        at: new Date().toISOString(),
      });
    }

    return { ok: true };
  }
}
