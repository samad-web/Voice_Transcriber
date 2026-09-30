import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { computeDocumentTotals, computeLineTotal, splitGst, type LineItemInput } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { orgGstStateCode, resolveGstTreatment } from "../../common/gst-treatment";
import { assertInOrg } from "../../common/org-references";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { readGatewayStates } from "./gateway-availability";
import { auditActor } from "../../common/audit-actor";

const LineItem = z.object({
  productId: z.string().uuid().nullish(),
  description: z.string().min(1).max(500),
  hsnSac: z.string().max(20).nullish(),
  quantity: z.number().min(0),
  unitPrice: z.number().min(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxRate: z.number().min(0).max(100).default(0),
});

const Discount = z.object({
  type: z.enum(["percent", "amount"]).nullable().default(null),
  value: z.number().min(0).default(0),
});

const CreateInvoiceBody = z.object({
  workspaceId: z.string().uuid().optional(),
  accountId: z.string().uuid().nullish(),
  contactId: z.string().uuid().nullish(),
  dealId: z.string().uuid().nullish(),
  quotationId: z.string().uuid().nullish(),
  currency: z.string().length(3).default("INR"),
  discount: Discount.default({ type: null, value: 0 }),
  // The rep states whether this is an intra-state sale; deriving it
  // automatically would need an org "home state" setting that doesn't exist
  // yet, and guessing wrong on a tax document is worse than asking. Stored on
  // `invoices.is_inter_state` (0139) so a later edit recomputes the same split.
  interState: z.boolean().default(false),
  customerGstin: z.string().max(20).nullish(),
  placeOfSupply: z.string().max(100).nullish(),
  dueDate: z.string().date().nullish(),
  notes: z.string().max(5000).nullish(),
  items: z.array(LineItem).min(1, "an invoice needs at least one line item"),
});

/**
 * The status moves a person may make by hand (doc 26 defect 4, section 6.1).
 *
 * `paid` is not among them, from anywhere: it is a claim that money arrived,
 * and only a recorded payment makes it (the signed gateway webhooks, via
 * apply-gateway-payment.ts). Before this, PATCH could set any status, `paid`
 * included, without touching `amount_paid` or `payments`.
 *
 *   draft   -> sent | void     issue it, or discard it (there is no DELETE yet)
 *   sent    -> overdue | void  overdue is a due-date label no job sets yet
 *   overdue -> sent | void
 *
 * `void` additionally needs no money received (checked in the handler) -
 * voiding a paid invoice is a refund or a credit note, which is F1. `paid` and
 * `void` are terminal here. Sending the CURRENT status is accepted as a no-op,
 * so a form that posts every field back does not fail on an unchanged value.
 * Mirrored for the UI in apps/web/app/(owner)/owner/invoices/actions.ts.
 */
export const MANUAL_STATUS_MOVES: Record<string, readonly string[]> = {
  draft: ["sent", "void"],
  sent: ["overdue", "void"],
  overdue: ["sent", "void"],
};

const UpdateInvoiceBody = z.object({
  accountId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  // Every stored value parses, so an unchanged status round-trips; which
  // CHANGES are allowed is MANUAL_STATUS_MOVES, enforced in the handler.
  status: z.enum(["draft", "sent", "paid", "overdue", "void"]).optional(),
  discount: Discount.optional(),
  interState: z.boolean().optional(),
  customerGstin: z.string().max(20).nullable().optional(),
  placeOfSupply: z.string().max(100).nullable().optional(),
  dueDate: z.string().date().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  items: z.array(LineItem).min(1).optional(),
});

const ListQuery = z.object({
  status: z.enum(["draft", "sent", "paid", "overdue", "void"]).optional(),
  /** Invoice number, or the name of the company or person it is for. */
  q: z.string().max(200).optional(),
  dealId: z.string().uuid().optional(),
  /** Everything raised for one person or company - the contact and account pages' reverse lookup (doc 23, H2). */
  contactId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// `tax_total` is derived rather than stored: the web has always rendered it and
// no column ever held it (doc 26 defect 5). F1 plans a stored column; until
// then the sum of the three GST heads is the tax on the document.
const INVOICE_COLUMNS = `id, workspace_id, account_id, contact_id, deal_id, quotation_id,
  invoice_number, status, currency, subtotal, discount_type, discount_value, cgst, sgst, igst,
  (cgst + sgst + igst) AS tax_total, is_inter_state, payment_provider,
  customer_gstin, place_of_supply, total, amount_paid, due_date, notes, owner_user_id,
  created_at, updated_at`;

/**
 * The same columns for the list query, which joins and so must qualify them -
 * `tax_total`'s expression included. Written out rather than derived from the
 * constant above: that one is also a `RETURNING` list, where a table alias is a
 * syntax error, and it already contains an expression that string surgery on
 * commas would not survive.
 */
const INVOICE_LIST_COLUMNS = `inv.id, inv.workspace_id, inv.account_id, inv.contact_id, inv.deal_id,
  inv.quotation_id, inv.invoice_number, inv.status, inv.currency, inv.subtotal, inv.discount_type,
  inv.discount_value, inv.cgst, inv.sgst, inv.igst,
  (inv.cgst + inv.sgst + inv.igst) AS tax_total, inv.is_inter_state, inv.payment_provider,
  inv.customer_gstin, inv.place_of_supply, inv.total, inv.amount_paid, inv.due_date, inv.notes,
  inv.owner_user_id, inv.created_at, inv.updated_at`;

/**
 * Who the invoice is for, resolved to a name. The list rendered no customer at
 * all, so a page of invoices was numbers and amounts with nothing to say whose
 * they were. LEFT JOIN: an invoice with no customer attached still belongs.
 */
const INVOICE_LIST_JOINS = `FROM invoices inv
    LEFT JOIN accounts a ON a.id = inv.account_id
    LEFT JOIN contacts c ON c.id = inv.contact_id`;

type QueryClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

@Controller("invoices")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class InvoicesController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireCrmPermission("invoice", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { status, q, dealId, contactId, accountId, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where = ["1=1"];
      const params: unknown[] = [];
      if (status) {
        params.push(status);
        where.push(`inv.status = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        // The customer's name as well as the number, because nobody remembers an
        // invoice number. A row with no customer simply does not match, which is
        // right: searching for a name should not return the unattached ones.
        where.push(`(inv.invoice_number ILIKE ${p} OR a.name ILIKE ${p} OR c.display_name ILIKE ${p})`);
      }
      if (dealId) {
        params.push(dealId);
        where.push(`inv.deal_id = $${params.length}`);
      }
      if (contactId) {
        params.push(contactId);
        where.push(`inv.contact_id = $${params.length}`);
      }
      if (accountId) {
        params.push(accountId);
        where.push(`inv.account_id = $${params.length}`);
      }
      if (recordScope.scope === "owned") {
        params.push(recordScope.userId);
        where.push(`inv.owner_user_id = $${params.length}`);
      }
      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${INVOICE_LIST_COLUMNS}, a.name AS account_name, c.display_name AS contact_name,
                count(*) OVER()::int AS total_count
           ${INVOICE_LIST_JOINS}
          WHERE ${where.join(" AND ")}
          ORDER BY inv.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return {
        invoices: rows.map(({ total_count: _t, ...row }) => row),
        total: rows[0]?.total_count ?? 0,
        limit,
        offset,
      };
    });
  }

  @Get(":id")
  @RequireCrmPermission("invoice", "view")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const scoped = scopeClause("invoice", recordScope, 2);
      const {
        rows: [invoice],
      } = await client.query(
        `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!invoice) throw new NotFoundException("invoice not found");
      const items = await this.fetchItems(client, id);
      const { rows: payments } = await client.query(
        `SELECT id, provider, status, amount, amount_captured, currency, razorpay_payment_link_id,
                created_at, captured_at
           FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      // Which gateways "Collect payment" can use - booleans only, so a manager
      // who may not open the owner-only payment settings can still pick one.
      const states = await readGatewayStates(client, orgId);
      const gateways = {
        razorpay: states.razorpay.available,
        stripe: states.stripe.available,
      };
      // The org's own GST state, so the console can say WHY it is showing
      // CGST + SGST rather than IGST - and recompute that as somebody changes
      // the place of supply, without asking the server again. Null when the
      // workspace has never saved a state, which is when the treatment stays a
      // question the rep answers.
      const homeStateCode = await orgGstStateCode(client, orgId);
      return { invoice, items, payments, gateways, homeStateCode };
    });
  }

  @Post()
  @RequireCrmPermission("invoice", "create")
  async create(
    @OrgId() orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = CreateInvoiceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    const invoice = await this.insertInvoice(orgId, p, null, recordScope, req);
    return invoice;
  }

  /** Clones a sent/accepted quotation's header + items into a brand new draft invoice. */
  @Post("from-quotation/:quotationId")
  @RequireCrmPermission("invoice", "create")
  async createFromQuotation(
    @OrgId() orgId: string,
    @Param("quotationId", ParseUUIDPipe) quotationId: string,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [quotation],
      } = await client.query(
        `SELECT account_id, contact_id, deal_id, currency, discount_type, discount_value
           FROM quotations WHERE id = $1`,
        [quotationId],
      );
      if (!quotation) throw new NotFoundException("quotation not found");
      // numeric columns come back from node-postgres as STRINGS (it never
      // guesses at float precision) - cast explicitly here rather than at the
      // zod boundary below, which is stricter than this codebase's other
      // "re-read a numeric column" call sites and would otherwise reject a
      // perfectly valid row with "expected number, received string".
      const { rows: qItems } = await client.query(
        `SELECT product_id AS "productId", description, quantity::float8 AS quantity,
                unit_price::float8 AS "unitPrice", discount_pct::float8 AS "discountPct",
                tax_rate::float8 AS "taxRate"
           FROM quotation_items WHERE quotation_id = $1 ORDER BY position ASC`,
        [quotationId],
      );
      if (qItems.length === 0) throw new BadRequestException("quotation has no line items");

      const p = CreateInvoiceBody.parse({
        accountId: quotation.account_id,
        contactId: quotation.contact_id,
        dealId: quotation.deal_id,
        quotationId,
        currency: quotation.currency,
        discount: { type: quotation.discount_type, value: Number(quotation.discount_value) },
        items: qItems,
      });
      return this.insertInvoice(orgId, p, client, recordScope, req);
    });
  }

  @Patch(":id")
  @RequireCrmPermission("invoice", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = UpdateInvoiceBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      // Foreign-key checks ignore RLS (doc 23, A2) - and this runs before the
      // line items below are replaced, so a rejected link writes nothing.
      await assertInOrg(client, orgId, {
        accountId: p.accountId,
        contactId: p.contactId,
        dealId: p.dealId,
      });

      const scoped = scopeClause("invoice", recordScope, 2);
      // FOR UPDATE: the status and money checks below must still hold when the
      // UPDATE runs, and a webhook crediting this invoice locks the same row.
      const {
        rows: [existing],
      } = await client.query(
        `SELECT id, status, amount_paid, discount_type, discount_value, is_inter_state,
                place_of_supply
           FROM invoices WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}
           FOR UPDATE`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!existing) throw new NotFoundException("invoice not found");

      const moneyReceived = Number(existing.amount_paid) > 0;
      if (p.status !== undefined && p.status !== existing.status) {
        if (p.status === "paid") {
          throw new ConflictException(
            "an invoice becomes paid only when a payment is recorded against it",
          );
        }
        if (!(MANUAL_STATUS_MOVES[existing.status] ?? []).includes(p.status)) {
          throw new ConflictException(`an invoice cannot move from ${existing.status} to ${p.status}`);
        }
        if (p.status === "void") {
          const {
            rows: [paid],
          } = await client.query(
            `SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1 AND status = 'paid'`,
            [id],
          );
          if (moneyReceived || paid.n > 0) {
            throw new ConflictException(
              "money has been received against this invoice - it cannot be voided",
            );
          }
        }
      }

      // Anything that moves the total or the GST split is refused once money
      // has been received or the invoice is closed: `amount_paid` was credited
      // against the old total, and rewriting a settled tax document is what a
      // credit note (F1) is for. Notes, due date and links stay editable.
      const rewritesMoney =
        p.items !== undefined || p.discount !== undefined || p.interState !== undefined;
      if (rewritesMoney && (moneyReceived || existing.status === "paid" || existing.status === "void")) {
        throw new ConflictException(
          existing.status === "void"
            ? "a void invoice cannot be changed"
            : "payment has been received against this invoice - its lines, discount and GST treatment are locked",
        );
      }

      let items: LineItemInput[];
      if (p.items) {
        await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
        await this.insertItems(client, orgId, id, p.items as any[]);
        items = p.items;
      } else {
        // Cast explicitly - see the matching comment in createFromQuotation().
        const { rows } = await client.query(
          `SELECT quantity::float8 AS quantity, unit_price::float8 AS "unitPrice",
                  discount_pct::float8 AS "discountPct", tax_rate::float8 AS "taxRate"
             FROM invoice_items WHERE invoice_id = $1`,
          [id],
        );
        items = rows;
      }

      const discount = p.discount ?? {
        type: existing.discount_type,
        value: Number(existing.discount_value),
      };
      const totals = computeDocumentTotals(items, discount);
      // Always recomputed, from the stored treatment when the edit does not
      // restate it. The old code kept the previous split whenever interState
      // was omitted, so a line edit left CGST/SGST summing to the OLD tax
      // against a NEW total (doc 26 defect 5).
      const stated: boolean = p.interState ?? existing.is_inter_state ?? false;
      // The place of supply as it will STAND after this update - the new one when
      // the edit sets it, the stored one otherwise. Deriving off `p` alone would
      // let a line edit fall back to the rep's old answer on an invoice whose
      // place of supply is perfectly well known.
      const placeOfSupply =
        p.placeOfSupply !== undefined ? p.placeOfSupply : (existing.place_of_supply ?? null);
      const treatment = await resolveGstTreatment(client, orgId, placeOfSupply, stated);
      const interState = treatment.interState;
      const gst = splitGst(totals.taxTotal, interState);

      const {
        rows: [invoice],
      } = await client.query(
        `UPDATE invoices SET
           account_id      = CASE WHEN $2::boolean THEN $3 ELSE account_id END,
           contact_id      = CASE WHEN $4::boolean THEN $5 ELSE contact_id END,
           deal_id         = CASE WHEN $6::boolean THEN $7 ELSE deal_id END,
           status          = COALESCE($8, status),
           discount_type   = $9,
           discount_value  = $10,
           subtotal        = $11,
           cgst            = $12,
           sgst            = $13,
           igst            = $14,
           is_inter_state  = $24,
           total            = $15,
           customer_gstin  = CASE WHEN $16::boolean THEN $17 ELSE customer_gstin END,
           place_of_supply = CASE WHEN $18::boolean THEN $19 ELSE place_of_supply END,
           due_date        = CASE WHEN $20::boolean THEN $21 ELSE due_date END,
           notes           = CASE WHEN $22::boolean THEN $23 ELSE notes END
         WHERE id = $1
         RETURNING ${INVOICE_COLUMNS}`,
        [
          id,
          p.accountId !== undefined, p.accountId ?? null,
          p.contactId !== undefined, p.contactId ?? null,
          p.dealId !== undefined, p.dealId ?? null,
          p.status ?? null,
          discount.type,
          discount.value,
          totals.subtotal,
          gst.cgst,
          gst.sgst,
          gst.igst,
          totals.total,
          p.customerGstin !== undefined, p.customerGstin ?? null,
          p.placeOfSupply !== undefined, p.placeOfSupply ?? null,
          p.dueDate !== undefined, p.dueDate ?? null,
          p.notes !== undefined, p.notes ?? null,
          interState,
        ],
      );
      await this.audit(client, orgId, "invoice.update", id, req);
      const finalItems = await this.fetchItems(client, id);
      return { invoice, items: finalItems };
    });
  }

  private async insertInvoice(
    orgId: string,
    p: z.infer<typeof CreateInvoiceBody>,
    existingClient: QueryClient | null,
    recordScope: CrmRecordScope,
    req: PrincipalRequest,
  ) {
    const run = async (client: QueryClient) => {
      const totals = computeDocumentTotals(p.items as LineItemInput[], {
        type: p.discount.type,
        value: p.discount.value,
      });
      // Derived from the org's own state against the place of supply when both
      // are GST state codes, and the caller's `interState` otherwise - which is
      // what create-from-quotation always falls back to, since a quotation
      // carries no place of supply.
      const treatment = await resolveGstTreatment(client, orgId, p.placeOfSupply, p.interState);
      const interState = treatment.interState;
      const gst = splitGst(totals.taxTotal, interState);

      // Doc 23, A2 - see common/org-references.ts. Covers both the plain
      // create and create-from-quotation, which re-parses into this shape.
      await assertInOrg(client, orgId, {
        workspaceId: p.workspaceId,
        accountId: p.accountId,
        contactId: p.contactId,
        dealId: p.dealId,
        quotationId: p.quotationId,
      });

      try {
        const {
          rows: [invoice],
        } = await client.query(
          `INSERT INTO invoices
             (org_id, workspace_id, account_id, contact_id, deal_id, quotation_id, invoice_number,
              currency, subtotal, discount_type, discount_value, cgst, sgst, igst, customer_gstin,
              place_of_supply, total, due_date, notes, owner_user_id, is_inter_state)
           VALUES ($1, $2, $3, $4, $5, $6, next_invoice_number($1), $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17, $18, $19, $20)
           RETURNING ${INVOICE_COLUMNS}`,
          [
            orgId,
            p.workspaceId ?? null,
            p.accountId ?? null,
            p.contactId ?? null,
            p.dealId ?? null,
            p.quotationId ?? null,
            p.currency,
            totals.subtotal,
            p.discount.type,
            p.discount.value,
            gst.cgst,
            gst.sgst,
            gst.igst,
            p.customerGstin ?? null,
            p.placeOfSupply ?? null,
            totals.total,
            p.dueDate ?? null,
            p.notes ?? null,
            recordScope.scope === "owned" ? recordScope.userId : null,
            interState,
          ],
        );
        await this.insertItems(client, orgId, invoice.id, p.items as any[]);
        await this.audit(client, orgId, "invoice.create", invoice.id, req);
        const items = await this.fetchItems(client, invoice.id);
        return { invoice, items };
      } catch (err: any) {
        if (err?.code === "23505") throw new ConflictException("invoice number collision, retry");
        throw err;
      }
    };
    return existingClient ? run(existingClient) : this.db.withOrg(orgId, run);
  }

  private async insertItems(client: QueryClient, orgId: string, invoiceId: string, items: any[]) {
    // A line item's product must be this org's catalogue entry (doc 23, A2).
    await assertInOrg(client, orgId, { productId: items.map((item) => item.productId) });
    let position = 0;
    for (const item of items) {
      const lineTotal = computeLineTotal(item);
      await client.query(
        `INSERT INTO invoice_items
           (org_id, invoice_id, product_id, description, hsn_sac, quantity, unit_price,
            discount_pct, tax_rate, line_total, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          orgId,
          invoiceId,
          item.productId ?? null,
          item.description,
          item.hsnSac ?? null,
          item.quantity,
          item.unitPrice,
          item.discountPct,
          item.taxRate,
          lineTotal,
          position++,
        ],
      );
    }
  }

  /**
   * The line items, each carrying the NAME of the catalogue entry it came off
   * rather than only its uuid - same reasoning as the quotation controller's
   * fetchItems(). LEFT JOIN, so archiving a product never hides a line off a
   * tax document that has already been issued.
   */
  private async fetchItems(client: QueryClient, invoiceId: string) {
    const { rows } = await client.query(
      `SELECT i.id, i.product_id, p.name AS product_name, i.description, i.hsn_sac, i.quantity,
              i.unit_price, i.discount_pct, i.tax_rate, i.line_total, i.position
         FROM invoice_items i
         LEFT JOIN products p ON p.id = i.product_id
        WHERE i.invoice_id = $1
        ORDER BY i.position ASC`,
      [invoiceId],
    );
    return rows;
  }

  private async audit(client: QueryClient, orgId: string, action: string, targetId: string, req: PrincipalRequest) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, $5, $2, $3, 'invoice', $4)`,
      [orgId, auditActor(req).id, action, targetId, auditActor(req).type],
    );
  }
}
