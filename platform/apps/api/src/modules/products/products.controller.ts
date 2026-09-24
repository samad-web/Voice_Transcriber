import {
  BadRequestException,
  Body,
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
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { auditActor } from "../../common/audit-actor";

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(["active", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const CreateProductBody = z.object({
  name: z.string().min(1).max(200),
  sku: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  unitPrice: z.number().min(0).default(0),
  currency: z.string().length(3).default("INR"),
  taxRate: z.number().min(0).max(100).default(0),
});

const UpdateProductBody = z.object({
  name: z.string().min(1).max(200).optional(),
  sku: z.string().max(100).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  unitPrice: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const PRODUCT_COLUMNS = `id, name, sku, description, unit_price, currency, tax_rate, status,
  created_at, updated_at`;

/**
 * Products - a price list to quote and invoice against (Kailash gap
 * Milestone 1). Same shape as accounts.controller.ts: no owner/workspace
 * scoping (a product is a shared catalogue entry, not a person's record), no
 * `owned` record scope.
 */
@Controller("products")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class ProductsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireCrmPermission("product", "view")
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { q, status, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where = status ? [`status = $1`] : [`status <> 'archived'`];
      const params: unknown[] = status ? [status] : [];

      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(`(name ILIKE ${p} OR sku ILIKE ${p})`);
      }

      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${PRODUCT_COLUMNS}, count(*) OVER()::int AS total_count
           FROM products
          WHERE ${where.join(" AND ")}
          ORDER BY name ASC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        products: rows.map(({ total_count: _t, ...p }) => p),
        total: rows[0]?.total_count ?? 0,
        limit,
        offset,
      };
    });
  }

  @Get(":id")
  @RequireCrmPermission("product", "view")
  async detail(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [product],
      } = await client.query(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = $1`, [id]);
      if (!product) throw new NotFoundException("product not found");
      return { product };
    });
  }

  @Post()
  @RequireCrmPermission("product", "create")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateProductBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [product],
      } = await client.query(
        `INSERT INTO products (org_id, name, sku, description, unit_price, currency, tax_rate)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${PRODUCT_COLUMNS}`,
        [orgId, p.name, p.sku ?? null, p.description ?? null, p.unitPrice, p.currency, p.taxRate],
      );
      await this.audit(client, orgId, "product.create", product.id, req);
      return { product };
    });
  }

  @Patch(":id")
  @RequireCrmPermission("product", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdateProductBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [product],
      } = await client.query(
        `UPDATE products SET
           name        = COALESCE($2, name),
           sku         = CASE WHEN $3::boolean THEN $4 ELSE sku END,
           description = CASE WHEN $5::boolean THEN $6 ELSE description END,
           unit_price  = COALESCE($7, unit_price),
           currency    = COALESCE($8, currency),
           tax_rate    = COALESCE($9, tax_rate),
           status      = COALESCE($10, status)
         WHERE id = $1
         RETURNING ${PRODUCT_COLUMNS}`,
        [
          id,
          p.name ?? null,
          p.sku !== undefined,
          p.sku ?? null,
          p.description !== undefined,
          p.description ?? null,
          p.unitPrice ?? null,
          p.currency ?? null,
          p.taxRate ?? null,
          p.status ?? null,
        ],
      );
      if (!product) throw new NotFoundException("product not found");
      await this.audit(client, orgId, "product.update", id, req);
      return { product };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
    req: PrincipalRequest,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, $5, $2, $3, 'product', $4)`,
      [orgId, auditActor(req).id, action, targetId, auditActor(req).type],
    );
  }
}
