import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
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
  CostDriverKind,
  DEFAULT_FIXED_CATEGORIES,
  DateOnly,
  ExpenseCategory,
  formatMoney,
  toMinor,
  toNumericString,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { isCheckViolation } from "../../common/pg-errors";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { loadFinanceSettings, orgToday } from "./finance-settings";
import * as ledger from "./ledger";

/**
 * §5 of M5: expenses, their approvals, and the cost drivers §12.3's per-unit
 * figures divide by.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT COLLECT ─────────────────────────────────
 *
 * Ad spend. Migration 0171 added `marketing_source_spend` and the console
 * already has a screen that enters it, so the cost side READS that table for
 * per-source ROI rather than asking an owner to type the same number twice.
 * An `advertising` expense row is for the agency retainer and the creative
 * invoice - the things 0171's per-source monthly figure does not cover.
 *
 * ── AND WHY APPROVAL IS A LIMIT RATHER THAN A WORKFLOW ──────────────────────
 *
 * §3 gives a manager "approve small expenses/payments up to limit". That is
 * one threshold and two roles, not a chain - a three-step approval workflow on
 * a floor of six people is a thing nobody uses, and the module's own §15
 * defaults name a single number. Above the limit it takes `finance:create`,
 * which 0172 seeds to the admin roles only.
 */

const Vendor = z.string().trim().min(1).max(200);

const CreateExpenseBody = z.object({
  category: ExpenseCategory,
  vendor: Vendor.optional(),
  amount: z.number().min(0.01, "An amount is required."),
  tax: z.number().min(0).default(0),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .default("INR"),
  incurredOn: DateOnly,
  /**
   * Optional with NO default. `DEFAULT_FIXED_CATEGORIES` decides when it is
   * absent - and that is the point: a per-seat software bill is variable for a
   * floor that is hiring and fixed for one that is not, so the category's
   * default is a PROPOSAL and this field is the person's answer. A hard
   * `false` default here would make the fixed/variable chart an artefact of
   * whichever value the form happened to post.
   */
  isFixed: z.boolean().optional(),
  marketingSourceId: z.string().uuid().nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  recurs: z.enum(["monthly", "quarterly", "yearly"]).nullable().optional(),
  attachmentUrl: z.string().trim().url().max(2000).optional(),
  memo: z.string().trim().max(500).optional(),
});

/** Hand-built, not `.partial()` - see the note in deal-templates.controller.ts. */
const UpdateExpenseBody = z
  .object({
    category: ExpenseCategory.optional(),
    vendor: Vendor.nullable().optional(),
    isFixed: z.boolean().optional(),
    marketingSourceId: z.string().uuid().nullable().optional(),
    userId: z.string().uuid().nullable().optional(),
    recurs: z.enum(["monthly", "quarterly", "yearly"]).nullable().optional(),
    attachmentUrl: z.string().trim().url().max(2000).nullable().optional(),
    memo: z.string().trim().max(500).nullable().optional(),
    lastUsedOn: DateOnly.nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

const EXPENSE_COLUMNS = `e.id, e.category, e.vendor, e.amount::text AS amount, e.tax::text AS tax,
  e.currency, to_char(e.incurred_on, 'YYYY-MM-DD') AS incurred_on, e.is_fixed,
  e.marketing_source_id, e.user_id, e.source, e.approved_by, e.approved_at,
  e.attachment_url, e.recurs, to_char(e.last_used_on, 'YYYY-MM-DD') AS last_used_on,
  e.memo, e.reverses_id, e.reversal_reason, e.created_by, e.created_at`;

interface ExpenseRow {
  id: string;
  category: string;
  vendor: string | null;
  amount: string;
  tax: string;
  currency: string;
  incurred_on: string;
  is_fixed: boolean;
  marketing_source_id: string | null;
  user_id: string | null;
  source: string;
  approved_by: string | null;
  approved_at: Date | null;
  attachment_url: string | null;
  recurs: string | null;
  last_used_on: string | null;
  memo: string | null;
  reverses_id: string | null;
  reversal_reason: string | null;
  created_by: string | null;
  created_at: Date;
  source_name?: string | null;
}

function presentExpense(row: ExpenseRow) {
  return {
    id: row.id,
    category: row.category,
    vendor: row.vendor,
    amount: Number(row.amount),
    tax: Number(row.tax),
    /**
     * Amount EXCLUDING recoverable tax - the figure every cost metric uses.
     * An invoice total includes GST the business gets back, and counting it as
     * cost overstates every margin by the tax rate.
     */
    netCost: Number(toNumericString(toMinor(row.amount, row.currency) - toMinor(row.tax, row.currency), row.currency)),
    currency: row.currency,
    incurredOn: row.incurred_on,
    isFixed: row.is_fixed,
    marketingSourceId: row.marketing_source_id,
    marketingSourceName: row.source_name ?? null,
    userId: row.user_id,
    source: row.source,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    attachmentUrl: row.attachment_url,
    recurs: row.recurs,
    lastUsedOn: row.last_used_on,
    memo: row.memo,
    reversesId: row.reverses_id,
    reversalReason: row.reversal_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const AUDIT_SQL = `INSERT INTO audit_log
   (org_id, actor_type, actor_id, action, target_type, target_id, meta)
 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;

@Controller("finance")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class ExpensesController {
  constructor(private readonly db: DbService) {}

  @Get("expenses")
  @RequireCrmPermission("finance", "view")
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = z
      .object({
        category: ExpenseCategory.optional(),
        from: DateOnly.optional(),
        to: DateOnly.optional(),
        unapprovedOnly: z.enum(["1", "true"]).optional(),
        marketingSourceId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace(/\$\?/g, `$${params.length}`));
      };
      if (q.category) add("e.category = $?", q.category);
      if (q.from) add("e.incurred_on >= $?::date", q.from);
      if (q.to) add("e.incurred_on <= $?::date", q.to);
      if (q.marketingSourceId) add("e.marketing_source_id = $?", q.marketingSourceId);
      if (q.unapprovedOnly) where.push("e.approved_at IS NULL");
      if (where.length === 0) where.push("true");

      params.push(q.limit, q.offset);
      const { rows } = await client.query<ExpenseRow & { total: string; period_total: string }>(
        `SELECT ${EXPENSE_COLUMNS},
                ms.name AS source_name,
                count(*) OVER()         AS total,
                sum(e.amount - e.tax) OVER() AS period_total
           FROM expenses e
           LEFT JOIN marketing_sources ms ON ms.id = e.marketing_source_id
          WHERE ${where.join(" AND ")}
          ORDER BY e.incurred_on DESC, e.created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        expenses: rows.map(({ total: _t, period_total: _p, ...row }) =>
          presentExpense(row as ExpenseRow),
        ),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        /** The whole filter's net cost, not the page's - see the dues note. */
        periodTotal: rows.length > 0 ? Number(rows[0].period_total) : 0,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  /** §12.3's fixed/variable split and the per-category breakdown, in one read. */
  @Get("expenses/summary")
  @RequireCrmPermission("finance", "view")
  async summary(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = z.object({ from: DateOnly, to: DateOnly }).safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        category: string;
        is_fixed: boolean;
        amount: string;
        entries: string;
      }>(
        `SELECT e.category, e.is_fixed,
                sum(e.amount - e.tax)::text AS amount,
                count(*)::text AS entries
           FROM expenses e
          WHERE e.incurred_on BETWEEN $1::date AND $2::date
            -- ── APPROVED ONLY, AND THIS LINE WAS MISSING ──────────────────
            --
            -- computeTotals() filters on it and this did not, so the Expenses
            -- page reported this month at 2,74,608 while the Finance
            -- dashboard's "costs" said 48,280 for the same month - two
            -- answers to one question, which is the exact failure §11 opens by
            -- naming. Caught by looking at the two screens side by side, not
            -- by any test: each query is correct in isolation.
            --
            -- Approved is the right side to land on, for the reason the
            -- rollup gives: an entered bill is a CLAIM, and letting claims
            -- move the margin makes the approval limit decorative. The rows
            -- are still LISTED below with a "waiting" chip, because somebody
            -- has to approve them.
            AND e.approved_at IS NOT NULL
            -- A reversal and the row it reverses net to zero, which is correct.
            -- Excluding either would make the summary disagree with the ledger.
          GROUP BY 1, 2
          ORDER BY 3 DESC`,
        [parsed.data.from, parsed.data.to],
      );

      const byCategory = new Map<string, { amount: number; entries: number }>();
      let fixed = 0;
      let variable = 0;
      for (const row of rows) {
        const amount = Number(row.amount);
        const existing = byCategory.get(row.category) ?? { amount: 0, entries: 0 };
        byCategory.set(row.category, {
          amount: existing.amount + amount,
          entries: existing.entries + Number(row.entries),
        });
        if (row.is_fixed) fixed += amount;
        else variable += amount;
      }

      return {
        from: parsed.data.from,
        to: parsed.data.to,
        fixed,
        variable,
        total: fixed + variable,
        categories: [...byCategory.entries()]
          .map(([category, v]) => ({ category, ...v }))
          .sort((a, b) => b.amount - a.amount),
      };
    });
  }

  @Post("expenses")
  @RequireCrmPermission("finance", "edit")
  async create(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = CreateExpenseBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const amountMinor = toMinor(input.amount, input.currency);
      const taxMinor = toMinor(input.tax, input.currency);
      if (taxMinor > amountMinor) {
        throw new BadRequestException("tax cannot be more than the amount");
      }

      const isFixed =
        input.isFixed ?? DEFAULT_FIXED_CATEGORIES.has(input.category as never);

      let id: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO expenses
             (org_id, category, vendor, amount, tax, currency, incurred_on, is_fixed,
              marketing_source_id, user_id, source, recurs, attachment_url, memo, created_by)
           VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, $7::date, $8,
                   $9, $10, 'manual', $11, $12, $13, $14)
           RETURNING id`,
          [
            orgId,
            input.category,
            input.vendor ?? null,
            toNumericString(amountMinor, input.currency),
            toNumericString(taxMinor, input.currency),
            input.currency,
            input.incurredOn,
            isFixed,
            input.marketingSourceId ?? null,
            input.userId ?? null,
            input.recurs ?? null,
            input.attachmentUrl ?? null,
            input.memo ?? null,
            actor.type === "user" ? actor.id : null,
          ],
        );
        id = rows[0].id;
      } catch (err) {
        if (isCheckViolation(err)) {
          throw new ConflictException(
            `${input.incurredOn.slice(0, 7)} is a closed period - date this in the current open month`,
          );
        }
        throw err;
      }

      // ── NOT POSTED TO THE LEDGER UNTIL IT IS APPROVED ──────────────────
      //
      // Same reasoning as an unverified cash receipt (§6.2): an entered bill
      // is a claim, and a claim that moves the margin before anybody has
      // agreed to it makes the approval limit decorative. The posting happens
      // in `approve` below.
      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.expense.created",
        "expense",
        id,
        JSON.stringify({
          category: input.category,
          amount: toNumericString(amountMinor, input.currency),
          vendor: input.vendor ?? null,
        }),
      ]);

      const settings = await loadFinanceSettings(client, orgId);
      return {
        id,
        isFixed,
        needsOwnerApproval: amountMinor > settings.manualApprovalThresholdMinor,
        approvalLimit: Number(
          toNumericString(settings.manualApprovalThresholdMinor, input.currency),
        ),
      };
    });
  }

  /**
   * §3: a manager approves up to the limit; above it an owner must.
   *
   * ── WHY TWO GRANTS AND ONE ROUTE ───────────────────────────────────────────
   *
   * The route is mounted on `finance:edit`, which a manager has, and then
   * checks the AMOUNT against the limit and refuses above it unless the caller
   * also holds `finance:create`. Expressing it as two routes - one per grant -
   * would mean the console had to know the limit to decide which to call, and
   * a console that guesses wrong gets a 403 on a legitimate approval.
   */
  @Patch("expenses/:id/approve")
  @RequireCrmPermission("finance", "edit")
  async approve(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const actor = auditActor(req);
    return this.db.withOrg(orgId, async (client) => {
      const settings = await loadFinanceSettings(client, orgId);
      const { rows } = await client.query<{
        id: string;
        amount: string;
        tax: string;
        currency: string;
        category: string;
        incurred_on: string;
        approved_at: Date | null;
        created_by: string | null;
      }>(
        `SELECT id, amount::text, tax::text, currency, category,
                to_char(incurred_on, 'YYYY-MM-DD') AS incurred_on, approved_at, created_by
           FROM expenses WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const expense = rows[0];
      if (!expense) throw new NotFoundException("expense not found");
      if (expense.approved_at) throw new ConflictException("already approved");

      const amountMinor = toMinor(expense.amount, expense.currency);
      const netMinor = amountMinor - toMinor(expense.tax, expense.currency);

      if (amountMinor > settings.manualApprovalThresholdMinor) {
        const allowed = await this.holdsFinanceCreate(client, orgId, actor);
        if (!allowed) {
          throw new ForbiddenException(
            `${formatMoney(amountMinor, { currency: expense.currency })} is above the ${formatMoney(settings.manualApprovalThresholdMinor, { currency: expense.currency })} limit - an owner has to approve it`,
          );
        }
      }

      // §6.2's second-person rule applies to money going OUT as much as money
      // coming in: entering a bill and approving it alone is the shape of
      // every expense fraud there has ever been.
      if (actor.type === "user" && expense.created_by === actor.id) {
        throw new ForbiddenException("somebody else has to approve an expense you entered");
      }

      await client.query(
        `UPDATE expenses SET approved_by = $1, approved_at = now() WHERE id = $2`,
        [actor.type === "user" ? actor.id : null, id],
      );

      try {
        await ledger.post(client, {
          orgId,
          refType: "expense",
          refId: id,
          lines: ledger.expenseLines(netMinor),
          postedAt: `${expense.incurred_on}T00:00:00Z`,
          currency: expense.currency,
          memo: expense.category,
          actor,
        });
      } catch (err) {
        if (isCheckViolation(err)) {
          throw new ConflictException(
            `${expense.incurred_on.slice(0, 7)} is a closed period - this expense cannot be posted into it`,
          );
        }
        throw err;
      }

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.expense.approved",
        "expense",
        id,
        JSON.stringify({ amount: expense.amount, category: expense.category }),
      ]);
      return { id, approved: true };
    });
  }

  /** §6.3 again: an expense is reversed, never deleted. */
  @Post("expenses/:id/reverse")
  @RequireCrmPermission("finance", "create")
  async reverse(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({ reason: z.string().trim().min(3, "Say why.").max(500) })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        category: string;
        vendor: string | null;
        amount: string;
        tax: string;
        currency: string;
        incurred_on: string;
        approved_at: Date | null;
      }>(
        `SELECT id, category, vendor, amount::text, tax::text, currency,
                to_char(incurred_on, 'YYYY-MM-DD') AS incurred_on, approved_at
           FROM expenses WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const expense = rows[0];
      if (!expense) throw new NotFoundException("expense not found");

      const today = await orgToday(client);

      // The mirror row carries a NEGATIVE amount... except the column has a
      // `CHECK (amount >= 0)`. So the mirror is a zero-amount marker and the
      // LEDGER carries the correction - which is the right split: `expenses`
      // is the document trail (what bill, from whom) and the ledger is the
      // money. A negative expense row would also break every category sum that
      // does not know to exclude reversals.
      const { rows: mirror } = await client.query<{ id: string }>(
        `INSERT INTO expenses
           (org_id, category, vendor, amount, tax, currency, incurred_on,
            is_fixed, source, reverses_id, reversal_reason, created_by, approved_by, approved_at)
         SELECT org_id, category, vendor, 0, 0, currency, $2::date,
                is_fixed, source, id, $3, $4, $4, now()
           FROM expenses WHERE id = $1
         RETURNING id`,
        [id, today, parsed.data.reason, actor.type === "user" ? actor.id : null],
      );

      if (expense.approved_at) {
        const { rows: postings } = await client.query<{ posting_id: string }>(
          `SELECT DISTINCT posting_id FROM ledger_entries
            WHERE org_id = $1 AND ref_type = 'expense' AND ref_id = $2 AND reverses_id IS NULL`,
          [orgId, id],
        );
        for (const posting of postings) {
          await ledger.reverse(client, {
            orgId,
            postingId: posting.posting_id,
            reason: parsed.data.reason,
            actor,
            // Dated TODAY, not on the original's date. Reversing into a month
            // that may be closed is exactly what the period lock exists to
            // refuse, and §9 says a correction to a locked period is "an
            // explicit adjustment entry in the current open period".
            postedAt: `${today}T00:00:00Z`,
          });
        }
      }

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.expense.reversed",
        "expense",
        id,
        JSON.stringify({ reason: parsed.data.reason, mirrorId: mirror[0].id }),
      ]);
      return { id, reversedBy: mirror[0].id };
    });
  }

  @Patch("expenses/:id")
  @RequireCrmPermission("finance", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = UpdateExpenseBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const patch = parsed.data;
    const actor = auditActor(req);

    // ── AMOUNT AND DATE ARE NOT HERE, AND THAT IS THE POINT ────────────────
    //
    // §6.3's rule covers costs too. Editing a posted expense's amount would
    // silently change a month that may already have been reported, and
    // changing its date would move it between periods behind the period lock's
    // back. Both are corrections, which means a reversal and a new row.
    //
    // What IS editable is the classification - category, vendor, which source
    // or person it belongs to, whether it is fixed - because those are
    // bookkeeping judgements people legitimately revise, and none of them
    // change what was spent.
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<ExpenseRow>(
        `UPDATE expenses e
            SET category = COALESCE($2, e.category),
                vendor = CASE WHEN $3::boolean THEN $4 ELSE e.vendor END,
                is_fixed = COALESCE($5, e.is_fixed),
                marketing_source_id = CASE WHEN $6::boolean THEN $7::uuid ELSE e.marketing_source_id END,
                user_id = CASE WHEN $8::boolean THEN $9::uuid ELSE e.user_id END,
                recurs = CASE WHEN $10::boolean THEN $11 ELSE e.recurs END,
                attachment_url = CASE WHEN $12::boolean THEN $13 ELSE e.attachment_url END,
                memo = CASE WHEN $14::boolean THEN $15 ELSE e.memo END,
                last_used_on = CASE WHEN $16::boolean THEN $17::date ELSE e.last_used_on END
          WHERE e.id = $1
          RETURNING ${EXPENSE_COLUMNS.replace(/e\./g, "")}`,
        [
          id,
          patch.category ?? null,
          "vendor" in patch,
          patch.vendor ?? null,
          patch.isFixed ?? null,
          "marketingSourceId" in patch,
          patch.marketingSourceId ?? null,
          "userId" in patch,
          patch.userId ?? null,
          "recurs" in patch,
          patch.recurs ?? null,
          "attachmentUrl" in patch,
          patch.attachmentUrl ?? null,
          "memo" in patch,
          patch.memo ?? null,
          "lastUsedOn" in patch,
          patch.lastUsedOn ?? null,
        ],
      );
      if (!rows[0]) throw new NotFoundException("expense not found");
      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.expense.updated",
        "expense",
        id,
        JSON.stringify(patch),
      ]);
      return presentExpense(rows[0]);
    });
  }

  // ── §9 cost drivers ──────────────────────────────────────────────────────

  @Get("cost-drivers")
  @RequireCrmPermission("finance", "view")
  async drivers(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = z
      .object({ from: DateOnly.optional(), to: DateOnly.optional() })
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        kind: string;
        period: string;
        value: string;
        source: string;
        marketing_source_id: string | null;
        source_name: string | null;
      }>(
        `SELECT cd.kind, to_char(cd.period, 'YYYY-MM') AS period, cd.value::text,
                cd.source, cd.marketing_source_id, ms.name AS source_name
           FROM cost_drivers cd
           LEFT JOIN marketing_sources ms ON ms.id = cd.marketing_source_id
          WHERE ($1::date IS NULL OR cd.period >= date_trunc('month', $1::date))
            AND ($2::date IS NULL OR cd.period <= date_trunc('month', $2::date))
          ORDER BY cd.period DESC, cd.kind`,
        [parsed.data.from ?? null, parsed.data.to ?? null],
      );
      return {
        drivers: rows.map((r) => ({
          kind: r.kind,
          period: r.period,
          value: Number(r.value),
          source: r.source,
          marketingSourceId: r.marketing_source_id,
          marketingSourceName: r.source_name,
        })),
      };
    });
  }

  /**
   * Enter a driver the system cannot measure - seats on a subscription, leads
   * bought from a broker.
   *
   * ── A MANUAL VALUE IS NEVER OVERWRITTEN BY A MEASURED ONE ──────────────────
   *
   * The upsert sets `source = 'manual'`, and the worker's measuring sweep
   * writes only where `source = 'measured'` or the row is absent. Without that
   * asymmetry, somebody's typed seat count would be wiped by the next sweep -
   * and they would type it again, and it would be wiped again.
   */
  @Post("cost-drivers")
  @RequireCrmPermission("finance", "edit")
  async setDriver(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = z
      .object({
        kind: CostDriverKind,
        /** `YYYY-MM`. Stored as the month's first day. */
        period: z.string().regex(/^\d{4}-\d{2}$/),
        value: z.number().min(0),
        marketingSourceId: z.string().uuid().nullable().optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `INSERT INTO cost_drivers (org_id, kind, period, value, source, marketing_source_id)
         VALUES ($1, $2, ($3 || '-01')::date, $4::numeric, 'manual', $5)
         ON CONFLICT (org_id, kind, period,
                      COALESCE(marketing_source_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET value = EXCLUDED.value, source = 'manual'`,
        [orgId, input.kind, input.period, input.value, input.marketingSourceId ?? null],
      );
      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.cost_driver.set",
        "cost_driver",
        null,
        JSON.stringify(input),
      ]);
      return { ...input, source: "manual" };
    });
  }

  /**
   * Does this caller hold `finance:create`?
   *
   * Reads the grid directly, the same join `CrmPermissionsGuard` uses
   * including its `role_id IS NULL` fallback - rather than re-deriving a
   * verdict from the persona, which would answer a different question. This is
   * the same shape as `hasCrmPermission` in crm-permissions.guard.ts and
   * exists here because the check depends on the AMOUNT, which a route-level
   * decorator cannot see.
   */
  private async holdsFinanceCreate(
    client: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> },
    orgId: string,
    actor: ReturnType<typeof auditActor>,
  ): Promise<boolean> {
    if (actor.type !== "user") return false;
    const { rowCount } = await client.query(
      `SELECT 1
         FROM memberships m
         JOIN roles r
           ON r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
         JOIN role_permissions rp
           ON rp.role_id = r.id AND rp.object_type = 'finance' AND rp.action = 'create'
        WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active'
        LIMIT 1`,
      [actor.id, orgId],
    );
    return (rowCount ?? 0) > 0;
  }
}
