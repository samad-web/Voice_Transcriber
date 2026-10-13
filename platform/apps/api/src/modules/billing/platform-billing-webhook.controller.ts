import { Controller, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { DbService } from "../../db/db.service";
import { BillingOrdersService } from "./billing-orders.service";
import { SignupService } from "../signup/signup.service";
import {
  parsePlatformCapture,
  platformEventId,
  resolvePlatformGateway,
  verifyPlatformSignature,
} from "./platform-razorpay";

/**
 * Razorpay telling us a tenant paid their subscription.
 *
 * ── THE ONLY WAY AN ORDER BECOMES PAID WITHOUT A HUMAN ──────────────────────
 *
 * Creating an order (`BillingOrdersService.create`) never marks anything paid.
 * This controller and an operator's explicit settle are the only two paths,
 * and this one requires a signature computed over the RAW request bytes with
 * our own webhook secret. Nothing in the payload is trusted before that check:
 * not the amount, not the order id, not the event type.
 *
 * Unlike `webhooks/razorpay` next door, which has to resolve a candidate org
 * from an untrusted payment-link id before it knows which TENANT's secret to
 * verify with, this endpoint always verifies with the PLATFORM's secret.
 * There is only one account - ours - so the signature is checked first and
 * nothing is read until it passes.
 *
 * ── UNAUTHENTICATED, AND ALWAYS 200 ─────────────────────────────────────────
 *
 * Razorpay cannot present an admin key, so this is on `guard-mounting.spec.ts`'s
 * UNGUARDED list - the same class of exception as `webhooks/razorpay` and
 * `messaging/webhook/:token`. It answers 200 to everything it decides not to
 * act on, because a non-200 makes Razorpay retry a delivery we have already
 * dismissed: an unknown order, a bad signature, an event type we ignore. None
 * of those distinctions is disclosed to the caller.
 *
 * ── A RETRY MUST NOT GRANT A SECOND MONTH ───────────────────────────────────
 *
 * Razorpay retries. The provider's own event id goes into
 * `billing_webhook_events`, which is UNIQUE on (provider, event_id): the
 * second delivery loses the INSERT and returns without settling. A delivery
 * with no event id header cannot be de-duplicated at all, so it is refused
 * rather than given a synthesised key - a key that happened to collide would
 * silently drop a real payment, and one that happened not to would apply a
 * retry twice. `settle()` is idempotent on the order's own status as well, so
 * there are two independent reasons a replay is safe.
 */
@Controller("webhooks/platform-billing")
export class PlatformBillingWebhookController {
  constructor(
    private readonly db: DbService,
    private readonly orders: BillingOrdersService,
    private readonly signups: SignupService,
  ) {}

  @Post("razorpay")
  async receive(@Req() req: RawBodyRequest<Request>): Promise<{ ok: true }> {
    const rawBody = req.rawBody;
    if (!rawBody) return { ok: true };

    // The secret, before anything else. With no platform keys configured there
    // is nothing this endpoint could legitimately receive, so it accepts and
    // discards - which is the right behaviour for a URL that exists before the
    // integration does.
    const gateway = resolvePlatformGateway("INR");
    if (gateway.provider !== "razorpay" || !gateway.creds.webhookSecret) {
      return { ok: true };
    }

    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    if (!verifyPlatformSignature(rawBody, signature, gateway.creds.webhookSecret)) {
      return { ok: true };
    }

    const eventId = platformEventId(req.headers as Record<string, unknown>);
    if (!eventId) return { ok: true };

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: true };
    }
    const eventType = (parsed as { event?: string })?.event ?? null;
    const capture = parsePlatformCapture(parsed);

    const admin = this.db.adminPool();

    // Claim the delivery FIRST. Losing this INSERT is the whole de-duplication
    // mechanism, and claiming before doing the work means a crash halfway
    // leaves the row with `applied_at` null - which is visible, and which an
    // operator can settle by hand, rather than invisible.
    const claim = await admin.query<{ id: string }>(
      `INSERT INTO billing_webhook_events (provider, event_id, event_type, payload)
            VALUES ('razorpay', $1, $2, $3::jsonb)
       ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id`,
      [eventId, eventType, JSON.stringify(parsed ?? {})],
    );
    if (claim.rowCount === 0) return { ok: true };
    const eventRowId = claim.rows[0].id;

    if (!capture) return { ok: true };

    // A SELF-SERVE signup has no tenant yet, so it has no `billing_orders` row
    // to find - the order belongs to an org that does not exist until this
    // webhook creates it. Check that table first, and if the payment is a
    // signup's, promote it into a tenant and stop here. `billing_orders` is
    // written by the provisioning transaction itself, once there is an org to
    // hang it on.
    const {
      rows: [signup],
    } = await admin.query<{ id: string; status: string }>(
      `SELECT id, status FROM org_signups
        WHERE provider = 'razorpay' AND provider_order_id = $1`,
      [capture.providerOrderId],
    );
    if (signup) {
      await admin.query(
        `UPDATE org_signups
            SET status = CASE WHEN status = 'provisioned' THEN status ELSE 'paid' END,
                provider_payment_id = $2,
                paid_at = COALESCE(paid_at, now()),
                updated_at = now()
          WHERE id = $1`,
        [signup.id, capture.paymentId],
      );
      try {
        await this.signups.provisionFromSignup(signup.id);
        await admin.query(`UPDATE billing_webhook_events SET applied_at = now() WHERE id = $1`, [
          eventRowId,
        ]);
      } catch (err) {
        // Recorded, not rethrown, and still a 200: Razorpay retries for 24
        // hours and then DISABLES the endpoint, which would take down
        // provisioning for every later customer too. The row stays 'failed'
        // and the reconciliation sweep is what actually retries it.
        await admin
          .query(`UPDATE billing_webhook_events SET error = $2 WHERE id = $1`, [
            eventRowId,
            err instanceof Error ? err.message : String(err),
          ])
          .catch(() => undefined);
      }
      return { ok: true };
    }

    const {
      rows: [order],
    } = await admin.query<{ id: string }>(
      `SELECT id FROM billing_orders
        WHERE provider = 'razorpay' AND provider_order_id = $1`,
      [capture.providerOrderId],
    );
    if (!order) return { ok: true };

    await admin.query(`UPDATE billing_webhook_events SET order_id = $2 WHERE id = $1`, [
      eventRowId,
      order.id,
    ]);

    try {
      await this.orders.settle(order.id, {
        provider: "razorpay",
        providerPaymentId: capture.paymentId,
        paidMinor: capture.amountMinor,
      });
      await admin.query(`UPDATE billing_webhook_events SET applied_at = now() WHERE id = $1`, [
        eventRowId,
      ]);
    } catch (err) {
      // The error is RECORDED and the delivery still acknowledged. A 500 here
      // would make Razorpay retry, the retry would lose the event-id INSERT,
      // and the failure would then be invisible forever. A stored error with
      // no `applied_at` is a row an operator can find and act on.
      const message = err instanceof Error ? err.message : String(err);
      await admin.query(`UPDATE billing_webhook_events SET error = $2 WHERE id = $1`, [
        eventRowId,
        message.slice(0, 2000),
      ]);
      console.error(`platform billing webhook: settling order ${order.id}:`, err);
    }

    return { ok: true };
  }
}
