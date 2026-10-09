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
  AGING_BUCKETS,
  DateOnly,
  type MatchStatus,
  OFFLINE_METHODS,
  PaymentMethod,
  PaymentStatus,
  agingBucket,
  formatMoney,
  isCollected,
  paymentStatusMovable,
  scheduleItemStatus,
  toMinor,
  toNumericString,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { isCheckViolation, isUniqueViolation } from "../../common/pg-errors";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { loadFinanceSettings, orgToday } from "./finance-settings";
import * as ledger from "./ledger";
import { applyReceipt, match } from "./matcher";

/**
 * §6 the canonical payment, §6.2 manual and offline money, §6.3 corrections,
 * §8 the unmatched queue, and the dues/aging views §11 drills into.
 *
 * ── THE THREE RULES THIS FILE EXISTS TO ENFORCE ─────────────────────────────
 *
 * 1. §6.2 Cash, cheque and demand draft enter as `pending_verification`, need
 *    proof, and above the org's threshold need a SECOND PERSON. The request's
 *    own actor may never be that person - checked in code, because a CHECK
 *    constraint cannot see who is making the request.
 * 2. §6.3 Nothing is edited or deleted. A mistake is reversed: a reversing
 *    ledger posting plus a status move, both audit-logged with a reason.
 * 3. §8  A match is applied only at or above the org's confidence threshold.
 *    Anything weaker is a SUGGESTION in a queue, and a tie is never broken by
 *    guessing.
 *
 * ── AND THE ONE IT DOES NOT ─────────────────────────────────────────────────
 *
 * Nothing here messages a customer. There is no send path, no template and no
 * number: a due reminder creates a TASK for the collector (§12.5), which is
 * the standing rule in this repo that the outreach sweep, the follow-up ladder
 * and the document-date sweep all hold to.
 */

const Amount = z.number().min(0.01, "An amount is required.");
const Reason = z.string().trim().min(3, "Say why.").max(500);

const RecordPaymentBody = z.object({
  /** Either is enough; the matcher fills in the rest. */
  dealId: z.string().uuid().optional(),
  scheduleItemId: z.string().uuid().optional(),
  amount: Amount,
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .default("INR"),
  method: z.string().trim().min(1).max(60),
  /** Cheque number, bank, UTR, last four digits. */
  methodDetail: z.record(z.string(), z.unknown()).default({}),
  receivedOn: DateOnly.optional(),
  /** §6.2: an image/PDF already uploaded to object storage, or a reference. */
  proofUrl: z.string().trim().url().max(2000).optional(),
  memo: z.string().trim().max(500).optional(),
});

const VerifyBody = z.object({
  /**
   * §6.2's cheque clearing step, plus the ordinary "I have seen the cash".
   * `PAYMENT_MANUAL_MOVES` in @aura/shared is the only table that decides
   * whether a move is legal - the same rule doc 37 R5 recorded after quotation
   * statuses turned out to be spelled out in seven places.
   */
  status: PaymentStatus,
  reason: z.string().trim().max(500).optional(),
});

const RefundBody = z.object({
  amount: Amount,
  reason: Reason,
  refundedOn: DateOnly.optional(),
  externalId: z.string().trim().max(200).optional(),
});

const MatchBody = z.object({
  /** A single item, or several when a payment is split across instalments. */
  allocations: z
    .array(z.object({ scheduleItemId: z.string().uuid(), amount: Amount }))
    .min(1)
    .max(60),
});

const PaymentListQuery = z.object({
  matchStatus: z.enum(["matched", "suggested", "unmatched"]).optional(),
  status: PaymentStatus.optional(),
  dealId: z.string().uuid().optional(),
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  /** The verification queue. */
  pendingOnly: z.enum(["1", "true"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const PAYMENT_COLUMNS = `fp.id, fp.deal_id, fp.schedule_item_id, fp.account_id, fp.contact_id,
  fp.amount::text AS amount, fp.currency, fp.method, fp.method_detail, fp.status, fp.source,
  fp.external_id, fp.received_at, fp.settled_at,
  fp.fee::text AS fee, fp.tax_on_fee::text AS tax_on_fee, fp.net::text AS net,
  fp.match_status, fp.match_confidence, fp.match_rule,
  fp.proof_url, fp.recorded_by, fp.verified_by, fp.verified_at,
  fp.reversal_reason, fp.memo, fp.created_at`;

interface PaymentRow {
  id: string;
  deal_id: string | null;
  schedule_item_id: string | null;
  account_id: string | null;
  contact_id: string | null;
  amount: string;
  currency: string;
  method: string;
  method_detail: Record<string, unknown>;
  status: string;
  source: string;
  external_id: string | null;
  received_at: Date;
  settled_at: Date | null;
  fee: string;
  tax_on_fee: string;
  net: string | null;
  match_status: string;
  match_confidence: string | null;
  match_rule: string | null;
  proof_url: string | null;
  recorded_by: string | null;
  verified_by: string | null;
  verified_at: Date | null;
  reversal_reason: string | null;
  memo: string | null;
  created_at: Date;
  deal_name?: string | null;
  customer_name?: string | null;
}

function presentPayment(row: PaymentRow) {
  return {
    id: row.id,
    dealId: row.deal_id,
    dealName: row.deal_name ?? null,
    scheduleItemId: row.schedule_item_id,
    accountId: row.account_id,
    contactId: row.contact_id,
    customerName: row.customer_name?.trim() || null,
    amount: Number(row.amount),
    currency: row.currency,
    method: row.method,
    methodDetail: row.method_detail,
    status: row.status,
    /**
     * Derived, not stored. Every "collected" figure in the module reads
     * `COLLECTED_STATUSES`, and publishing the same verdict on the row means a
     * console can grey out a bounced cheque without re-implementing the set.
     */
    collected: isCollected(row.status),
    source: row.source,
    externalId: row.external_id,
    receivedAt: row.received_at,
    settledAt: row.settled_at,
    fee: Number(row.fee),
    taxOnFee: Number(row.tax_on_fee),
    net: row.net === null ? null : Number(row.net),
    matchStatus: row.match_status,
    matchConfidence: row.match_confidence === null ? null : Number(row.match_confidence),
    matchRule: row.match_rule,
    proofUrl: row.proof_url,
    recordedBy: row.recorded_by,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    reversalReason: row.reversal_reason,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

const AUDIT_SQL = `INSERT INTO audit_log
   (org_id, actor_type, actor_id, action, target_type, target_id, meta)
 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`;

@Controller("finance")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class FinancePaymentsController {
  constructor(private readonly db: DbService) {}

  // ── Reading ──────────────────────────────────────────────────────────────

  @Get("payments")
  @RequireCrmPermission("finance", "view")
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = PaymentListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace(/\$\?/g, `$${params.length}`));
      };

      if (q.matchStatus) add("fp.match_status = $?", q.matchStatus);
      if (q.status) add("fp.status = $?", q.status);
      if (q.dealId) add("fp.deal_id = $?", q.dealId);
      // `::date` comparisons, inside a transaction whose TimeZone is the org's
      // (withOrgContext sets it) - so "1 March" means the org's 1 March rather
      // than UTC's, which on an Indian floor differ for five and a half hours
      // of every day.
      if (q.from) add("fp.received_at::date >= $?::date", q.from);
      if (q.to) add("fp.received_at::date <= $?::date", q.to);
      if (q.pendingOnly) where.push("fp.status = 'pending_verification'");
      if (where.length === 0) where.push("true");

      params.push(q.limit, q.offset);
      const { rows } = await client.query<PaymentRow & { total: string }>(
        `SELECT ${PAYMENT_COLUMNS},
                d.name AS deal_name,
                COALESCE(a.name, c.first_name || ' ' || COALESCE(c.last_name, '')) AS customer_name,
                count(*) OVER() AS total
           FROM finance_payments fp
           LEFT JOIN deals d    ON d.id = fp.deal_id
           LEFT JOIN accounts a ON a.id = fp.account_id
           LEFT JOIN contacts c ON c.id = fp.contact_id
          WHERE ${where.join(" AND ")}
          ORDER BY fp.received_at DESC, fp.id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        payments: rows.map(({ total: _t, ...row }) => presentPayment(row as PaymentRow)),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  /**
   * §11's dues list and aging view, in one call.
   *
   * ── `overdue` IS COMPUTED HERE, FROM THE ORG'S OWN TODAY ───────────────────
   *
   * The stored `status` column cannot hold 'overdue' (0172's CHECK refuses it),
   * for the reason that migration's header records at length: `invoices.status`
   * allowed the value for a year with nothing setting it, so `due_date` was
   * decorative and reports filtered on a word only a human could type. A status
   * that depends on today's date is only ever as correct as the last sweep;
   * this one cannot drift because it is never stored.
   */
  @Get("dues")
  @RequireCrmPermission("finance", "view")
  async dues(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = z
      .object({
        bucket: z.enum(AGING_BUCKETS).optional(),
        dealId: z.string().uuid().optional(),
        /** Only what a particular rep has to chase - the telecaller's own view. */
        ownerUserId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const where = ["ps.status <> 'cancelled'", "ps.paid_amount < ps.amount"];
      const params: unknown[] = [];
      if (q.dealId) {
        params.push(q.dealId);
        where.push(`ps.deal_id = $${params.length}`);
      }
      if (q.ownerUserId) {
        params.push(q.ownerUserId);
        where.push(`d.owner_user_id = $${params.length}`);
      }

      params.push(q.limit, q.offset);
      const { rows } = await client.query<{
        id: string;
        deal_id: string;
        position: number;
        due_date: string;
        amount: string;
        paid_amount: string;
        status: string;
        promised_on: string | null;
        currency: string;
        deal_name: string;
        owner_user_id: string | null;
        customer_name: string | null;
        total: string;
      }>(
        `SELECT ps.id, ps.deal_id, ps.position,
                to_char(ps.due_date, 'YYYY-MM-DD') AS due_date,
                ps.amount::text, ps.paid_amount::text, ps.status,
                to_char(ps.promised_on, 'YYYY-MM-DD') AS promised_on,
                d.currency, d.name AS deal_name, d.owner_user_id,
                COALESCE(a.name, c.first_name || ' ' || COALESCE(c.last_name, '')) AS customer_name,
                count(*) OVER() AS total
           FROM payment_schedules ps
           JOIN deals d ON d.id = ps.deal_id
           LEFT JOIN accounts a ON a.id = d.account_id
           LEFT JOIN contacts c ON c.id = d.contact_id
          WHERE ${where.join(" AND ")}
          ORDER BY ps.due_date, ps.id
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      const items = rows.map((row) => {
        const amountMinor = toMinor(row.amount, row.currency);
        const paidMinor = toMinor(row.paid_amount, row.currency);
        return {
          id: row.id,
          dealId: row.deal_id,
          dealName: row.deal_name,
          customerName: row.customer_name?.trim() || null,
          ownerUserId: row.owner_user_id,
          position: row.position,
          dueDate: row.due_date,
          promisedOn: row.promised_on,
          currency: row.currency,
          amount: Number(row.amount),
          paid: Number(row.paid_amount),
          outstanding: Number(toNumericString(amountMinor - paidMinor, row.currency)),
          status: scheduleItemStatus(
            { amountMinor, paidMinor, dueDate: row.due_date },
            today,
          ),
          bucket: agingBucket(row.due_date, today),
          daysLate: Math.max(
            0,
            Math.round(
              (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.due_date}T00:00:00Z`)) /
                86_400_000,
            ),
          ),
        };
      });

      const filtered = q.bucket ? items.filter((i) => i.bucket === q.bucket) : items;

      // The totals are computed over the WHOLE outstanding set, not over the
      // page - a page's aging summary is a number nobody can use, and an owner
      // reading "₹2L in 90+" from page 1 of 7 would be reading the wrong thing.
      const { rows: summary } = await client.query<{ bucket: string; amount: string; items: string }>(
        `SELECT CASE
                  WHEN ps.due_date >= org_reporting_today() THEN 'current'
                  WHEN org_reporting_today() - ps.due_date <= 30 THEN '0_30'
                  WHEN org_reporting_today() - ps.due_date <= 60 THEN '31_60'
                  WHEN org_reporting_today() - ps.due_date <= 90 THEN '61_90'
                  ELSE '90_plus'
                END AS bucket,
                sum(ps.amount - ps.paid_amount)::text AS amount,
                count(*)::text AS items
           FROM payment_schedules ps
          WHERE ps.status <> 'cancelled' AND ps.paid_amount < ps.amount
          GROUP BY 1`,
      );

      const aging = Object.fromEntries(
        AGING_BUCKETS.map((bucket) => [
          bucket,
          {
            amount: Number(summary.find((s) => s.bucket === bucket)?.amount ?? 0),
            items: Number(summary.find((s) => s.bucket === bucket)?.items ?? 0),
          },
        ]),
      );

      return {
        today,
        items: filtered,
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        aging,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  /**
   * §12.4 `slipped_promise` needs a promise to slip. This is where one is set.
   *
   * `finance:edit` and not `create`: recording what a customer said is the
   * collector's daily work, not a change to the books.
   */
  @Patch("dues/:id/promise")
  @RequireCrmPermission("finance", "edit")
  async promise(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z
      .object({ promisedOn: DateOnly.nullable(), note: z.string().trim().max(500).optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string; status: string }>(
        `UPDATE payment_schedules
            SET promised_on = $1::date,
                memo = COALESCE($2, memo)
          WHERE id = $3 AND status <> 'paid'
          RETURNING id, status`,
        [parsed.data.promisedOn, parsed.data.note ?? null, id],
      );
      if (!rows[0]) {
        throw new NotFoundException("no open instalment with that id");
      }
      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.due.promised",
        "schedule_item",
        id,
        JSON.stringify({ promisedOn: parsed.data.promisedOn }),
      ]);
      return { id, promisedOn: parsed.data.promisedOn };
    });
  }

  // ── §6.2 recording money that arrived outside the app ────────────────────

  @Post("payments")
  @RequireCrmPermission("finance", "create")
  async record(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = RecordPaymentBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    const method = input.method as PaymentMethod;
    const offline = OFFLINE_METHODS.has(method);

    // §6.2: "require proof (image/PDF upload or reference number)". Either
    // satisfies it - a cheque number in `methodDetail` is proof in the sense
    // that matters, which is that the claim can be checked against a bank
    // statement later.
    const hasReference = Object.values(input.methodDetail).some(
      (v) => typeof v === "string" && v.trim().length > 0,
    );
    if (offline && !input.proofUrl && !hasReference) {
      throw new BadRequestException(
        "cash, cheque and demand draft need a proof upload or a reference number",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      const settings = await loadFinanceSettings(client, orgId);
      const amountMinor = toMinor(input.amount, input.currency);
      const receivedOn = input.receivedOn ?? (await orgToday(client));

      // §6.2's three statuses. An offline payment NEVER lands as received: the
      // only record that the money exists is somebody saying so, and above the
      // threshold a second person has to agree.
      const status: PaymentStatus = offline ? "pending_verification" : "received";
      const needsSecondPerson = offline && amountMinor > settings.manualApprovalThresholdMinor;

      let dealId = input.dealId ?? null;
      let scheduleItemId = input.scheduleItemId ?? null;

      // An explicit schedule item implies its deal, so a caller does not have
      // to send both and cannot send a mismatched pair.
      if (scheduleItemId) {
        const { rows } = await client.query<{ deal_id: string }>(
          `SELECT deal_id FROM payment_schedules WHERE id = $1`,
          [scheduleItemId],
        );
        if (!rows[0]) throw new NotFoundException("schedule item not found");
        dealId = rows[0].deal_id;
      }

      const verdict = await match(client, {
        orgId,
        amountMinor,
        receivedAt: new Date(`${receivedOn}T00:00:00Z`),
        reference: { dealId, scheduleItemId },
        threshold: settings.autoMatchConfidence,
      });

      // ── EACH FIELD FILLED INDEPENDENTLY, AND THAT IS THE FIX ──────────────
      //
      // This was `if (!dealId && verdict.chosen)`, which skipped the whole
      // block whenever the caller named a deal - the common case. The money
      // was applied correctly (`applyReceipt` ran either way), but the payment
      // row never recorded WHICH instalment it paid, so
      // `schedule_item_id` was null on every deal-referenced payment.
      //
      // The visible consequence was §11's days-to-collect: the metric measures
      // from the schedule item's due date through a LEFT JOIN on that column,
      // so median and p90 came back null forever. Found by opening the
      // dashboard against real data, not by any test - the unit tests cover
      // `applyToSchedule`, which was doing its job.
      //
      // A caller's explicit value still wins; this only fills what was absent.
      // For a receipt spanning several instalments `chosen` is the FIRST one
      // it pays, which is the honest single answer to "which instalment is
      // this against" and matches §15's oldest-open-first rule.
      if (verdict.chosen) {
        dealId = dealId ?? verdict.chosen.dealId;
        scheduleItemId = scheduleItemId ?? (verdict.chosen.scheduleItemId || null);
      }

      let paymentId: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO finance_payments
             (org_id, deal_id, schedule_item_id, account_id, contact_id,
              amount, currency, method, method_detail, status, source,
              received_at, net, match_status, match_confidence, match_rule,
              proof_url, recorded_by, memo)
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::jsonb, $10, 'manual',
                   $11::date, $6::numeric, $12, $13, $14, $15, $16, $17)
           RETURNING id`,
          [
            orgId,
            dealId,
            scheduleItemId,
            verdict.chosen?.accountId ?? null,
            verdict.chosen?.contactId ?? null,
            toNumericString(amountMinor, input.currency),
            input.currency,
            input.method,
            JSON.stringify(input.methodDetail),
            status,
            receivedOn,
            dealId ? verdict.status : "unmatched",
            verdict.confidence,
            verdict.rule,
            input.proofUrl ?? null,
            actor.type === "user" ? actor.id : null,
            input.memo ?? null,
          ],
        );
        paymentId = rows[0].id;
      } catch (err) {
        if (isCheckViolation(err)) {
          throw new ConflictException(
            `${receivedOn.slice(0, 7)} is a closed period - date this in the current open month`,
          );
        }
        throw err;
      }

      // ── The money only moves once it is CONFIRMED ──────────────────────
      //
      // An offline payment posts NOTHING to the ledger and applies nothing to
      // the schedule until it is verified. That is §6.2's substance: until a
      // second pair of eyes has seen the cash, a claim that it arrived must
      // not change what the business believes it collected - otherwise the
      // threshold is a formality and the dashboard is already wrong.
      if (status === "received") {
        await this.settleInto(client, {
          orgId,
          paymentId,
          dealId,
          amountMinor,
          currency: input.currency,
          receivedOn,
          actor,
        });
      }

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.payment.recorded",
        "finance_payment",
        paymentId,
        JSON.stringify({
          amount: toNumericString(amountMinor, input.currency),
          method: input.method,
          status,
          needsSecondPerson,
          matchRule: verdict.rule,
        }),
      ]);

      return {
        id: paymentId,
        status,
        /** §6.2's threshold, surfaced so the console can say what happens next. */
        needsSecondPerson,
        approvalThreshold: Number(
          toNumericString(settings.manualApprovalThresholdMinor, input.currency),
        ),
        match: {
          status: dealId ? verdict.status : "unmatched",
          confidence: verdict.confidence,
          rule: verdict.rule,
          reason: verdict.reason,
          candidates: verdict.candidates,
        },
      };
    });
  }

  /**
   * §6.2: verify a pending payment, clear or bounce a cheque.
   *
   * ── THE SECOND PERSON IS CHECKED HERE, NOT IN THE DATABASE ────────────────
   *
   * A CHECK constraint can compare `verified_by` to `recorded_by`, and that is
   * not enough: the person recording a cash receipt could record it under
   * somebody else's id, or approve it themselves in a second request. What has
   * to be true is that the ACTOR of THIS request is not the one who recorded
   * it, and only the request knows who that is.
   *
   * Below the threshold any `finance:edit` holder may confirm - a ₹500 cash
   * receipt needing two signatures is a rule people route around rather than
   * follow.
   */
  @Patch("payments/:id/verify")
  @RequireCrmPermission("finance", "edit")
  async verify(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = VerifyBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const target = parsed.data.status;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const settings = await loadFinanceSettings(client, orgId);
      const { rows } = await client.query<{
        id: string;
        status: string;
        amount: string;
        currency: string;
        deal_id: string | null;
        method: string;
        recorded_by: string | null;
        received_at: Date;
      }>(
        `SELECT id, status, amount::text, currency, deal_id, method, recorded_by, received_at
           FROM finance_payments WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const payment = rows[0];
      if (!payment) throw new NotFoundException("payment not found");

      if (!paymentStatusMovable(payment.status as PaymentStatus, target)) {
        throw new ConflictException(
          `a ${payment.status} payment cannot become ${target}`,
        );
      }

      const amountMinor = toMinor(payment.amount, payment.currency);
      if (
        amountMinor > settings.manualApprovalThresholdMinor &&
        actor.type === "user" &&
        payment.recorded_by === actor.id
      ) {
        throw new ForbiddenException(
          `${formatMoney(amountMinor, { currency: payment.currency })} needs a second person to approve it`,
        );
      }

      const receivedOn = payment.received_at.toISOString().slice(0, 10);
      const confirming = isCollected(target);

      await client.query(
        `UPDATE finance_payments
            SET status = $1,
                verified_by = $2,
                verified_at = now(),
                reversal_reason = COALESCE($3, reversal_reason)
          WHERE id = $4`,
        [target, actor.type === "user" ? actor.id : null, parsed.data.reason ?? null, id],
      );

      if (confirming && payment.deal_id) {
        await this.settleInto(client, {
          orgId,
          paymentId: id,
          dealId: payment.deal_id,
          amountMinor,
          currency: payment.currency,
          receivedOn,
          actor,
        });
      }

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        target === "cheque_bounced" ? "finance.payment.bounced" : "finance.payment.verified",
        "finance_payment",
        id,
        JSON.stringify({ from: payment.status, to: target, reason: parsed.data.reason ?? null }),
      ]);

      return { id, status: target };
    });
  }

  /**
   * §6.3: reverse a payment that should not have been posted.
   *
   * Not a delete and not an edit - a reversing ledger posting plus a status
   * move, with the schedule put back the way it was. This is also what §6.2
   * means by a bounced cheque "reversing the ledger entry and re-opening the
   * schedule item": the two paths are the same mechanism, which is why
   * bouncing a CLEARED cheque comes through here rather than through verify.
   */
  @Post("payments/:id/reverse")
  @RequireCrmPermission("finance", "create")
  async reverse(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = z.object({ reason: Reason }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        status: string;
        amount: string;
        currency: string;
        deal_id: string | null;
      }>(
        `SELECT id, status, amount::text, currency, deal_id
           FROM finance_payments WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const payment = rows[0];
      if (!payment) throw new NotFoundException("payment not found");
      if (!isCollected(payment.status)) {
        throw new ConflictException(
          `a ${payment.status} payment has nothing to reverse - it was never counted`,
        );
      }

      const { rows: postings } = await client.query<{ posting_id: string }>(
        `SELECT DISTINCT posting_id FROM ledger_entries
          WHERE org_id = $1 AND ref_type = 'payment' AND ref_id = $2
            AND reverses_id IS NULL`,
        [orgId, id],
      );

      for (const posting of postings) {
        try {
          await ledger.reverse(client, {
            orgId,
            postingId: posting.posting_id,
            reason: parsed.data.reason,
            actor,
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            // The unique index on `reverses_id` - this posting has already
            // been reversed. Reported rather than swallowed: a second
            // reversal would double the correction.
            throw new ConflictException("this payment has already been reversed");
          }
          throw err;
        }
      }

      // Put the schedule back. Re-derived from what remains applied rather
      // than subtracted, so a sequence of reversals cannot drift the balance.
      if (payment.deal_id) {
        await this.recomputeSchedulePaid(client, orgId, payment.deal_id);
      }

      await client.query(
        `UPDATE finance_payments
            SET status = 'reversed', reversal_reason = $1
          WHERE id = $2`,
        [parsed.data.reason, id],
      );

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.payment.reversed",
        "finance_payment",
        id,
        JSON.stringify({ from: payment.status, reason: parsed.data.reason, postings: postings.length }),
      ]);

      return { id, status: "reversed", reversedPostings: postings.length };
    });
  }

  /** §9/§10: a refund, which is both a cash movement and a clawback trigger. */
  @Post("payments/:id/refund")
  @RequireCrmPermission("finance", "create")
  async refund(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = RefundBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        status: string;
        amount: string;
        currency: string;
        deal_id: string | null;
        refunded: string;
      }>(
        `SELECT fp.id, fp.status, fp.amount::text, fp.currency, fp.deal_id,
                COALESCE((SELECT sum(r.amount) FROM finance_refunds r
                           WHERE r.payment_id = fp.id AND r.status = 'processed'), 0)::text AS refunded
           FROM finance_payments fp WHERE fp.id = $1 FOR UPDATE`,
        [id],
      );
      const payment = rows[0];
      if (!payment) throw new NotFoundException("payment not found");
      if (!isCollected(payment.status)) {
        throw new ConflictException(`a ${payment.status} payment cannot be refunded`);
      }

      const amountMinor = toMinor(input.amount, payment.currency);
      const paidMinor = toMinor(payment.amount, payment.currency);
      const alreadyMinor = toMinor(payment.refunded, payment.currency);
      if (alreadyMinor + amountMinor > paidMinor) {
        // Refunding more than was received is not a rounding question - it is
        // either a typo or an attempt to move money out through the refund
        // path, and both deserve a refusal rather than a negative payment.
        throw new BadRequestException(
          `only ${formatMoney(paidMinor - alreadyMinor, { currency: payment.currency })} of this payment is still refundable`,
        );
      }

      const refundedOn = input.refundedOn ?? (await orgToday(client));
      const { rows: created } = await client.query<{ id: string }>(
        `INSERT INTO finance_refunds
           (org_id, payment_id, amount, currency, reason, status, external_id, refunded_on, created_by)
         VALUES ($1, $2, $3::numeric, $4, $5, 'processed', $6, $7::date, $8)
         RETURNING id`,
        [
          orgId,
          id,
          toNumericString(amountMinor, payment.currency),
          payment.currency,
          input.reason,
          input.externalId ?? null,
          refundedOn,
          actor.type === "user" ? actor.id : null,
        ],
      );
      const refundId = created[0].id;

      await ledger.post(client, {
        orgId,
        refType: "refund",
        refId: refundId,
        lines: ledger.refundLines(amountMinor),
        postedAt: `${refundedOn}T00:00:00Z`,
        currency: payment.currency,
        memo: input.reason,
        actor,
      });

      // Fully or partially - the distinction matters because
      // `partially_refunded` is still a COLLECTED status (the receipt did
      // happen) while `refunded` is not, and the gateway fee and chargeback
      // rates divide by the gross either way.
      const fully = alreadyMinor + amountMinor >= paidMinor;
      await client.query(`UPDATE finance_payments SET status = $1 WHERE id = $2`, [
        fully ? "refunded" : "partially_refunded",
        id,
      ]);

      if (payment.deal_id) {
        await this.recomputeSchedulePaid(client, orgId, payment.deal_id);
      }

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.payment.refunded",
        "finance_payment",
        id,
        JSON.stringify({
          refundId,
          amount: toNumericString(amountMinor, payment.currency),
          reason: input.reason,
          fully,
        }),
      ]);

      return { id: refundId, paymentId: id, status: fully ? "refunded" : "partially_refunded" };
    });
  }

  // ── §8 the unmatched queue ───────────────────────────────────────────────

  /**
   * What a person has to look at: money in, nobody knows for what.
   *
   * Includes `suggested` as well as `unmatched`, because §8's whole point is
   * that a weak match is offered rather than applied - and a queue that showed
   * only the unmatched ones would leave every suggestion sitting unconfirmed
   * forever, which is the same as not having made it.
   */
  @Get("matching/queue")
  @RequireCrmPermission("finance", "view")
  async queue(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const settings = await loadFinanceSettings(client, orgId);
      const { rows } = await client.query<PaymentRow>(
        `SELECT ${PAYMENT_COLUMNS}
           FROM finance_payments fp
          WHERE fp.match_status IN ('unmatched', 'suggested')
            AND fp.status NOT IN ('failed', 'reversed', 'cheque_bounced')
          ORDER BY fp.received_at
          LIMIT $1`,
        [parsed.data.limit],
      );

      // Candidates are re-derived per payment rather than stored, deliberately:
      // a payment that was unmatchable on Tuesday becomes matchable the moment
      // somebody generates the schedule it belongs to, and a stored candidate
      // list would still say "no match" on Thursday.
      const items = [];
      for (const row of rows) {
        const verdict = await match(client, {
          orgId,
          amountMinor: toMinor(row.amount, row.currency),
          receivedAt: row.received_at,
          threshold: settings.autoMatchConfidence,
        });
        items.push({
          payment: presentPayment(row),
          suggestions: verdict.candidates.map((c) => ({
            scheduleItemId: c.scheduleItemId,
            dealId: c.dealId,
            dealName: c.dealName,
            customerName: c.customerName,
            dueDate: c.dueDate,
            outstanding: Number(toNumericString(c.amountMinor - c.paidMinor, row.currency)),
          })),
          reason: verdict.reason,
        });
      }
      return { items, autoMatchConfidence: settings.autoMatchConfidence };
    });
  }

  /**
   * §8: "one-click match, split a payment across items."
   *
   * One endpoint for both, because a split IS a match with more than one
   * allocation - and two endpoints would mean two places that have to get the
   * sum check right.
   */
  @Post("payments/:id/match")
  @RequireCrmPermission("finance", "edit")
  async applyMatch(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = MatchBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        amount: string;
        currency: string;
        status: string;
        deal_id: string | null;
        received_at: Date;
      }>(
        `SELECT id, amount::text, currency, status, deal_id, received_at
           FROM finance_payments WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const payment = rows[0];
      if (!payment) throw new NotFoundException("payment not found");
      if (payment.deal_id) {
        throw new ConflictException(
          "this payment is already linked - reverse it to move it to another deal",
        );
      }

      const amountMinor = toMinor(payment.amount, payment.currency);
      const allocatedMinor = parsed.data.allocations.reduce(
        (sum, a) => sum + toMinor(a.amount, payment.currency),
        0,
      );
      if (allocatedMinor > amountMinor) {
        throw new BadRequestException(
          `allocations total ${formatMoney(allocatedMinor, { currency: payment.currency })}, more than the payment`,
        );
      }

      const ids = parsed.data.allocations.map((a) => a.scheduleItemId);
      const { rows: items } = await client.query<{
        id: string;
        deal_id: string;
        amount: string;
        paid_amount: string;
      }>(
        `SELECT id, deal_id, amount::text, paid_amount::text
           FROM payment_schedules WHERE id = ANY($1::uuid[]) FOR UPDATE`,
        [ids],
      );
      if (items.length !== ids.length) {
        throw new NotFoundException("one of those instalments does not exist");
      }

      // A split across two DIFFERENT deals is refused. The canonical payment
      // carries one `deal_id`, so a cross-deal split would have to either lose
      // that link or become two payments - and silently splitting one bank
      // credit into two payment rows would break the gateway idempotency key
      // that stops double-crediting. Two receipts is the honest answer, and
      // the console says so.
      const deals = new Set(items.map((i) => i.deal_id));
      if (deals.size > 1) {
        throw new BadRequestException(
          "a single payment cannot be split across two deals - record it as two payments",
        );
      }
      const dealId = items[0].deal_id;

      for (const allocation of parsed.data.allocations) {
        const item = items.find((i) => i.id === allocation.scheduleItemId);
        if (!item) continue;
        const appliedMinor = toMinor(allocation.amount, payment.currency);
        const paidMinor = toMinor(item.paid_amount, payment.currency) + appliedMinor;
        const itemAmountMinor = toMinor(item.amount, payment.currency);
        await client.query(
          `UPDATE payment_schedules
              SET paid_amount = $1::numeric,
                  status = $2,
                  promised_on = CASE WHEN $2 = 'paid' THEN NULL ELSE promised_on END
            WHERE id = $3`,
          [
            toNumericString(paidMinor, payment.currency),
            paidMinor >= itemAmountMinor ? "paid" : "partial",
            allocation.scheduleItemId,
          ],
        );
      }

      const creditMinor = amountMinor - allocatedMinor;
      if (creditMinor > 0) {
        await client.query(
          `UPDATE deals SET credit_balance = credit_balance + $1::numeric WHERE id = $2`,
          [toNumericString(creditMinor, payment.currency), dealId],
        );
      }

      await client.query(
        `UPDATE finance_payments
            SET deal_id = $1,
                schedule_item_id = $2,
                match_status = 'matched',
                match_confidence = 1,
                match_rule = 'manual',
                account_id = COALESCE(account_id, (SELECT account_id FROM deals WHERE id = $1)),
                contact_id = COALESCE(contact_id, (SELECT contact_id FROM deals WHERE id = $1))
          WHERE id = $3`,
        [dealId, parsed.data.allocations.length === 1 ? ids[0] : null, id],
      );

      await ledger.post(client, {
        orgId,
        refType: "payment",
        refId: id,
        lines: ledger.paymentReceivedLines({
          grossMinor: amountMinor,
          feeMinor: 0,
          taxOnFeeMinor: 0,
          creditMinor,
        }),
        postedAt: payment.received_at,
        currency: payment.currency,
        memo: "Matched by hand",
        actor,
      });

      await client.query(AUDIT_SQL, [
        orgId,
        actor.type,
        actor.id,
        "finance.payment.matched",
        "finance_payment",
        id,
        JSON.stringify({ dealId, allocations: parsed.data.allocations.length, creditMinor }),
      ]);

      return { id, dealId, matchStatus: "matched" as MatchStatus };
    });
  }

  // ── Shared internals ─────────────────────────────────────────────────────

  /**
   * Apply a confirmed receipt: schedule first, then the ledger.
   *
   * In that order, because the ledger posting needs to know how much became a
   * CREDIT rather than paying down a receivable - and only applying it to the
   * schedule works that out (§15's oldest-open-first rule). Posting first and
   * correcting afterwards would mean a moment where the ledger says the
   * receivable fell by more than it did.
   */
  private async settleInto(
    client: Parameters<typeof applyReceipt>[0],
    options: {
      orgId: string;
      paymentId: string;
      dealId: string | null;
      amountMinor: number;
      currency: string;
      receivedOn: string;
      actor: ReturnType<typeof auditActor>;
    },
  ): Promise<void> {
    let creditMinor = options.amountMinor;
    if (options.dealId) {
      const applied = await applyReceipt(client, {
        orgId: options.orgId,
        dealId: options.dealId,
        amountMinor: options.amountMinor,
        currency: options.currency,
      });
      creditMinor = applied.creditMinor;
    }

    try {
      await ledger.post(client, {
        orgId: options.orgId,
        refType: "payment",
        refId: options.paymentId,
        lines: ledger.paymentReceivedLines({
          grossMinor: options.amountMinor,
          feeMinor: 0,
          taxOnFeeMinor: 0,
          creditMinor,
        }),
        postedAt: `${options.receivedOn}T00:00:00Z`,
        currency: options.currency,
        actor: options.actor,
      });
    } catch (err) {
      if (isCheckViolation(err)) {
        throw new ConflictException(
          `${options.receivedOn.slice(0, 7)} is a closed period - date this in the current open month`,
        );
      }
      throw err;
    }
  }

  /**
   * Re-derive every schedule item's `paid_amount` for a deal from the payments
   * that are still collected.
   *
   * ── WHY RE-DERIVED AND NOT DECREMENTED ─────────────────────────────────────
   *
   * A reversal or a refund could subtract what it added. It does not, because
   * subtraction compounds: two reversals of a part-applied payment, in either
   * order, can leave `paid_amount` negative or short depending on which
   * instalment each one guessed it had paid. Recomputing from the surviving
   * payments is the only version that is correct however many corrections have
   * happened and in whatever order.
   *
   * The cost is a per-deal recompute on a correction, which is rare by
   * construction.
   */
  private async recomputeSchedulePaid(
    client: Parameters<typeof applyReceipt>[0],
    orgId: string,
    dealId: string,
  ): Promise<void> {
    const { rows } = await client.query<{ net: string; currency: string }>(
      `SELECT COALESCE(sum(
                fp.amount - COALESCE((SELECT sum(r.amount) FROM finance_refunds r
                                       WHERE r.payment_id = fp.id AND r.status = 'processed'), 0)
              ), 0)::text AS net,
              COALESCE(max(fp.currency), 'INR') AS currency
         FROM finance_payments fp
        WHERE fp.deal_id = $1
          AND fp.status IN ('received', 'cheque_cleared', 'partially_refunded', 'disputed')`,
      [dealId],
    );
    const currency = rows[0].currency;
    const netMinor = toMinor(rows[0].net, currency);

    await client.query(
      `UPDATE payment_schedules SET paid_amount = 0, status = 'open'
        WHERE deal_id = $1 AND status <> 'cancelled'`,
      [dealId],
    );
    await client.query(`UPDATE deals SET credit_balance = 0 WHERE id = $1`, [dealId]);

    if (netMinor > 0) {
      await applyReceipt(client, { orgId, dealId, amountMinor: netMinor, currency });
    }
  }
}
