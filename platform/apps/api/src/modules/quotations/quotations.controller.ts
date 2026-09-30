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
import {
  QUOTATION_STATUSES,
  canMoveQuotation,
  canReviseQuotation,
  computeDocumentTotals,
  computeLineTotal,
  quotationEditable,
  quotationRevisionNumber,
  type LineItemInput,
  type QuotationStatus,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { assertInOrg } from "../../common/org-references";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { auditActor } from "../../common/audit-actor";

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

// Header fields only - line items are replaced wholesale via replaceItems()
// below rather than patched individually; a quotation is small enough that
// re-sending the full item list on every edit is simpler than diffing it,
// and it's how the web editor naturally works (one form, one save).
const UpdateQuotationBody = z.object({
  accountId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  // Every stored value parses, so an unchanged status round-trips; WHICH moves
  // are allowed is QUOTATION_MANUAL_MOVES, enforced in the handler. Same shape
  // the invoice controller uses.
  status: z.enum(QUOTATION_STATUSES).optional(),
  discount: Discount.optional(),
  validUntil: z.string().date().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  items: z.array(LineItem).min(1).optional(),
});

const ListQuery = z.object({
  status: z.enum(QUOTATION_STATUSES).optional(),
  /** Quotation number, or the name of the company or person it is for. */
  q: z.string().max(200).optional(),
  dealId: z.string().uuid().optional(),
  /** Everything raised for one person or company - the contact and account pages' reverse lookup (doc 23, H2). */
  contactId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const QUOTATION_COLUMNS = `id, workspace_id, account_id, contact_id, deal_id, quotation_number,
  status, currency, subtotal, discount_type, discount_value, tax_total, total, valid_until, notes,
  owner_user_id, revision, revision_of, root_id, created_at, updated_at`;

/**
 * The same columns for the list query, which joins and so must qualify them.
 *
 * Written out rather than derived from the constant above by string surgery:
 * `QUOTATION_COLUMNS` is also a `RETURNING` list (where `RETURNING qt.id` is a
 * syntax error), so the two cannot be one value - and splitting that one on
 * commas would break the day a column becomes an expression that contains one,
 * which is exactly what `INVOICE_COLUMNS` has already started doing.
 */
const QUOTATION_LIST_COLUMNS = `qt.id, qt.workspace_id, qt.account_id, qt.contact_id, qt.deal_id,
  qt.quotation_number, qt.status, qt.currency, qt.subtotal, qt.discount_type, qt.discount_value,
  qt.tax_total, qt.total, qt.valid_until, qt.notes, qt.owner_user_id, qt.revision, qt.revision_of,
  qt.root_id, qt.created_at, qt.updated_at`;

/**
 * Who the document is for, resolved to a name.
 *
 * The list rendered `account_id` and nothing else, so a page of quotations was
 * forty rows of `Q-2026-0007` with no way to tell whose was whose without
 * opening each one. LEFT JOIN: a quotation raised before a customer was
 * attached still belongs on the list.
 */
const QUOTATION_LIST_JOINS = `FROM quotations qt
    LEFT JOIN accounts a ON a.id = qt.account_id
    LEFT JOIN contacts c ON c.id = qt.contact_id`;

type QueryClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** One stored `quotation_items` row, as `fetchItems` hands it back. Numerics are strings. */
interface StoredLineItem {
  product_id: string | null;
  description: string;
  quantity: string;
  unit_price: string;
  discount_pct: string | null;
  tax_rate: string | null;
}

/**
 * Quotations - Kailash gap Milestone 1. `quotation_number` is server-generated
 * (Q-<year>-<sequence>), never client-supplied; a true concurrent-create race
 * on the same org surfaces as 409 off the unique index rather than silently
 * reusing a number - rare enough for this record volume that a retry loop
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
    const { status, q, dealId, contactId, accountId, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where = ["1=1"];
      const params: unknown[] = [];
      if (status) {
        params.push(status);
        where.push(`qt.status = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        // The customer's name as well as the number, because nobody remembers a
        // quotation number. A row with no customer simply does not match, which
        // is right: searching for a name should not return the unattached ones.
        where.push(`(qt.quotation_number ILIKE ${p} OR a.name ILIKE ${p} OR c.display_name ILIKE ${p})`);
      }
      if (dealId) {
        params.push(dealId);
        where.push(`qt.deal_id = $${params.length}`);
      }
      if (contactId) {
        params.push(contactId);
        where.push(`qt.contact_id = $${params.length}`);
      }
      if (accountId) {
        params.push(accountId);
        where.push(`qt.account_id = $${params.length}`);
      }
      if (recordScope.scope === "owned") {
        params.push(recordScope.userId);
        where.push(`qt.owner_user_id = $${params.length}`);
      }
      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${QUOTATION_LIST_COLUMNS}, a.name AS account_name, c.display_name AS contact_name,
                count(*) OVER()::int AS total_count
           ${QUOTATION_LIST_JOINS}
          WHERE ${where.join(" AND ")}
          ORDER BY qt.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return {
        quotations: rows.map(({ total_count: _t, ...row }) => row),
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
      const items = await this.fetchItems(client, id);
      const revisions = await this.fetchFamily(client, quotation);
      return { quotation, items, revisions };
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
        // Foreign-key checks ignore RLS (doc 23, A2).
        await assertInOrg(client, orgId, {
          workspaceId: p.workspaceId,
          accountId: p.accountId,
          contactId: p.contactId,
          dealId: p.dealId,
        });

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
            // create a record and immediately lose sight of it - same rule
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
      // Before the line items are replaced below, so a rejected link writes
      // nothing (doc 23, A2).
      await assertInOrg(client, orgId, {
        accountId: p.accountId,
        contactId: p.contactId,
        dealId: p.dealId,
      });

      const scoped = scopeClause("quotation", recordScope, 2);
      // FOR UPDATE: the status check below must still hold when the UPDATE runs,
      // and the revise endpoint locks the same row to set `superseded`.
      const {
        rows: [existing],
      } = await client.query(
        `SELECT id, status, discount_type, discount_value
           FROM quotations WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}
           FOR UPDATE`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!existing) throw new NotFoundException("quotation not found");

      const from = existing.status as QuotationStatus;

      // Only the moves a person may make. Before this, PATCH took any status
      // from any status: a rejected quotation could be walked back to draft and
      // rewritten, and `expired` - which only the calendar can make true - could
      // be typed onto a quotation still inside its validity.
      if (p.status !== undefined && !canMoveQuotation(from, p.status)) {
        throw new ConflictException(`a quotation cannot move from ${from} to ${p.status}`);
      }

      // Once sent, the numbers are what a customer was told. Editing them in
      // place rewrites history and leaves the copy in their inbox disagreeing
      // with the row - so the way to change an issued quotation is to revise it.
      const changesTheOffer =
        p.items !== undefined || p.discount !== undefined || p.validUntil !== undefined;
      if (changesTheOffer && !quotationEditable(from)) {
        throw new ConflictException(
          `a ${from} quotation's lines, discount and validity are fixed - raise a revision instead`,
        );
      }

      let items: LineItemInput[] | null = null;
      if (p.items) {
        await client.query(`DELETE FROM quotation_items WHERE quotation_id = $1`, [id]);
        await this.insertItems(client, orgId, id, p.items);
        items = p.items;
      } else {
        // numeric columns come back from node-postgres as strings - cast
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

  /**
   * Raise a new revision of an issued quotation.
   *
   * ── WHY THIS EXISTS RATHER THAN AN EDIT ────────────────────────────────────
   *
   * A sent quotation's numbers are what a customer was told. `PATCH` used to
   * rewrite them in place - `DELETE FROM quotation_items` and re-insert - so
   * there was no record that the offer had changed and no way to answer "what
   * did we actually quote them in March". This clones the document instead: the
   * old row keeps its number and its lines and becomes `superseded`, the new one
   * is `Q-2026-0007-r2` in `draft`, and both exist for good.
   *
   * The clone carries the links, the currency, the discount, the validity, the
   * notes and every line INCLUDING its `product_id`, because a revision is the
   * same offer re-priced, not a fresh quotation.
   *
   * Totals are not copied - they are recomputed from the cloned lines by the one
   * engine in `@aura/shared`, so a revision can never inherit a stale total.
   */
  @Post(":id/revise")
  @RequireCrmPermission("quotation", "create")
  async revise(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const scoped = scopeClause("quotation", recordScope, 2);
      // FOR UPDATE: two people pressing Revise at once must not both read
      // `sent` and both mint an r2. The loser sees the status already moved.
      const {
        rows: [source],
      } = await client.query(
        `SELECT ${QUOTATION_COLUMNS} FROM quotations
          WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}
          FOR UPDATE`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!source) throw new NotFoundException("quotation not found");

      const status = source.status as QuotationStatus;
      if (!canReviseQuotation(status)) {
        throw new ConflictException(
          status === "draft"
            ? "a draft quotation can be edited directly - revise one that has been issued"
            : status === "superseded"
              ? "this quotation has already been revised - revise the newest one instead"
              : `a ${status} quotation cannot be revised`,
        );
      }

      // The ROOT's number, not this row's, or revision 3 raised off r2 would be
      // numbered `Q-2026-0007-r2-r3`.
      const rootId: string = source.root_id ?? source.id;
      let rootNumber: string = source.quotation_number;
      if (source.root_id) {
        const {
          rows: [root],
        } = await client.query(`SELECT quotation_number FROM quotations WHERE id = $1`, [rootId]);
        if (!root) throw new ConflictException("the original quotation this revises is gone");
        rootNumber = root.quotation_number;
      }

      // The highest revision in the family, not this row's + 1: revising an
      // older generation is refused above, but the family is the thing that has
      // to stay gapless and uniquely numbered.
      const {
        rows: [peak],
      } = await client.query(
        `SELECT max(revision)::int AS revision FROM quotations WHERE id = $1 OR root_id = $1`,
        [rootId],
      );
      const revision: number = (peak?.revision ?? source.revision) + 1;

      const items = await this.fetchItems(client, id);
      if (items.length === 0) throw new BadRequestException("quotation has no line items to revise");

      const lines = (items as StoredLineItem[]).map((item) => ({
        productId: item.product_id,
        description: item.description,
        // Postgres numeric arrives as a string; the totals engine takes numbers.
        quantity: Number(item.quantity),
        unitPrice: Number(item.unit_price),
        discountPct: Number(item.discount_pct ?? 0),
        taxRate: Number(item.tax_rate ?? 0),
      })) as unknown as LineItemInput[];

      const discount = {
        type: source.discount_type as "percent" | "amount" | null,
        value: Number(source.discount_value),
      };
      const totals = computeDocumentTotals(lines, discount);

      const {
        rows: [quotation],
      } = await client.query(
        `INSERT INTO quotations
           (org_id, workspace_id, account_id, contact_id, deal_id, quotation_number, status, currency,
            subtotal, discount_type, discount_value, tax_total, total, valid_until, notes,
            owner_user_id, revision, revision_of, root_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING ${QUOTATION_COLUMNS}`,
        [
          orgId,
          source.workspace_id,
          source.account_id,
          source.contact_id,
          source.deal_id,
          quotationRevisionNumber(rootNumber, revision),
          source.currency,
          totals.subtotal,
          discount.type,
          discount.value,
          totals.taxTotal,
          totals.total,
          source.valid_until,
          source.notes,
          // The reviser owns it when they are scoped, same rule create() uses -
          // otherwise they would raise a revision and immediately lose sight of it.
          recordScope.scope === "owned" ? recordScope.userId : source.owner_user_id,
          revision,
          source.id,
          rootId,
        ],
      );

      await this.insertItems(client, orgId, quotation.id, lines);
      // Only now, and only from a status that permitted it - so a failed clone
      // leaves the original exactly as it was.
      await client.query(`UPDATE quotations SET status = 'superseded' WHERE id = $1`, [source.id]);

      await this.audit(client, orgId, "quotation.revise", source.id, req);
      await this.audit(client, orgId, "quotation.create", quotation.id, req);

      const newItems = await this.fetchItems(client, quotation.id);
      const revisions = await this.fetchFamily(client, quotation);
      return { quotation, items: newItems, revisions };
    });
  }

  private async insertItems(client: QueryClient, orgId: string, quotationId: string, items: LineItemInput[] & { productId?: string | null }[]) {
    // A line item's product must be this org's catalogue entry (doc 23, A2).
    await assertInOrg(client, orgId, {
      productId: (items as { productId?: string | null }[]).map((item) => item.productId),
    });
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

  /**
   * The line items, each carrying the NAME of the catalogue entry it came off
   * rather than only its uuid.
   *
   * `product_id` alone is unrenderable: the editor would have to resolve one
   * request per row to show a person which price-list entry a line is linked
   * to, so before this it showed nothing at all and the link was invisible.
   * LEFT JOIN, so a line whose product was archived or deleted (product_id is
   * ON DELETE SET NULL) still comes back - a quotation is a historical record
   * of what was offered, not a live view of the catalogue.
   */
  /**
   * Every revision of this quotation, oldest first - including the one being
   * looked at, so the detail page can show "you are on r2 of 3" without doing
   * arithmetic.
   *
   * Keyed on `root_id`, which every revision carries, rather than walking
   * `revision_of` up the chain: one indexed read instead of one per generation.
   * A quotation that has never been revised is its own family of one, and that
   * costs no query at all.
   */
  private async fetchFamily(client: QueryClient, quotation: { id: string; root_id: string | null; revision: number; quotation_number: string; status: string; total: string; created_at: string }) {
    const rootId = quotation.root_id ?? quotation.id;
    if (quotation.root_id === null && quotation.revision === 1) {
      // Still ask, but only when a revision could exist: a root with revision 1
      // and no children is the overwhelming majority, and this keeps that case
      // to a single indexed lookup rather than a scan.
      const { rows } = await client.query(
        `SELECT 1 FROM quotations WHERE root_id = $1 LIMIT 1`,
        [rootId],
      );
      if (rows.length === 0) return [];
    }
    const { rows } = await client.query(
      `SELECT id, quotation_number, status, revision, total, currency, created_at
         FROM quotations
        WHERE id = $1 OR root_id = $1
        ORDER BY revision ASC`,
      [rootId],
    );
    return rows;
  }

  private async fetchItems(client: QueryClient, quotationId: string) {
    const { rows } = await client.query(
      `SELECT i.id, i.product_id, p.name AS product_name, i.description, i.quantity,
              i.unit_price, i.discount_pct, i.tax_rate, i.line_total, i.position
         FROM quotation_items i
         LEFT JOIN products p ON p.id = i.product_id
        WHERE i.quotation_id = $1
        ORDER BY i.position ASC`,
      [quotationId],
    );
    return rows;
  }

  private async audit(client: QueryClient, orgId: string, action: string, targetId: string, req: PrincipalRequest) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, $5, $2, $3, 'quotation', $4)`,
      [orgId, auditActor(req).id, action, targetId, auditActor(req).type],
    );
  }
}
