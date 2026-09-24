import { Controller, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { DbService } from "../../db/db.service";
import { RealtimeService } from "../realtime/realtime.service";
import { applyGatewayPayment, auditMeta, type ApplyOutcome } from "./apply-gateway-payment";
import { parseRazorpayCapture, resolveRazorpayCredentials, verifyRazorpaySignature } from "./razorpay";

/**
 * One shared endpoint for every org's Razorpay account - most orgs collect
 * through the platform's own account (env-var credentials), so a single URL
 * has to receive all of them and figure out which org a delivery belongs to
 * from the payload itself, the same way Stripe Connect webhooks resolve an
 * `account` field before verifying. The order is deliberate and matters:
 * resolve the candidate org from the (untrusted) payment_link id, THEN verify
 * the signature with THAT org's own secret - verifying first is impossible
 * here because which secret to use is exactly what's unknown until the org is
 * known.
 *
 * Unauthenticated by necessity (Razorpay cannot present an admin key) - see
 * guard-mounting.spec.ts's UNGUARDED list, same class of exception as
 * messaging/webhook/:token. Always answers 200 so Razorpay's retry logic
 * doesn't hammer a delivery this app has already decided to ignore (unknown
 * link, bad signature, or an event type it doesn't act on) - those cases are
 * silently accepted, never surfaced as an error to the sender.
 *
 * The ONLY way `invoices.status` becomes 'paid' is through this controller.
 * Creating a payment link (payments.controller.ts) never does.
 */
@Controller("webhooks/razorpay")
export class RazorpayWebhookController {
  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeService,
  ) {}

  @Post()
  async receive(@Req() req: RawBodyRequest<Request>) {
    const rawBody = req.rawBody;
    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    if (!rawBody) return { ok: true };

    let parsed: any;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: true };
    }

    const linkId: string | undefined = parsed?.payload?.payment_link?.entity?.id;
    const event: string | undefined = parsed?.event;
    if (!linkId || !event) return { ok: true };

    const admin = this.db.adminPool();
    const {
      rows: [row],
    } = await admin.query<{ org_id: string; invoice_id: string; payment_row_id: string }>(
      `SELECT p.org_id, p.invoice_id, p.id AS payment_row_id
         FROM payments p
        WHERE p.razorpay_payment_link_id = $1`,
      [linkId],
    );
    if (!row) return { ok: true }; // unknown link - never disclose that distinction to the caller

    // provider = 'razorpay': since 0099 an org can hold a Stripe row too, and
    // without the filter this could verify against the Stripe secret.
    const {
      rows: [config],
    } = await admin.query(
      `SELECT key_id, key_secret, webhook_secret, enabled
         FROM payment_gateway_config WHERE org_id = $1 AND provider = 'razorpay'`,
      [row.org_id],
    );
    const creds = resolveRazorpayCredentials(config ?? null);
    if (!creds?.webhookSecret) return { ok: true };
    if (!verifyRazorpaySignature(rawBody, signature, creds.webhookSecret)) return { ok: true };

    if (event !== "payment_link.paid" && event !== "payment.captured") return { ok: true };

    // Everything below is read only AFTER the signature passed.
    const captured = parseRazorpayCapture(parsed);
    // No payment id means nothing to key idempotency on, and no amount means
    // nothing honest to credit - acknowledged, not acted on.
    if (!captured) return { ok: true };

    // Idempotency lives in applyGatewayPayment: keyed on the Razorpay payment
    // id (unique per provider, migration 0139), NOT on the event. Razorpay
    // sends payment_link.paid AND payment.captured for one payment; the old
    // `${event}:${paymentId}` key credited both. The claim and the credit
    // share this transaction, so a crash between them cannot strand a
    // claimed-but-uncredited payment.
    let outcome: ApplyOutcome = { applied: false, reason: "duplicate" };
    try {
      outcome = await this.db.withOrg(row.org_id, async (client) => {
        const result = await applyGatewayPayment(client, {
          paymentRowId: row.payment_row_id,
          invoiceId: row.invoice_id,
          provider: "razorpay",
          gatewayPaymentId: captured.paymentId,
          amountCaptured: captured.amount,
          currency: captured.currency,
        });
        if (result.applied) {
          await client.query(
            `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
             VALUES ($1, 'system', 'razorpay-webhook', 'payment.captured', 'invoice', $2, $3)`,
            [row.org_id, row.invoice_id, JSON.stringify(auditMeta(captured.paymentId, captured.amount, captured.currency, result))],
          );
        }
        return result;
      });
    } catch (err: any) {
      // 23505: this payment id is already held by another org's row. Only a
      // crossed or forged delivery gets here; acting on it would credit money
      // twice. Acknowledged so Razorpay stops retrying.
      if (err?.code !== "23505") throw err;
    }
    // Set only on the delivery that actually applied the payment, so a
    // Razorpay retry does not announce the same money twice.
    const applied = outcome.applied;

    // Somebody sent an invoice and is waiting to see it marked paid. The
    // global interceptor cannot announce this route - Razorpay presents no
    // credential of ours, so no guard resolved the tenant - and the org is
    // only known here, after the payment link was matched to it.
    if (applied) {
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
