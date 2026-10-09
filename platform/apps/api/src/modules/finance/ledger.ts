import { randomUUID } from "node:crypto";
import { InternalServerErrorException } from "@nestjs/common";
import type { PoolClient } from "@aura/db";
import {
  type LedgerAccount,
  type LedgerLine,
  type LedgerRefType,
  balances,
  toNumericString,
} from "@aura/shared";
import type { AuditActor } from "../../common/audit-actor";

/**
 * The ledger writer (Build docs/finance-section-build-plan §6.3, §9, §16).
 *
 * ── EVERY MONEY EVENT IN THIS MODULE GOES THROUGH `post()` ──────────────────
 *
 * Not because a helper is tidier than an INSERT, but because of what it
 * refuses: an unbalanced posting. §16 asks for "ledger debits equal credits"
 * as a property-style invariant, and the only way to have that invariant
 * actually hold is for there to be exactly one place rows can be created and
 * for it to check. A controller that wrote `ledger_entries` directly could
 * post a receipt with no matching credit, and nothing downstream would notice
 * until an owner asked why the dashboard did not reconcile.
 *
 * `postingId` groups the rows of one event, which is what makes the invariant
 * checkable at all - a single row can never balance.
 *
 * ── AND WHY THERE IS NO `update()` OR `remove()` ────────────────────────────
 *
 * §6.3 is a MUST: "never edit or delete a posted payment or ledger row.
 * Correct by reversal entry plus a new entry." So the only other export is
 * `reverse()`, and `aura_app` holds SELECT and INSERT on the table and nothing
 * else - Postgres refuses the UPDATE that this file declines to offer.
 */

export interface PostOptions {
  orgId: string;
  refType: LedgerRefType;
  refId: string | null;
  lines: readonly LedgerLine[];
  /** Defaults to now(). Set it for a payment received on a past date. */
  postedAt?: Date | string;
  currency?: string;
  memo?: string;
  actor: AuditActor;
}

const INSERT_SQL = `INSERT INTO ledger_entries
    (org_id, posting_id, account, debit, credit, currency,
     ref_type, ref_id, posted_at, memo, actor_type, actor_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10, $11, $12)
  RETURNING id`;

/**
 * Post one balanced event. Returns the `posting_id` so a caller can reference
 * the posting it just made.
 *
 * ── THE BALANCE CHECK IS A 500, DELIBERATELY ────────────────────────────────
 *
 * An unbalanced posting is never the CALLER's fault in the HTTP sense - no
 * request body can produce one, because the lines are built by this module's
 * own code from amounts it has already validated. It is a programming error,
 * so it raises rather than returning a 400: a 400 would be telling a user to
 * fix something they did not do, and a silent skip would be a ledger that
 * stops reconciling with no trace of when it started.
 */
export async function post(client: PoolClient, options: PostOptions): Promise<string> {
  const lines = options.lines.filter((l) => l.debitMinor !== 0 || l.creditMinor !== 0);
  if (lines.length === 0) {
    // Nothing to post is not an error: a zero-amount payment (a fully
    // discounted deal, a ₹0 adjustment) is legal and simply has no ledger
    // consequence. Returning a posting id for it would create a posting with
    // no rows, which the invariant query would then report as unbalanced.
    return randomUUID();
  }
  if (!balances(lines)) {
    throw new InternalServerErrorException(
      `unbalanced ledger posting for ${options.refType}: ` +
        `debits ${lines.reduce((s, l) => s + l.debitMinor, 0)} ` +
        `credits ${lines.reduce((s, l) => s + l.creditMinor, 0)}`,
    );
  }

  const postingId = randomUUID();
  const currency = options.currency ?? "INR";
  const postedAt =
    options.postedAt instanceof Date ? options.postedAt.toISOString() : (options.postedAt ?? null);

  for (const line of lines) {
    await client.query(INSERT_SQL, [
      options.orgId,
      postingId,
      line.account,
      // `toNumericString`, never a bare number: binding a double here would
      // put a float back into the one path that exists to keep them out.
      toNumericString(line.debitMinor, currency),
      toNumericString(line.creditMinor, currency),
      currency,
      options.refType,
      options.refId,
      postedAt,
      options.memo ?? null,
      options.actor.type,
      options.actor.id,
    ]);
  }
  return postingId;
}

/**
 * §6.3's correction: mirror an existing posting, every line flipped.
 *
 * ── WHY IT REVERSES A POSTING AND NOT AN ENTRY ──────────────────────────────
 *
 * Reversing one ROW of a two-row posting leaves the ledger unbalanced - which
 * is the exact failure the `reverses_id` column looks like it is there to
 * prevent and does not. So the unit of reversal is the posting, and the unique
 * index on `reverses_id` is what stops the same row being reversed twice:
 * the second attempt violates it rather than quietly doubling the correction.
 *
 * The reason is mandatory. A reversal with no reason is indistinguishable from
 * a mistake six months later, and §6.3 requires corrections to be audit-logged
 * with one.
 */
export async function reverse(
  client: PoolClient,
  options: {
    orgId: string;
    postingId: string;
    reason: string;
    actor: AuditActor;
    postedAt?: Date | string;
  },
): Promise<string> {
  const { rows } = await client.query<{
    id: string;
    account: LedgerAccount;
    debit: string;
    credit: string;
    currency: string;
    ref_type: LedgerRefType;
    ref_id: string | null;
  }>(
    `SELECT id, account, debit, credit, currency, ref_type, ref_id
       FROM ledger_entries
      WHERE org_id = $1 AND posting_id = $2
      ORDER BY id`,
    [options.orgId, options.postingId],
  );
  if (rows.length === 0) {
    throw new InternalServerErrorException(`no ledger posting ${options.postingId} to reverse`);
  }

  const postingId = randomUUID();
  const postedAt =
    options.postedAt instanceof Date ? options.postedAt.toISOString() : (options.postedAt ?? null);

  for (const row of rows) {
    await client.query(
      `INSERT INTO ledger_entries
         (org_id, posting_id, account, debit, credit, currency,
          ref_type, ref_id, posted_at, reverses_id, memo, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10, $11, $12, $13)`,
      [
        options.orgId,
        postingId,
        row.account,
        // Flipped: what was a debit becomes a credit of the same size. Taken
        // from the stored strings rather than re-derived, so a reversal is the
        // exact mirror of what was posted even if the amount that produced it
        // has since been corrected elsewhere.
        row.credit,
        row.debit,
        row.currency,
        row.ref_type,
        row.ref_id,
        postedAt,
        row.id,
        `Reversal: ${options.reason}`,
        options.actor.type,
        options.actor.id,
      ],
    );
  }
  return postingId;
}

/**
 * §16's invariant, as a query: every posting in the org balances.
 *
 * Returns the offending postings, so a test can name them and the operator
 * console can show them. Empty means the ledger is sound.
 *
 * Exported and used by a test rather than called on every request: it is a
 * full scan of the org's ledger, which is the right thing to run nightly and
 * the wrong thing to run on a dashboard load.
 */
export async function unbalancedPostings(
  client: PoolClient,
  orgId: string,
): Promise<{ postingId: string; debit: string; credit: string }[]> {
  const { rows } = await client.query<{ posting_id: string; debit: string; credit: string }>(
    `SELECT posting_id, sum(debit)::text AS debit, sum(credit)::text AS credit
       FROM ledger_entries
      WHERE org_id = $1
      GROUP BY posting_id
     HAVING sum(debit) <> sum(credit)`,
    [orgId],
  );
  return rows.map((r) => ({ postingId: r.posting_id, debit: r.debit, credit: r.credit }));
}

// ─────────────────────────────────────────────────────────────────────────────
// The postings this module produces
// ─────────────────────────────────────────────────────────────────────────────
//
// Each is a named function rather than a `lines` array built at the call site,
// for one reason: the direction of a double entry is the easiest thing in this
// module to get backwards, and backwards means a dashboard that reports the
// opposite of the truth. Named here, each direction is written once and
// asserted once.

/**
 * A deal closes: revenue is earned and a receivable is created.
 *
 * Posted when the SCHEDULE is generated rather than when the deal's status
 * moves to 'won', because the receivable is the schedule - without rows to
 * owe against, "outstanding" has nothing to sum.
 */
export function dealBookedLines(amountMinor: number): LedgerLine[] {
  return [
    { account: "receivable", debitMinor: amountMinor, creditMinor: 0 },
    { account: "revenue", debitMinor: 0, creditMinor: amountMinor },
  ];
}

/**
 * Money arrives: cash up, receivable down, and the gateway's cut split out.
 *
 * ── WHY THE FEE IS A THIRD LINE AND NOT NETTED OFF ──────────────────────────
 *
 * The customer paid the gross. Posting only the net would make "collected"
 * smaller than what the customer was charged, so the collection rate would
 * never reach 100% for any org using a gateway - and "gateway fee %" would
 * have no numerator at all. §11 wants both numbers, and they only exist if
 * the fee is posted as its own expense.
 */
export function paymentReceivedLines(options: {
  grossMinor: number;
  feeMinor: number;
  taxOnFeeMinor: number;
  /** Anything beyond what the schedule owed. §15: a credit on the deal. */
  creditMinor: number;
}): LedgerLine[] {
  const { grossMinor, feeMinor, taxOnFeeMinor, creditMinor } = options;
  const appliedToReceivable = grossMinor - creditMinor;
  const netCash = grossMinor - feeMinor - taxOnFeeMinor;

  const lines: LedgerLine[] = [{ account: "cash", debitMinor: netCash, creditMinor: 0 }];
  if (feeMinor + taxOnFeeMinor > 0) {
    lines.push({ account: "gateway_fees", debitMinor: feeMinor + taxOnFeeMinor, creditMinor: 0 });
  }
  if (appliedToReceivable > 0) {
    lines.push({ account: "receivable", debitMinor: 0, creditMinor: appliedToReceivable });
  }
  if (creditMinor > 0) {
    // Money the business holds and owes back - a liability, credited. Not
    // revenue: nobody has earned it, and booking it as revenue is how an
    // overpayment inflates a month's margin.
    lines.push({ account: "customer_credit", debitMinor: 0, creditMinor: creditMinor });
  }
  return lines;
}

/** A refund: cash out, and the receivable comes back. */
export function refundLines(amountMinor: number): LedgerLine[] {
  return [
    { account: "receivable", debitMinor: amountMinor, creditMinor: 0 },
    { account: "cash", debitMinor: 0, creditMinor: amountMinor },
  ];
}

/** An expense: cost recognised, cash out. */
export function expenseLines(amountMinor: number): LedgerLine[] {
  return [
    { account: "expense", debitMinor: amountMinor, creditMinor: 0 },
    { account: "cash", debitMinor: 0, creditMinor: amountMinor },
  ];
}

/**
 * A settlement: the gateway moves the net to the bank.
 *
 * Deliberately NOT posted today, and worth saying why rather than leaving a
 * reader to wonder. `paymentReceivedLines` already debits `cash` with the net
 * at capture time, so posting the settlement as well would count the same
 * money twice. The settlement's job in this module is reconciliation - does
 * `net` equal `bank_credit` (§7.2.7) - not a second cash movement. A tenant
 * that wants bank-level cash timing needs a `bank` account distinct from
 * `cash`, which is the eighth account `LedgerAccount`'s header says is a
 * reviewed decision rather than an addition.
 */
export const SETTLEMENT_POSTS_NOTHING = true;
