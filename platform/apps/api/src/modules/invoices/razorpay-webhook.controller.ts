import { Controller, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { DbService } from "../../db/db.service";
import { resolveRazorpayCredentials, verifyRazorpaySignature } from "./razorpay";

/**
 * One shared endpoint for every org's Razorpay account — most orgs collect
 * through the platform's own account (env-var credentials), so a single URL
 * has to receive all of them and figure out which org a delivery belongs to
 * from the payload itself, the same way Stripe Connect webhooks resolve an
 * `account` field before verifying. The order is deliberate and matters:
 * resolve the candidate org from the (untrusted) payment_link id, THEN verify
 * the signature with THAT org's own secret — verifying first is impossible
 * here because which secret to use is exactly what's unknown until the org is
 * known.
 *
 * Unauthenticated by necessity (Razorpay cannot present an admin key) — see
 * guard-mounting.spec.ts's UNGUARDED list, same class of exception as
 * messaging/webhook/:token. Always answers 200 so Razorpay's retry logic
 * doesn't hammer a delivery this app has already decided to ignore (unknown
 * link, bad signature, or an event type it doesn't act on) — those cases are
 * silently accepted, never surfaced as an error to the sender.
 *
 * The ONLY way `invoices.status` becomes 'paid' is through this controller.
 * Creating a payment link (payments.controller.ts) never does.
 */
@Controller("webhooks/razorpay")
export class RazorpayWebhookController {
  constructor(private readonly db: DbService) {}

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
    const paymentId: string | undefined = parsed?.payload?.payment?.entity?.id;
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
    if (!row) return { ok: true }; // unknown link — never disclose that distinction to the caller

    const {
      rows: [config],
    } = await admin.query(
      `SELECT key_id, key_secret, webhook_secret, enabled FROM payment_gateway_config WHERE org_id = $1`,
      [row.org_id],
    );
    const creds = resolveRazorpayCredentials(config ?? null);
    if (!creds?.webhookSecret) return { ok: true };
    if (!verifyRazorpaySignature(rawBody, signature, creds.webhookSecret)) return { ok: true };

    if (event !== "payment_link.paid" && event !== "payment.captured") return { ok: true };

    // Idempotency: Razorpay retries a delivery until it gets a 200, and this
    // controller always returns 200 — so the ledger, not the HTTP response,
    // is what prevents a replay from double-crediting the invoice.
    const eventKey = `${event}:${paymentId ?? linkId}`;
    const inserted = await admin.query(
      `INSERT INTO payment_webhook_events (provider, event_id) VALUES ('razorpay', $1)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [eventKey],
    );
    if (inserted.rows.length === 0) return { ok: true }; // already processed

    await admin.query(
      `UPDATE payments SET status = 'paid', razorpay_payment_id = COALESCE($2, razorpay_payment_id), captured_at = now()
        WHERE id = $1`,
      [row.payment_row_id, paymentId ?? null],
    );
    await admin.query(
      `UPDATE invoices SET
          amount_paid = amount_paid + (SELECT amount FROM payments WHERE id = $2),
          status = CASE WHEN amount_paid + (SELECT amount FROM payments WHERE id = $2) >= total THEN 'paid' ELSE status END
        WHERE id = $1`,
      [row.invoice_id, row.payment_row_id],
    );
    await admin.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'system', 'razorpay-webhook', 'payment.captured', 'invoice', $2)`,
      [row.org_id, row.invoice_id],
    );

    return { ok: true };
  }
}
