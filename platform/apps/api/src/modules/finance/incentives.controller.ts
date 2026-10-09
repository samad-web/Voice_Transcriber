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
  DateOnly,
  IncentivePlanType,
  IncentiveRules,
  PAYOUT_MOVES,
  type PayoutStatus,
  incentiveFor,
  toMinor,
  toNumericString,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, type CrmRecordScope, scopeClause } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * §10 incentives: plans, the calculation, clawbacks, and the payout flow.
 *
 * ── THE MUST THIS FILE IS BUILT AROUND ──────────────────────────────────────
 *
 * §10: "compute incentives from COLLECTED (confirmed) payments only, never
 * from booked deals." Every query here filters on `COLLECTED_STATUSES` through
 * the same status list the metrics layer uses, so an authorized card payment,
 * an unverified cash claim and a bounced cheque all earn nothing. The
 * difference between that and paying on booked value is the difference between
 * an incentive scheme and an advance.
 *
 * `commission_plans` (0088) is NOT reused and that is deliberate: it computes
 * from booked deal value for the sales report. Two mechanisms with the same
 * name would be worse than two names, so the console labels this one
 * "Incentives (paid on money received)".
 *
 * ── AND THE PRIVACY RULE ────────────────────────────────────────────────────
 *
 * §3: "a telecaller must never be able to read another telecaller's pay or
 * incentive, even by guessing an ID." Every read here applies
 * `scopeClause("incentive", …)`, which resolves to
 * `incentive_payouts.user_id = $caller` for a role granted `owned` - and
 * `CrmPermissionsGuard` narrows a telecaller or sales persona to `owned` even
 * where the grid said `all`. The guessing-an-ID half is why the single-payout
 * read applies the clause too, not just the list.
 */

const PlanName = z.string().trim().min(1, "Name this plan.").max(200);

const CreatePlanBody = z.object({
  name: PlanName,
  type: IncentivePlanType,
  rules: IncentiveRules,
  clawbackDays: z.number().int().min(0).max(730).default(90),
  effectiveFrom: DateOnly,
  effectiveTo: DateOnly.nullable().optional(),
  /** NULL = everyone on a telecaller or sales persona. */
  userId: z.string().uuid().nullable().optional(),
});

const UpdatePlanBody = z
  .object({
    name: PlanName.optional(),
    rules: IncentiveRules.optional(),
    clawbackDays: z.number().int().min(0).max(730).optional(),
    effectiveTo: DateOnly.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

const Period = z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM");

const AUDIT_SQL = `INSERT INTO audit_log
   (org_id, actor_type, actor_id, action, target_type, target_id, meta)
 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;

interface PayoutRow {
  id: string;
  user_id: string;
  period: string;
  plan_id: string | null;
  calculated: string;
  adjustments: string;
  payable: string;
  currency: string;
  status: string;
  approved_by: string | null;
  approved_at: Date | null;
  paid_at: Date | null;
  paid_reference: string | null;
  kpi_score: string | null;
  user_name?: string | null;
}

function presentPayout(row: PayoutRow) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name ?? null,
    period: row.period,
    planId: row.plan_id,
    calculated: Number(row.calculated),
    adjustments: Number(row.adjustments),
    payable: Number(row.payable),
    currency: row.currency,
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    paidAt: row.paid_at,
    paidReference: row.paid_reference,
    kpiScore: row.kpi_score === null ? null : Number(row.kpi_score),
  };
}

@Controller("finance")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class IncentivesController {
  constructor(private readonly db: DbService) {}

  // ── Plans ────────────────────────────────────────────────────────────────

  @Get("incentive-plans")
  @RequireCrmPermission("incentive", "view")
  async plans(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        name: string;
        type: string;
        rules: Record<string, unknown>;
        clawback_days: number;
        effective_from: string;
        effective_to: string | null;
        user_id: string | null;
        active: boolean;
      }>(
        `SELECT id, name, type, rules, clawback_days,
                to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                to_char(effective_to, 'YYYY-MM-DD')   AS effective_to,
                user_id, active
           FROM incentive_plans
          ORDER BY effective_from DESC, lower(name)`,
      );
      return {
        plans: rows.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          rules: r.rules,
          clawbackDays: r.clawback_days,
          effectiveFrom: r.effective_from,
          effectiveTo: r.effective_to,
          userId: r.user_id,
          active: r.active,
        })),
      };
    });
  }

  @Post("incentive-plans")
  @RequireCrmPermission("incentive", "edit")
  async createPlan(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = CreatePlanBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    assertRulesMatchType(input.type, input.rules);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO incentive_plans
           (org_id, name, type, rules, clawback_days, effective_from, effective_to, user_id, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6::date, $7::date, $8, $9)
         RETURNING id`,
        [
          orgId,
          input.name,
          input.type,
          JSON.stringify(input.rules),
          input.clawbackDays,
          input.effectiveFrom,
          input.effectiveTo ?? null,
          input.userId ?? null,
          actor.type === "user" ? actor.id : null,
        ],
      );
      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.incentive_plan.created",
        "incentive_plan",
        rows[0].id,
        JSON.stringify({ type: input.type, effectiveFrom: input.effectiveFrom }),
      ]);
      return { id: rows[0].id };
    });
  }

  /**
   * §10: "effective-dated plans: a change never recalculates closed periods."
   *
   * Which is enforced on the PAYOUT rather than here - a payout past
   * `calculated` refuses to be recomputed - so a plan's rules can be corrected
   * without hunting for which months are safe. Editing the rules affects every
   * future calculation and no approved one.
   */
  @Patch("incentive-plans/:id")
  @RequireCrmPermission("incentive", "edit")
  async updatePlan(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = UpdatePlanBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const patch = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows: current } = await client.query<{ type: string }>(
        `SELECT type FROM incentive_plans WHERE id = $1`,
        [id],
      );
      if (!current[0]) throw new NotFoundException("plan not found");
      if (patch.rules) {
        assertRulesMatchType(current[0].type as IncentivePlanType, patch.rules);
      }

      const { rowCount } = await client.query(
        `UPDATE incentive_plans
            SET name = COALESCE($2, name),
                rules = COALESCE($3::jsonb, rules),
                clawback_days = COALESCE($4, clawback_days),
                effective_to = CASE WHEN $5::boolean THEN $6::date ELSE effective_to END,
                active = COALESCE($7, active)
          WHERE id = $1`,
        [
          id,
          patch.name ?? null,
          patch.rules ? JSON.stringify(patch.rules) : null,
          patch.clawbackDays ?? null,
          "effectiveTo" in patch,
          patch.effectiveTo ?? null,
          patch.active ?? null,
        ],
      );
      if (!rowCount) throw new NotFoundException("plan not found");
      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.incentive_plan.updated",
        "incentive_plan",
        id,
        JSON.stringify(patch),
      ]);
      return { id };
    });
  }

  // ── Payouts ──────────────────────────────────────────────────────────────

  @Get("payouts")
  @RequireCrmPermission("incentive", "view")
  async payouts(
    @OrgId() orgId: string,
    @RecordScope() scope: CrmRecordScope,
    @Query() query: unknown,
  ) {
    const parsed = z
      .object({
        period: Period.optional(),
        status: z.enum(["calculated", "approved", "paid"]).optional(),
        userId: z.string().uuid().optional(),
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
      if (q.period) add("p.period = ($? || '-01')::date", q.period);
      if (q.status) add("p.status = $?", q.status);
      if (q.userId) add("p.user_id = $?", q.userId);

      // §3's privacy rule. `scopeClause` returns null for an `all` grant and
      // `p.user_id = $n` for `owned` - which the guard has already narrowed to
      // `owned` for any telecaller or sales persona.
      const owned = scopeClause("incentive", scope, params.length + 1, "p");
      if (owned) {
        params.push(scope.userId);
        where.push(owned);
      }
      if (where.length === 0) where.push("true");

      const { rows } = await client.query<PayoutRow>(
        `SELECT p.id, p.user_id, to_char(p.period, 'YYYY-MM') AS period, p.plan_id,
                p.calculated::text, p.adjustments::text, p.payable::text, p.currency,
                p.status, p.approved_by, p.approved_at, p.paid_at, p.paid_reference,
                p.kpi_score::text,
                u.name AS user_name
           FROM incentive_payouts p
           LEFT JOIN users u ON u.id = p.user_id
          WHERE ${where.join(" AND ")}
          ORDER BY p.period DESC, u.name`,
        params,
      );
      return { payouts: rows.map(presentPayout) };
    });
  }

  /**
   * §10: "a statement per telecaller" - the lines that make up one payout.
   *
   * ── THE SCOPE CLAUSE IS ON THE PAYOUT, NOT ON THE LINES ────────────────────
   *
   * This is the route §3's "even by guessing an ID" is about. The lines carry
   * no `user_id` of their own, so filtering them would be impossible; the
   * join to `incentive_payouts` carries the scope instead, and a telecaller
   * requesting a colleague's payout id gets a 404 rather than a statement.
   *
   * A 404 and not a 403, deliberately: a 403 on a specific id confirms the id
   * exists, which is half of what the guesser wanted.
   */
  @Get("payouts/:id")
  @RequireCrmPermission("incentive", "view")
  async payout(
    @OrgId() orgId: string,
    @RecordScope() scope: CrmRecordScope,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const params: unknown[] = [id];
      const owned = scopeClause("incentive", scope, 2, "p");
      if (owned) params.push(scope.userId);

      const { rows } = await client.query<PayoutRow>(
        `SELECT p.id, p.user_id, to_char(p.period, 'YYYY-MM') AS period, p.plan_id,
                p.calculated::text, p.adjustments::text, p.payable::text, p.currency,
                p.status, p.approved_by, p.approved_at, p.paid_at, p.paid_reference,
                p.kpi_score::text, u.name AS user_name
           FROM incentive_payouts p
           LEFT JOIN users u ON u.id = p.user_id
          WHERE p.id = $1 ${owned ? `AND ${owned}` : ""}`,
        params,
      );
      if (!rows[0]) throw new NotFoundException("payout not found");

      const { rows: lines } = await client.query<{
        id: string;
        deal_id: string | null;
        payment_id: string | null;
        refund_id: string | null;
        basis: string;
        amount: string;
        type: string;
        memo: string | null;
        created_at: Date;
        deal_name: string | null;
        received_at: Date | null;
      }>(
        `SELECT l.id, l.deal_id, l.payment_id, l.refund_id,
                l.basis::text, l.amount::text, l.type, l.memo, l.created_at,
                d.name AS deal_name, fp.received_at
           FROM incentive_lines l
           LEFT JOIN deals d ON d.id = l.deal_id
           LEFT JOIN finance_payments fp ON fp.id = l.payment_id
          WHERE l.payout_id = $1
          ORDER BY l.type, l.created_at`,
        [id],
      );

      return {
        ...presentPayout(rows[0]),
        lines: lines.map((l) => ({
          id: l.id,
          dealId: l.deal_id,
          dealName: l.deal_name,
          paymentId: l.payment_id,
          refundId: l.refund_id,
          basis: Number(l.basis),
          amount: Number(l.amount),
          type: l.type,
          memo: l.memo,
          receivedAt: l.received_at,
        })),
      };
    });
  }

  /**
   * Run (or re-run) the calculation for a period.
   *
   * ── IDEMPOTENT BY CONSTRUCTION ─────────────────────────────────────────────
   *
   * Re-running replaces the lines of any payout still `calculated` and leaves
   * approved and paid ones alone. That combination is what makes this safe to
   * call from a console button: a month that has been signed off cannot move,
   * and a month in progress always reflects the money collected so far.
   *
   * The unique index `incentive_lines_earn` is the second guard - one earn per
   * (payout, payment) - so even a concurrent double-run cannot double a
   * payout.
   */
  @Post("payouts/calculate")
  @RequireCrmPermission("incentive", "edit")
  async calculate(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = z.object({ period: Period }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const period = parsed.data.period;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      // ── Who earned what, from COLLECTED payments only (§10's MUST) ──────
      //
      // Credited to the DEAL's owner, not to whoever recorded the payment: the
      // rep who closed it earns the incentive even when the finance handler
      // keyed in the cheque. `owner_user_id` is the column the CRM already
      // uses for that question.
      const { rows: earnings } = await client.query<{
        user_id: string;
        payment_id: string;
        deal_id: string;
        amount: string;
        currency: string;
      }>(
        `SELECT d.owner_user_id AS user_id, fp.id AS payment_id, fp.deal_id,
                fp.amount::text, fp.currency
           FROM finance_payments fp
           JOIN deals d ON d.id = fp.deal_id
          WHERE fp.status IN ('received', 'cheque_cleared', 'partially_refunded', 'disputed')
            AND date_trunc('month', fp.received_at) = ($1 || '-01')::date
            AND d.owner_user_id IS NOT NULL
          ORDER BY d.owner_user_id, fp.received_at`,
        [period],
      );

      // ── And what has to come back (§10's clawback) ──────────────────────
      //
      // A refund lands in the CURRENT period as a negative line, whatever
      // period the original payment was in - which is §10's wording and the
      // only version that works: reaching back into a paid month would change
      // a number somebody has already been given.
      const { rows: clawbacks } = await client.query<{
        user_id: string;
        refund_id: string;
        payment_id: string;
        deal_id: string;
        amount: string;
        currency: string;
        clawback_days: number;
        days_since: string;
      }>(
        `SELECT d.owner_user_id AS user_id, r.id AS refund_id, fp.id AS payment_id,
                fp.deal_id, r.amount::text, r.currency,
                COALESCE(pl.clawback_days, 90) AS clawback_days,
                (r.refunded_on - fp.received_at::date)::text AS days_since
           FROM finance_refunds r
           JOIN finance_payments fp ON fp.id = r.payment_id
           JOIN deals d ON d.id = fp.deal_id
           LEFT JOIN incentive_plans pl
             ON pl.org_id = r.org_id
            AND pl.active
            AND (pl.user_id IS NULL OR pl.user_id = d.owner_user_id)
            AND pl.effective_from <= r.refunded_on
            AND (pl.effective_to IS NULL OR pl.effective_to >= r.refunded_on)
          WHERE r.status = 'processed'
            AND date_trunc('month', r.refunded_on) = ($1 || '-01')::date
            AND d.owner_user_id IS NOT NULL
            -- Only where an earn was actually paid out. A refund of money that
            -- never earned anything has nothing to claw back, and a negative
            -- line for it would take money off somebody who was never given it.
            AND EXISTS (SELECT 1 FROM incentive_lines il
                         WHERE il.payment_id = fp.id AND il.type = 'earn')
            AND NOT EXISTS (SELECT 1 FROM incentive_lines il WHERE il.refund_id = r.id)`,
        [period],
      );

      const userIds = new Set([
        ...earnings.map((e) => e.user_id),
        ...clawbacks.map((c) => c.user_id),
      ]);

      const results: { userId: string; payoutId: string; calculated: number; lines: number }[] = [];

      for (const userId of userIds) {
        const { rows: plans } = await client.query<{
          id: string;
          type: string;
          rules: Record<string, unknown>;
          clawback_days: number;
        }>(
          `SELECT id, type, rules, clawback_days
             FROM incentive_plans
            WHERE active
              AND (user_id IS NULL OR user_id = $1)
              AND effective_from <= ($2 || '-01')::date + interval '1 month' - interval '1 day'
              AND (effective_to IS NULL OR effective_to >= ($2 || '-01')::date)
            -- A plan naming this person beats the org-wide one. Ordering on
            -- whether user_id IS NULL puts the specific plan first; without
            -- it the planner's row order would decide somebody's pay.
            ORDER BY (user_id IS NULL), effective_from DESC
            LIMIT 1`,
          [userId, period],
        );
        const plan = plans[0];
        if (!plan) continue;

        const { rows: existing } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM incentive_payouts
            WHERE user_id = $1 AND period = ($2 || '-01')::date FOR UPDATE`,
          [userId, period],
        );
        if (existing[0] && existing[0].status !== "calculated") {
          // Approved or paid - §10's "a change never recalculates closed
          // periods", enforced here rather than by hunting for locked months.
          continue;
        }

        const userEarnings = earnings.filter((e) => e.user_id === userId);
        const userClawbacks = clawbacks.filter((c) => c.user_id === userId);
        const currency = userEarnings[0]?.currency ?? userClawbacks[0]?.currency ?? "INR";

        // §10's `kpi_linked`. Read from the performance module's own scorecard
        // (0144) and stored on the payout, so a statement can still be
        // explained months later after the score has moved.
        const kpiScore = plan.type === "kpi_linked" ? await this.kpiScore(client, userId, period) : null;

        const collectedMinor = userEarnings.reduce(
          (sum, e) => sum + toMinor(e.amount, e.currency),
          0,
        );
        const rules = IncentiveRules.parse(plan.rules);
        const earnedMinor = incentiveFor(
          { type: plan.type as IncentivePlanType, rules },
          { collectedMinor, kpiScore },
        );

        const payoutId = existing[0]?.id
          ? existing[0].id
          : (
              await client.query<{ id: string }>(
                `INSERT INTO incentive_payouts
                   (org_id, user_id, period, plan_id, calculated, currency, kpi_score)
                 VALUES ($1, $2, ($3 || '-01')::date, $4, 0, $5, $6)
                 RETURNING id`,
                [orgId, userId, period, plan.id, currency, kpiScore],
              )
            ).rows[0].id;

        // Replace the lines rather than appending: a re-run after a late
        // payment must not leave the previous run's lines behind, which is
        // what makes the statement add up to the figure above it.
        await client.query(`DELETE FROM incentive_lines WHERE payout_id = $1`, [payoutId]);

        // ── WHY THE LINES ARE APPORTIONED AND NOT RE-COMPUTED PER PAYMENT ──
        //
        // A slab plan is marginal: the incentive on the whole month is not the
        // sum of the incentive on each payment taken alone. So the TOTAL is
        // computed once from the month's collections, and the per-payment
        // lines are that total apportioned by each payment's share - which
        // keeps the statement's lines summing exactly to the payable figure.
        let lineCount = 0;
        for (const earning of userEarnings) {
          const basisMinor = toMinor(earning.amount, earning.currency);
          const shareMinor =
            collectedMinor === 0 ? 0 : Math.round((earnedMinor * basisMinor) / collectedMinor);
          await client.query(
            `INSERT INTO incentive_lines
               (org_id, payout_id, deal_id, payment_id, basis, amount, type)
             VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, 'earn')
             ON CONFLICT (payout_id, payment_id) WHERE type = 'earn' AND payment_id IS NOT NULL
             DO UPDATE SET basis = EXCLUDED.basis, amount = EXCLUDED.amount`,
            [
              orgId,
              payoutId,
              earning.deal_id,
              earning.payment_id,
              toNumericString(basisMinor, currency),
              toNumericString(shareMinor, currency),
            ],
          );
          lineCount += 1;
        }

        let adjustmentsMinor = 0;
        for (const clawback of userClawbacks) {
          const withinWindow =
            Number(clawback.days_since) <= (clawback.clawback_days ?? plan.clawback_days);
          if (!withinWindow) continue;
          const basisMinor = toMinor(clawback.amount, clawback.currency);
          // The SAME function on a negative basis, which is what makes a
          // clawback the exact mirror of its earn - pinned by a test in
          // finance.test.ts, because a residue left behind by a near-mirror
          // would stay in somebody's payout forever.
          const clawedMinor = incentiveFor(
            { type: plan.type as IncentivePlanType, rules },
            { collectedMinor: -basisMinor, kpiScore },
          );
          await client.query(
            `INSERT INTO incentive_lines
               (org_id, payout_id, deal_id, payment_id, refund_id, basis, amount, type, memo)
             VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, 'clawback', $8)`,
            [
              orgId,
              payoutId,
              clawback.deal_id,
              clawback.payment_id,
              clawback.refund_id,
              toNumericString(-basisMinor, currency),
              toNumericString(clawedMinor, currency),
              `Refunded within ${clawback.clawback_days} days`,
            ],
          );
          adjustmentsMinor += clawedMinor;
          lineCount += 1;
        }

        await client.query(
          `UPDATE incentive_payouts
              SET calculated = $1::numeric, adjustments = $2::numeric,
                  plan_id = $3, kpi_score = $4
            WHERE id = $5`,
          [
            toNumericString(earnedMinor, currency),
            toNumericString(adjustmentsMinor, currency),
            plan.id,
            kpiScore,
            payoutId,
          ],
        );

        results.push({
          userId,
          payoutId,
          calculated: Number(toNumericString(earnedMinor + adjustmentsMinor, currency)),
          lines: lineCount,
        });
      }

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.payouts.calculated",
        "incentive_payout",
        null,
        JSON.stringify({ period, people: results.length }),
      ]);

      return { period, payouts: results };
    });
  }

  /**
   * §10's payout flow: `calculated → approved → paid`.
   *
   * ── NOBODY APPROVES THEIR OWN PAY ──────────────────────────────────────────
   *
   * Checked here because it needs the requester's identity, which a CHECK
   * constraint cannot see - the same reason §6.2's second-person rule lives in
   * the payment controller. The grant alone is not enough: 0172 seeds
   * `incentive:edit` to the admin roles, and an org_admin who is also carrying
   * a sales target would otherwise be able to sign off their own.
   */
  @Patch("payouts/:id/status")
  @RequireCrmPermission("incentive", "edit")
  async setStatus(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({
        status: z.enum(["approved", "paid"]),
        reference: z.string().trim().max(200).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const target = parsed.data.status as PayoutStatus;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        status: string;
        user_id: string;
        payable: string;
        currency: string;
        period: string;
      }>(
        `SELECT id, status, user_id, payable::text, currency, to_char(period, 'YYYY-MM') AS period
           FROM incentive_payouts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const payout = rows[0];
      if (!payout) throw new NotFoundException("payout not found");

      if (!PAYOUT_MOVES[payout.status as PayoutStatus].includes(target)) {
        throw new ConflictException(`a ${payout.status} payout cannot become ${target}`);
      }
      if (actor.type === "user" && payout.user_id === actor.id) {
        throw new ForbiddenException("somebody else has to approve your own incentive");
      }

      await client.query(
        `UPDATE incentive_payouts
            SET status = $1,
                approved_by = CASE WHEN $1 = 'approved' THEN $2 ELSE approved_by END,
                approved_at = CASE WHEN $1 = 'approved' THEN now() ELSE approved_at END,
                paid_at = CASE WHEN $1 = 'paid' THEN now() ELSE paid_at END,
                paid_reference = COALESCE($3, paid_reference)
          WHERE id = $4`,
        [target, actor.type === "user" ? actor.id : null, parsed.data.reference ?? null, id],
      );

      // ── An approved payout becomes a COST ──────────────────────────────
      //
      // Written as an `incentive`-category expense, which is what makes it
      // show up in margin and CAC. Approved, not paid: the business has
      // incurred it the moment it is signed off, and waiting for the bank
      // transfer would understate the month it was earned in.
      //
      // `incurred_on` is the LAST DAY of the payout's own period, not today -
      // an incentive earned in March is a March cost even when it is approved
      // in April, and dating it today would move it between months.
      if (target === "approved") {
        await client.query(
          `INSERT INTO expenses
             (org_id, category, vendor, amount, tax, currency, incurred_on,
              is_fixed, user_id, source, approved_by, approved_at, memo)
           SELECT $1, 'incentive',
                  COALESCE(u.name, 'Incentive'),
                  p.payable, 0, p.currency,
                  (p.period + interval '1 month' - interval '1 day')::date,
                  false, p.user_id, 'recurring', $2, now(),
                  'Incentive for ' || to_char(p.period, 'Mon YYYY')
             FROM incentive_payouts p
             LEFT JOIN users u ON u.id = p.user_id
            WHERE p.id = $3
              AND p.payable > 0
              -- One expense per payout, whatever happens to the approval.
              AND NOT EXISTS (
                SELECT 1 FROM expenses e
                 WHERE e.org_id = p.org_id AND e.category = 'incentive'
                   AND e.user_id = p.user_id
                   AND e.incurred_on = (p.period + interval '1 month' - interval '1 day')::date)`,
          [orgId, actor.type === "user" ? actor.id : null, id],
        );
      }

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        `finance.payout.${target}`,
        "incentive_payout",
        id,
        JSON.stringify({
          userId: payout.user_id,
          period: payout.period,
          payable: payout.payable,
          reference: parsed.data.reference ?? null,
        }),
      ]);
      return { id, status: target };
    });
  }

  /**
   * The KPI score for `kpi_linked` plans - the mean call quality score across
   * the person's analysed calls in the period.
   *
   * ── WHERE THIS NUMBER COMES FROM, AND WHAT IT IS NOT ───────────────────────
   *
   * `call_analytics.quality_score`, the AI read's 0-100 score per call. It is
   * the only per-person quality number in the schema that is computed rather
   * than typed, which is what makes it safe to pay on: a score a manager
   * enters is a score a manager can be leaned on about.
   *
   * It is NOT the composite "overall KPI score" §10 imagines, because this
   * platform does not have one - there is no KPI catalog and no weighted
   * composite (that is doc 41's subject, still a plan). Using the mean call
   * quality is the honest substitute, and the payout stores the value it used
   * so a statement stays explainable if the definition later changes.
   *
   * ── THE BRIDGE IS NULLABLE, WHICH LIMITS THIS ──────────────────────────────
   *
   * A call belongs to a `telecallers` row; an incentive belongs to a `users`
   * row; `telecallers.user_id` links them and is NULLABLE. A rep whose handset
   * identity was never linked to their login scores null here - not zero - and
   * `incentiveFor` pays 1x on a null rather than 0x. Paying nothing because a
   * join is unpopulated is the wrong failure direction for somebody's wages.
   */
  private async kpiScore(
    client: { query: <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }> },
    userId: string,
    period: string,
  ): Promise<number | null> {
    const { rows } = await client.query<{ score: string | null }>(
      `SELECT avg(ca.quality_score)::text AS score
         FROM call_analytics ca
         JOIN calls c      ON c.id = ca.call_id
         JOIN telecallers t ON t.id = c.telecaller_id
        WHERE t.user_id = $1
          AND ca.quality_score IS NOT NULL
          AND date_trunc('month', c.started_at) = ($2 || '-01')::date`,
      [userId, period],
    );
    const score = rows[0]?.score;
    return score === null || score === undefined ? null : Number(score);
  }
}

/**
 * A plan whose rules do not match its type is a plan that pays zero, silently.
 *
 * `percent_of_collected` with no `percent` earns nothing on every payment; a
 * `slab` plan with no slabs does the same. Both pass `IncentiveRules` (every
 * field is optional, because one schema covers three types), so the check has
 * to be here - and it has to be a 400 rather than a default, because
 * defaulting somebody's commission rate is not a decision code should make.
 */
function assertRulesMatchType(type: IncentivePlanType, rules: IncentiveRules): void {
  if (type === "slab" && !(rules.slabs && rules.slabs.length > 0)) {
    throw new BadRequestException("a slab plan needs at least one slab");
  }
  if (
    (type === "percent_of_collected" || type === "kpi_linked") &&
    (rules.percent === undefined || rules.percent === 0)
  ) {
    throw new BadRequestException("set the percentage this plan pays");
  }
  if (type === "kpi_linked" && !rules.kpiMultipliers) {
    throw new BadRequestException("a KPI-linked plan needs its multiplier steps");
  }
  if (
    rules.minPayoutMinor !== undefined &&
    rules.maxPayoutMinor !== undefined &&
    rules.minPayoutMinor > rules.maxPayoutMinor
  ) {
    throw new BadRequestException("the floor cannot be above the cap");
  }
}
