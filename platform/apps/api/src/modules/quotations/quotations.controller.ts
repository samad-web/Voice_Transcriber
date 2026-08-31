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
import { computeDocumentTotals, computeLineTotal, type LineItemInput } from "@aura/shared";
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
  quantity: z.number().min(0),
  unitPrice: z.number().min(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxRate: z.number().min(0).max(100).default(0),
});

const Discount = z.object({
  type: z.enum(["percent", "amount"]).nullable().default(null),
  value: z.number().min(0).default(0),
});

const CreateQuotationBody = z.object({
  workspaceId: z.string().uuid().optional(),
  accountId: z.string().uuid().nullish(),
  contactId: z.string().uuid().nullish(),
  dealId: z.string().uuid().nullish(),
  currency: z.string().length(3).default("INR"),
  discount: Discount.default({ type: null, value: 0 }),
  validUntil: z.string().date().nullish(),
  notes: z.string().max(5000).nullish(),
  items: z.array(LineItem).min(1, "a quotation needs at least one line item"),
});

// Header fields only — line items are replaced wholesale via replaceItems()
// below rather than patched individually; a quotation is small enough that
// re-sending the full item list on every edit is simpler than diffing it,
// and it's how the web editor naturally works (one form, one save).
const UpdateQuotationBody = z.object({
  accountId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  status: z.enum(["draft", "sent", "accepted", "rejected", "expired"]).optional(),
  discount: Discount.optional(),
  validUntil: z.string().date().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  items: z.array(LineItem).min(1).optional(),
});

const ListQuery = z.object({
  status: z.enum(["draft", "sent", "accepted", "rejected", "expired"]).optional(),
  dealId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const QUOTATION_COLUMNS = `id, workspace_id, account_id, contact_id, deal_id, quotation_number,
  status, currency, subtotal, discount_type, discount_value, tax_total, total, valid_until, notes,
  owner_user_id, created_at, updated_at`;

type QueryClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * Quotations — Kailash gap Milestone 1. `quotation_number` is server-generated
 * (Q-<year>-<sequence>), never client-supplied; a true concurrent-create race
 * on the same org surfaces as 409 off the unique index rather than silently
 * reusing a number — rare enough for this record volume that a retry loop
 * isn't worth the complexity.
 */
@Controller("quotations")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class QuotationsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireCrmPermission("quotation", "view")
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
        `SELECT ${QUOTATION_COLUMNS}, count(*) OVER()::int AS total_count
           FROM quotations
          WHERE ${where.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return {
        quotations: rows.map(({ total_count: _t, ...q }) => q),
        total: rows[0]?.total_count ?? 0,
        limit,
        offset,
      };
    });
  }

  @Get(":id")
  @RequireCrmPermission("quotation", "view")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const scoped = scopeClause("quotation", recordScope, 2);
      const {
        rows: [quotation],
      } = await client.query(
        `SELECT ${QUOTATION_COLUMNS} FROM quotations WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!quotation) throw new NotFoundException("quotation not found");
      const { rows: items } = await client.query(
        `SELECT id, product_id, description, quantity, unit_price, discount_pct, tax_rate,
                line_total, position
           FROM quotation_items WHERE quotation_id = $1 ORDER BY position ASC`,
        [id],
      );
      return { quotation, items };
    });
  }

  @Post()
  @RequireCrmPermission("quotation", "create")
  async create(
    @OrgId() orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = CreateQuotationBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    const totals = computeDocumentTotals(p.items as LineItemInput[], {
      type: p.discount.type,
      value: p.discount.value,
    });

    try {
      return await this.db.withOrg(orgId, async (client) => {
        const {
          rows: [quotation],
        } = await client.query(
          `INSERT INTO quotations
             (org_id, workspace_id, account_id, contact_id, deal_id, quotation_number, currency,
              subtotal, discount_type, discount_value, tax_total, total, valid_until, notes,
              owner_user_id)
           VALUES ($1, $2, $3, $4, $5, next_quotation_number($1), $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING ${QUOTATION_COLUMNS}`,
          [
            orgId,
            p.workspaceId ?? null,
            p.accountId ?? null,
            p.contactId ?? null,
            p.dealId ?? null,
            p.currency,
            totals.subtotal,
            p.discount.type,
            p.discount.value,
            totals.taxTotal,
            totals.total,
            p.validUntil ?? null,
            p.notes ?? null,
            // Stamped as the creator's when they are scoped, or they would
            // create a record and immediately lose sight of it — same rule
            // accounts.controller.ts's create() uses.
            recordScope.scope === "owned" ? recordScope.userId : null,
          ],
        );
        await this.insertItems(client, orgId, quotation.id, p.items);
        await this.audit(client, orgId, "quotation.create", quotation.id, req);
        const items = await this.fetchItems(client, quotation.id);
        return { quotation, items };
      });
    } catch (err: any) {
      if (err?.code === "23505") throw new ConflictException("quotation number collision, retry");
      throw err;
    }
  }

  @Patch(":id")
  @RequireCrmPermission("quotation", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = UpdateQuotationBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      const scoped = scopeClause("quotation", recordScope, 2);
      const {
        rows: [existing],
      } = await client.query(
        `SELECT id, discount_type, discount_value FROM quotations WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!existing) throw new NotFoundException("quotation not found");

      let items: LineItemInput[] | null = null;
      if (p.items) {
        await client.query(`DELETE FROM quotation_items WHERE quotation_id = $1`, [id]);
        await this.insertItems(client, orgId, id, p.items);
        items = p.items;
      } else {
        // numeric columns come back from node-postgres as strings — cast
        // explicitly rather than trust JS's `*`/`-` auto-coercion, which
        // happens to make computeDocumentTotals's arithmetic work today but
        // would silently stop the moment it does anything stricter than that.
        const { rows } = await client.query(
          `SELECT quantity::float8 AS quantity, unit_price::float8 AS "unitPrice",
                  discount_pct::float8 AS "discountPct", tax_rate::float8 AS "taxRate"
             FROM quotation_items WHERE quotation_id = $1`,
          [id],
        );
        items = rows;
      }

      const discount = p.discount ?? {
        type: existing.discount_type,
        value: Number(existing.discount_value),
      };
      const totals = computeDocumentTotals(items, discount);

      const {
        rows: [quotation],
      } = await client.query(
        `UPDATE quotations SET
           account_id     = CASE WHEN $2::boolean THEN $3 ELSE account_id END,
           contact_id     = CASE WHEN $4::boolean THEN $5 ELSE contact_id END,
           deal_id        = CASE WHEN $6::boolean THEN $7 ELSE deal_id END,
           status         = COALESCE($8, status),
           discount_type  = $9,
           discount_value = $10,
           subtotal       = $11,
           tax_total      = $12,
           total          = $13,
           valid_until    = CASE WHEN $14::boolean THEN $15 ELSE valid_until END,
           notes          = CASE WHEN $16::boolean THEN $17 ELSE notes END
         WHERE id = $1
         RETURNING ${QUOTATION_COLUMNS}`,
        [
          id,
          p.accountId !== undefined,
          p.accountId ?? null,
          p.contactId !== undefined,
          p.contactId ?? null,
          p.dealId !== undefined,
          p.dealId ?? null,
          p.status ?? null,
          discount.type,
          discount.value,
          totals.subtotal,
          totals.taxTotal,
          totals.total,
          p.validUntil !== undefined,
          p.validUntil ?? null,
          p.notes !== undefined,
          p.notes ?? null,
        ],
      );
      await this.audit(client, orgId, "quotation.update", id, req);
      const finalItems = await this.fetchItems(client, id);
      return { quotation, items: finalItems };
    });
  }

  private async insertItems(client: QueryClient, orgId: string, quotationId: string, items: LineItemInput[] & { productId?: string | null }[]) {
    let position = 0;
    for (const item of items as any[]) {
      const lineTotal = computeLineTotal(item);
      await client.query(
        `INSERT INTO quotation_items
           (org_id, quotation_id, product_id, description, quantity, unit_price, discount_pct,
            tax_rate, line_total, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          orgId,
          quotationId,
          item.productId ?? null,
          item.description,
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

  private async fetchItems(client: QueryClient, quotationId: string) {
    const { rows } = await client.query(
      `SELECT id, product_id, description, quantity, unit_price, discount_pct, tax_rate,
              line_total, position
         FROM quotation_items WHERE quotation_id = $1 ORDER BY position ASC`,
      [quotationId],
    );
    return rows;
  }

  private async audit(client: QueryClient, orgId: string, action: string, targetId: string, req: PrincipalRequest) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'user', $2, $3, 'quotation', $4)`,
      [orgId, req.principal?.userId ?? "dev-admin", action, targetId],
    );
  }
}
