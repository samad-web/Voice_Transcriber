import { Controller, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { DbService } from "../../db/db.service";
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
  constructor(private readonly db: DbService) {}

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

    // The claim and the writes in ONE transaction, for the reason the Razorpay
    // controller spells out: with the claim committed separately, a crash
    // between it and the writes leaves Stripe's retry seeing "already
    // processed" and the invoice stuck unpaid forever, with the money taken.
    await this.db.withOrg(row.org_id, async (client) => {
      const inserted = await client.query(
        `INSERT INTO payment_webhook_events (provider, event_id) VALUES ('stripe', $1)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id`,
        [paid.eventId],
      );
      if (inserted.rows.length === 0) return;

      await client.query(
        `UPDATE payments
            SET status = 'paid',
                stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
                captured_at = now()
          WHERE id = $1`,
        [row.payment_row_id, paid.paymentIntentId],
      );
      // status <> 'void', matching Razorpay: a delayed delivery for an invoice
      // voided in the meantime must not resurrect it or add to a balance
      // nobody owes.
      await client.query(
        `UPDATE invoices SET
            amount_paid = amount_paid + (SELECT amount FROM payments WHERE id = $2),
            status = CASE
                       WHEN amount_paid + (SELECT amount FROM payments WHERE id = $2) >= total
                       THEN 'paid' ELSE status
                     END
          WHERE id = $1 AND status <> 'void'`,
        [row.invoice_id, row.payment_row_id],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'system', 'stripe-webhook', 'payment.captured', 'invoice', $2)`,
        [row.org_id, row.invoice_id],
      );
    });

    return { ok: true };
  }
}
