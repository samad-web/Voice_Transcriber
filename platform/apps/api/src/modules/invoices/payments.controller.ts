import {
  BadRequestException,
  Controller,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { createPaymentLink, resolveRazorpayCredentials } from "./razorpay";

/**
 * "Collect Payment" — a human click that creates a Razorpay Payment Link and
 * nothing more. It cannot mark anything paid; only razorpay-webhook.controller.ts,
 * verifying a signed delivery, does that. See razorpay.ts's header.
 */
@Controller("invoices")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class PaymentsController {
  constructor(private readonly db: DbService) {}

  @Post(":id/payment-link")
  @RequireCrmPermission("invoice", "edit")
  async createLink(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const scoped = scopeClause("invoice", recordScope, 2, "i");
      const {
        rows: [invoice],
      } = await client.query(
        `SELECT i.id, i.total, i.amount_paid, i.currency, i.invoice_number, i.contact_id,
                c.display_name, c.email, c.phone_prefix
           FROM invoices i
           LEFT JOIN contacts c ON c.id = i.contact_id
          WHERE i.id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!invoice) throw new NotFoundException("invoice not found");
      const due = Number(invoice.total) - Number(invoice.amount_paid);
      if (due <= 0) throw new BadRequestException("invoice has nothing outstanding");

      const {
        rows: [config],
      } = await client.query(
        `SELECT key_id, key_secret, webhook_secret, enabled FROM payment_gateway_config WHERE org_id = $1`,
        [orgId],
      );
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

      const {
        rows: [payment],
      } = await client.query(
        `INSERT INTO payments (org_id, invoice_id, provider, razorpay_payment_link_id, status, amount, currency)
         VALUES ($1, $2, 'razorpay', $3, 'created', $4, $5)
         RETURNING id, status, amount, currency, razorpay_payment_link_id, created_at`,
        [orgId, id, link.id, due, invoice.currency],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'payment.link_created', 'invoice', $2)`,
        [orgId, id],
      );

      return { payment, paymentLinkUrl: link.shortUrl };
    });
  }
}
