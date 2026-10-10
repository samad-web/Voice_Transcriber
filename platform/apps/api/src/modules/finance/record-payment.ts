import { ConflictException, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "@aura/db";
import { COLLECTED_STATUSES, isCollected, toMinor, toNumericString } from "@aura/shared";
import type { AuditActor } from "../../common/audit-actor";
import { actorUserId } from "../../common/audit-actor";
import { isCheckViolation } from "../../common/pg-errors";
import * as ledger from "./ledger";
import { applyReceipt, match, type MatchVerdict } from "./matcher";
import { loadFinanceSettings, orgToday } from "./finance-settings";

/**
 * The ONE path by which money becomes a `finance_payments` row.
 *
 * ── WHY THIS WAS EXTRACTED FROM THE CONTROLLER ──────────────────────────────
 *
 * Build docs/indian-business-finance-documents-cycles-import §3 has a key
 * design point that is really an architectural constraint:
 *
 *   "Imports feed the same pipelines: imported payments go through the same
 *    normalizer and matching engine as connector payments, so reconciliation
 *    and the Advisor behave identically."
 *
 * There were two callers of this logic before the import existed - the manual
 * `POST /finance/payments` and the connector drain - and the drain already
 * shares the matcher through `@aura/db`. Adding a third caller that re-wrote
 * the insert would have produced a payment that LOOKS the same and is not:
 * one with no `schedule_item_id` (so days-to-collect cannot be measured), or
 * no ledger posting (so the ledger stops balancing), or no `match_status` (so
 * it never reaches the matching queue).
 *
 * That is not hypothetical. The deal-referenced-payment bug this module
 * already carries a long comment about - `schedule_item_id` left null on every
 * payment whose caller named a deal - was exactly one field forgotten in one
 * of two places, and it made a §11 metric return null forever without failing
 * a single test.
 *
 * So the controller now delegates here, and so does the import. One insert,
 * one settlement, one audit shape.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 *
 * It does not check permissions and it does not decide whether the caller may
 * import. Both callers are guarded at their own edge - `finance:create` on the
 * controller, and the import's own finance-entity check - and a function that
 * re-derived authorization from an actor it was handed would be a second,
 * weaker gate.
 */

/** §6.2's offline methods: money whose only witness is a person saying so. */
export const OFFLINE_PAYMENT_METHODS = new Set(["cash", "cheque", "demand_draft"]);

export interface RecordPaymentInput {
  /**
   * `string | number`, and the string is the one to prefer.
   *
   * The manual route's zod schema is `z.number()`, so it arrives as a double
   * and `toMinor` has to round it. The IMPORT reads cells, so it can hand over
   * the digits as written and `toMinor` takes them apart without ever
   * multiplying - which is the only path on which ₹1,02,500.55 survives
   * exactly. Both are accepted; neither caller is forced to convert first.
   */
  amount: string | number;
  currency: string;
  method: string;
  methodDetail?: Record<string, unknown>;
  /** The org's today when absent. */
  receivedOn?: string | null;
  dealId?: string | null;
  scheduleItemId?: string | null;
  proofUrl?: string | null;
  memo?: string | null;
  /**
   * What produced this row.
   *
   * These four are 0173's CHECK verbatim, not a vocabulary of this file's own.
   * The import uses `csv_import`, which the schema already anticipated - a
   * plausible-looking `'import'` would have failed at commit time with a
   * 23514, after the person had read a dry run that said the file was fine.
   *
   * The distinction is not decoration: §12's `unmatched_money` rule and the
   * reconciliation both read `source`, and an imported row claiming to be
   * `manual` would be indistinguishable from somebody typing it in.
   */
  source?: "manual" | "csv_import" | "bank_import" | "connector";
  /** Pre-resolved identity hints, used by the import's narration matching. */
  identity?: { phone?: string | null; email?: string | null; accountId?: string | null; contactId?: string | null };
}

export interface RecordPaymentResult {
  id: string;
  status: "received" | "pending_verification";
  needsSecondPerson: boolean;
  approvalThresholdMinor: number;
  dealId: string | null;
  scheduleItemId: string | null;
  verdict: MatchVerdict;
}

/**
 * Record a payment, match it, and settle it if it needs no second person.
 *
 * Must be called inside a `withOrg` transaction - it issues several statements
 * that have to succeed or fail together, and `applyReceipt` takes a row lock.
 */
export async function recordFinancePayment(
  client: PoolClient,
  orgId: string,
  input: RecordPaymentInput,
  actor: AuditActor,
): Promise<RecordPaymentResult> {
  const settings = await loadFinanceSettings(client, orgId);
  const amountMinor = toMinor(input.amount, input.currency);
  const receivedOn = input.receivedOn || (await orgToday(client));
  const offline = OFFLINE_PAYMENT_METHODS.has(input.method);

  // §6.2's three statuses. An offline payment NEVER lands as received: the
  // only record that the money exists is somebody saying so, and above the
  // threshold a second person has to agree.
  const status: "received" | "pending_verification" = offline ? "pending_verification" : "received";
  const needsSecondPerson = offline && amountMinor > settings.manualApprovalThresholdMinor;

  let dealId = input.dealId ?? null;
  let scheduleItemId = input.scheduleItemId ?? null;

  // An explicit schedule item implies its deal, so a caller cannot send a
  // mismatched pair.
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
    identity: input.identity,
    threshold: settings.autoMatchConfidence,
  });

  // Each field filled INDEPENDENTLY. This was once `if (!dealId &&
  // verdict.chosen)`, which skipped the whole block whenever the caller named
  // a deal - the common case - so `schedule_item_id` was null on every
  // deal-referenced payment and §11's days-to-collect came back null forever.
  // A caller's explicit value still wins; this only fills what was absent.
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
       VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::jsonb, $10, $11,
               $12::date, $6::numeric, $13, $14, $15, $16, $17, $18)
       RETURNING id`,
      [
        orgId,
        dealId,
        scheduleItemId,
        verdict.chosen?.accountId ?? input.identity?.accountId ?? null,
        verdict.chosen?.contactId ?? input.identity?.contactId ?? null,
        toNumericString(amountMinor, input.currency),
        input.currency,
        input.method,
        JSON.stringify(input.methodDetail ?? {}),
        status,
        input.source ?? "manual",
        receivedOn,
        dealId ? verdict.status : "unmatched",
        verdict.confidence,
        verdict.rule,
        input.proofUrl ?? null,
        actorUserId(actor),
        input.memo ?? null,
      ],
    );
    paymentId = rows[0].id;
  } catch (err) {
    if (isCheckViolation(err)) {
      // 0172's period-lock trigger. Reported as the sentence a person can act
      // on rather than as a 23514.
      throw new ConflictException(
        `${receivedOn.slice(0, 7)} is a closed period - date this in the current open month`,
      );
    }
    throw err;
  }

  // The money only moves once it is CONFIRMED. An offline payment posts
  // nothing to the ledger and applies nothing to the schedule until it is
  // verified - §6.2's substance, without which the threshold is a formality
  // and the dashboard is already wrong.
  if (status === "received") {
    await settlePayment(client, {
      orgId,
      paymentId,
      dealId,
      amountMinor,
      currency: input.currency,
      receivedOn,
      actor,
    });
  }

  return {
    id: paymentId,
    status,
    needsSecondPerson,
    approvalThresholdMinor: settings.manualApprovalThresholdMinor,
    dealId,
    scheduleItemId,
    verdict,
  };
}

/**
 * Reverse a collected payment: the ledger, the schedule and the status.
 *
 * ── THE THREE HALVES, AND WHY NO CALLER MAY DO TWO OF THEM ──────────────────
 *
 * §6.3's MUST is "never edit or delete a posted payment or ledger row", so a
 * correction is a reversal. A reversal that is not all three of these is worse
 * than none:
 *
 *   the ledger      a reversing posting, or the ledger stops balancing
 *   the schedule    re-derived, or the instalment stays marked paid
 *   the status      `reversed`, or every total still counts it
 *
 * The import's rollback (§3 step 11) is a second caller that needs exactly
 * this, and its first version did only the third - it set the status and left
 * the ledger holding an entry for money that had been un-received, which
 * `unbalancedPostings` would have reported as a defect weeks later with
 * nothing to tie it to. So the whole operation lives here and both callers get
 * all of it.
 *
 * Returns `null` when there was nothing to reverse, so a caller can tell "done"
 * from "it was never counted".
 */
export async function reverseFinancePayment(
  client: PoolClient,
  orgId: string,
  paymentId: string,
  reason: string,
  actor: AuditActor,
): Promise<{ reversedPostings: number; previousStatus: string } | null> {
  const { rows } = await client.query<{
    id: string;
    status: string;
    deal_id: string | null;
  }>(`SELECT id, status, deal_id FROM finance_payments WHERE id = $1 FOR UPDATE`, [paymentId]);
  const payment = rows[0];
  if (!payment) return null;
  // `COLLECTED_STATUSES` is a Set of the typed union, so `.has` on a plain
  // string needs the cast. `isCollected` in @aura/shared does exactly this and
  // is the function to use.
  if (!isCollected(payment.status)) return null;

  const { rows: postings } = await client.query<{ posting_id: string }>(
    `SELECT DISTINCT posting_id FROM ledger_entries
      WHERE org_id = $1 AND ref_type = 'payment' AND ref_id = $2 AND reverses_id IS NULL`,
    [orgId, paymentId],
  );

  for (const posting of postings) {
    try {
      await ledger.reverse(client, { orgId, postingId: posting.posting_id, reason, actor });
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        // The unique index on `reverses_id`. Reported rather than swallowed: a
        // second reversal would double the correction.
        throw new ConflictException("this payment has already been reversed");
      }
      throw err;
    }
  }

  await client.query(
    `UPDATE finance_payments SET status = 'reversed', reversal_reason = $1 WHERE id = $2`,
    [reason, paymentId],
  );

  if (payment.deal_id) {
    await recomputeSchedulePaid(client, orgId, payment.deal_id);
  }

  return { reversedPostings: postings.length, previousStatus: payment.status };
}

/** `COLLECTED_STATUSES` as a SQL-comparable list. One source, two shapes. */
const COLLECTED_SQL_STATUSES = [...COLLECTED_STATUSES];

/**
 * Re-derive every schedule item's `paid_amount` for a deal from the payments
 * that are still collected.
 *
 * ── WHY RE-DERIVED AND NOT DECREMENTED ──────────────────────────────────────
 *
 * A reversal or a refund could subtract what it added. It does not, because
 * subtraction compounds: two reversals of a part-applied payment, in either
 * order, can leave `paid_amount` negative or short depending on which
 * instalment each one guessed it had paid. Recomputing from the surviving
 * payments is the only version that is correct however many corrections have
 * happened and in whatever order.
 */
export async function recomputeSchedulePaid(
  client: PoolClient,
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
        AND fp.status = ANY($2::text[])`,
    [dealId, COLLECTED_SQL_STATUSES],
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

/**
 * Apply a received payment to its schedule and post it to the ledger.
 *
 * Exported because `verify` calls it when a second person confirms an offline
 * payment - the settlement happens then, not at record time.
 */
export async function settlePayment(
  client: PoolClient,
  options: {
    orgId: string;
    paymentId: string;
    dealId: string | null;
    amountMinor: number;
    currency: string;
    receivedOn: string;
    actor: AuditActor;
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
