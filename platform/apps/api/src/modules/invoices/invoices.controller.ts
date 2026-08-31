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
import { computeDocumentTotals, computeLineTotal, splitGst, type LineItemInput } from "@aura/shared";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

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
  // yet, and guessing wrong on a tax document is worse than asking.
  interState: z.boolean().default(false),
  customerGstin: z.string().max(20).nullish(),
  placeOfSupply: z.string().max(100).nullish(),
  dueDate: z.string().date().nullish(),
  notes: z.string().max(5000).nullish(),
  items: z.array(LineItem).min(1, "an invoice needs at least one line item"),
});

const UpdateInvoiceBody = z.object({
  accountId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
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
  dealId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const INVOICE_COLUMNS = `id, workspace_id, account_id, contact_id, deal_id, quotation_id,
  invoice_number, status, currency, subtotal, discount_type, discount_value, cgst, sgst, igst,
  customer_gstin, place_of_supply, total, amount_paid, due_date, notes, owner_user_id,
  created_at, updated_at`;

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
    const { status, dealId, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where = ["1=1"];
      const params: unknown[] = [];
      if (status) {
        params.push(status);
        where.push(`status = $${params.length}`);
      }
      if (dealId) {
        params.push(dealId);
        where.push(`deal_id = $${params.length}`);
      }
      if (recordScope.scope === "owned") {
        params.push(recordScope.userId);
        where.push(`owner_user_id = $${params.length}`);
      }
      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${INVOICE_COLUMNS}, count(*) OVER()::int AS total_count
           FROM invoices
          WHERE ${where.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return {
        invoices: rows.map(({ total_count: _t, ...i }) => i),
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
        `SELECT id, provider, status, amount, currency, razorpay_payment_link_id, created_at, captured_at
           FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      return { invoice, items, payments };
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
      const scoped = scopeClause("invoice", recordScope, 2);
      const {
        rows: [existing],
      } = await client.query(
        `SELECT id, discount_type, discount_value FROM invoices WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!existing) throw new NotFoundException("invoice not found");

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
      const gst = p.interState !== undefined ? splitGst(totals.taxTotal, p.interState) : null;

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
           cgst            = COALESCE($12, cgst),
           sgst            = COALESCE($13, sgst),
           igst            = COALESCE($14, igst),
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
          gst?.cgst ?? null,
          gst?.sgst ?? null,
          gst?.igst ?? null,
          totals.total,
          p.customerGstin !== undefined, p.customerGstin ?? null,
          p.placeOfSupply !== undefined, p.placeOfSupply ?? null,
          p.dueDate !== undefined, p.dueDate ?? null,
          p.notes !== undefined, p.notes ?? null,
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
      const gst = splitGst(totals.taxTotal, p.interState);

      try {
        const {
          rows: [invoice],
        } = await client.query(
          `INSERT INTO invoices
             (org_id, workspace_id, account_id, contact_id, deal_id, quotation_id, invoice_number,
              currency, subtotal, discount_type, discount_value, cgst, sgst, igst, customer_gstin,
              place_of_supply, total, due_date, notes, owner_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, next_invoice_number($1), $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17, $18, $19)
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

  private async fetchItems(client: QueryClient, invoiceId: string) {
    const { rows } = await client.query(
      `SELECT id, product_id, description, hsn_sac, quantity, unit_price, discount_pct, tax_rate,
              line_total, position
         FROM invoice_items WHERE invoice_id = $1 ORDER BY position ASC`,
      [invoiceId],
    );
    return rows;
  }

  private async audit(client: QueryClient, orgId: string, action: string, targetId: string, req: PrincipalRequest) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'user', $2, $3, 'invoice', $4)`,
      [orgId, req.principal?.userId ?? "dev-admin", action, targetId],
    );
  }
}
