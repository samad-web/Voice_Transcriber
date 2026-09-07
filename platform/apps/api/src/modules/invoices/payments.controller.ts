import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { createPaymentLink, resolveRazorpayCredentials } from "./razorpay";
import { createCheckoutSession, resolveStripeCredentials } from "./stripe";

/**
 * "Collect Payment" - a human click that creates a Razorpay Payment Link and
 * nothing more. It cannot mark anything paid; only razorpay-webhook.controller.ts,
 * verifying a signed delivery, does that. See razorpay.ts's header.
 */
/** Which gateway. Razorpay by default - what every existing org already uses. */
const PaymentLinkBody = z.object({
  provider: z.enum(["razorpay", "stripe"]).default("razorpay"),
});

@Controller("invoices")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class PaymentsController {
  constructor(private readonly db: DbService) {}

  /**
   * A payment link for one invoice, through whichever gateway suits it.
   *
   * ── WHY THE GATEWAY IS A PARAMETER AND NOT A SETTING ────────────────────
   *
   * "Which gateway" is decided by WHO IS PAYING, not once per company. The
   * tenants this sells to invoice Indian customers in rupees through Razorpay
   * and foreign ones through Stripe, often in the same week, so a per-org
   * default would be wrong on half the invoices.
   *
   * The default is Razorpay because that is what every existing org is already
   * using and an unqualified request must keep meaning what it meant. The
   * gateway is then recorded on the INVOICE, so re-sending it later cannot
   * quietly switch gateways and hand the customer two links to the same money.
   */
  @Post(":id/payment-link")
  @RequireCrmPermission("invoice", "edit")
  async createLink(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
    @Body() body?: unknown,
  ) {
    const parsed = PaymentLinkBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const gateway = parsed.data.provider;
    return this.db.withOrg(orgId, async (client) => {
      const scoped = scopeClause("invoice", recordScope, 2, "i");
      const {
        rows: [invoice],
      } = await client.query(
        `SELECT i.id, i.total, i.amount_paid, i.currency, i.invoice_number, i.contact_id,
                i.payment_provider,
                c.display_name, c.email, c.phone_prefix
           FROM invoices i
           LEFT JOIN contacts c ON c.id = i.contact_id
          WHERE i.id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!invoice) throw new NotFoundException("invoice not found");
      const due = Number(invoice.total) - Number(invoice.amount_paid);
      if (due <= 0) throw new BadRequestException("invoice has nothing outstanding");

      // Already sent through the other gateway? Refuse rather than issue a
      // second link. Two live links for one invoice means the customer can pay
      // twice, and reconciling that is somebody's afternoon.
      if (invoice.payment_provider && invoice.payment_provider !== gateway) {
        throw new BadRequestException(
          `this invoice already has a ${invoice.payment_provider} link - void it before sending a ${gateway} one`,
        );
      }

      const {
        rows: [config],
      } = await client.query(
        `SELECT key_id, key_secret, webhook_secret, enabled
           FROM payment_gateway_config WHERE org_id = $1 AND provider = $2`,
        [orgId, gateway],
      );

      let payment;
      let paymentLinkUrl: string;

      if (gateway === "stripe") {
        const creds = resolveStripeCredentials(config ?? null);
        if (!creds) {
          throw new ServiceUnavailableException(
            "no Stripe credentials configured for this org and no platform default is set",
          );
        }
        const session = await createCheckoutSession(creds, {
          amount: due,
          currency: invoice.currency,
          description: `Invoice ${invoice.invoice_number}`,
          referenceId: invoice.id,
          customerEmail: invoice.email,
        });
        const inserted = await client.query(
          `INSERT INTO payments (org_id, invoice_id, provider, stripe_session_id, status, amount, currency)
           VALUES ($1, $2, 'stripe', $3, 'created', $4, $5)
           RETURNING id, status, amount, currency, stripe_session_id, created_at`,
          [orgId, id, session.id, due, invoice.currency],
        );
        payment = inserted.rows[0];
        paymentLinkUrl = session.url;
      } else {
        const creds = resolveRazorpayCredentials(config ?? null);
        if (!creds) {
          throw new ServiceUnavailableException(
            "no Razorpay credentials configured for this org and no platform default is set",
          );
        }
        const link = await createPaymentLink(creds, {
          amount: due,
          currency: invoice.currency,
          description: `Invoice ${invoice.invoice_number}`,
          referenceId: invoice.id,
          customerName: invoice.display_name,
          customerEmail: invoice.email,
        });
        const inserted = await client.query(
          `INSERT INTO payments (org_id, invoice_id, provider, razorpay_payment_link_id, status, amount, currency)
           VALUES ($1, $2, 'razorpay', $3, 'created', $4, $5)
           RETURNING id, status, amount, currency, razorpay_payment_link_id, created_at`,
          [orgId, id, link.id, due, invoice.currency],
        );
        payment = inserted.rows[0];
        paymentLinkUrl = link.shortUrl;
      }

      await client.query(`UPDATE invoices SET payment_provider = $2 WHERE id = $1`, [id, gateway]);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'payment.link_created', 'invoice', $3)`,
        [orgId, req.principal?.userId ?? "dev-admin", id],
      );

      return { payment, paymentLinkUrl, provider: gateway };
    });
  }
}
