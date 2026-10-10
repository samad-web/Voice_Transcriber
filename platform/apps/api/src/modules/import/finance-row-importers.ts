import type { PoolClient } from "@aura/db";
import {
  parseAmountCell,
  parseDateCell,
  toMinor,
  toNumericString,
  type DateOrder,
} from "@aura/shared";
import type { AuditActor } from "../../common/audit-actor";
import { actorUserId } from "../../common/audit-actor";
import { recordFinancePayment } from "../finance/record-payment";

/**
 * How a staged spreadsheet row becomes a finance record
 * (Build docs/indian-business-finance-documents-cycles-import §3).
 *
 * ── THE PAYMENT IMPORTER WRITES NOTHING ITSELF ──────────────────────────────
 *
 * It calls `recordFinancePayment`, which is the same function
 * `POST /finance/payments` calls. §3's key design point is explicit about why:
 *
 *   "Imports feed the same pipelines: imported payments go through the same
 *    normalizer and matching engine as connector payments, so reconciliation
 *    and the Advisor behave identically."
 *
 * So an imported payment gets §8's matching, §6.2's offline-money handling,
 * the schedule application, the ledger posting and the period-lock check,
 * because it is literally the same code. The only thing the import sets
 * differently is `source = 'import'`, which is a fact about where the row came
 * from rather than a difference in how it is treated.
 *
 * ── AND EVERY ROW REPORTS WHAT IT DID ───────────────────────────────────────
 *
 * `target_table` and `target_id` come back on the outcome, because §3 step 11's
 * undo needs to know what to undo. An importer that returned only
 * "inserted" would leave the rollback re-deriving rows from the file, and
 * anything edited in between would be destroyed by the re-derivation.
 */

export interface FinanceRowOutcome {
  outcome: "inserted" | "updated" | "skipped" | "failed";
  error?: string;
  targetTable?: string;
  targetId?: string;
}

export interface FinanceRowContext {
  orgId: string;
  actor: AuditActor;
  /** Resolved before staging, never guessed per row. */
  dateOrder: DateOrder;
  currency: string;
}

/**
 * A date cell, or a reason it could not be read.
 *
 * The `ambiguous` and `conflict` orders return a REASON rather than a date,
 * which is the whole safety property of this module: a column where no day is
 * past the 12th cannot be read either way, and reading it anyway moves every
 * payment in the file by up to eleven months.
 */
function readDate(raw: unknown, order: DateOrder, field: string): { date: string } | { error: string } {
  const text = raw == null ? "" : String(raw).trim();
  if (text === "") return { error: `${field} is empty` };
  if (order === "ambiguous" || order === "conflict") {
    return {
      error: `${field} cannot be read until the date format is confirmed (day-first or month-first)`,
    };
  }
  const date = parseDateCell(text, order);
  return date ? { date } : { error: `${field} is not a date this importer recognises: "${text}"` };
}

function readAmount(raw: unknown, currency: string, field: string): { minor: number } | { error: string } {
  const cell = parseAmountCell(raw == null ? null : String(raw), currency);
  if (!cell) return { error: `${field} is not an amount this importer recognises` };
  return { minor: cell.minor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payments
// ─────────────────────────────────────────────────────────────────────────────

/** The methods §6.2 names, plus the gateway ones. Anything else is `other`. */
const METHOD_ALIASES: Record<string, string> = {
  cash: "cash",
  cheque: "cheque",
  check: "cheque",
  dd: "demand_draft",
  demand_draft: "demand_draft",
  "demand draft": "demand_draft",
  upi: "upi",
  neft: "bank_transfer",
  rtgs: "bank_transfer",
  imps: "bank_transfer",
  bank: "bank_transfer",
  bank_transfer: "bank_transfer",
  "bank transfer": "bank_transfer",
  transfer: "bank_transfer",
  card: "card",
  "credit card": "card",
  "debit card": "card",
  gateway: "gateway",
  razorpay: "gateway",
  online: "gateway",
};

function normaliseMethod(raw: unknown): string {
  const text = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (text === "") return "bank_transfer";
  return METHOD_ALIASES[text] ?? METHOD_ALIASES[text.replace(/\s+/g, "_")] ?? "other";
}

export async function importPaymentRow(
  client: PoolClient,
  ctx: FinanceRowContext,
  row: Record<string, string | null>,
): Promise<FinanceRowOutcome> {
  const paidAt = readDate(row.paidAt, ctx.dateOrder, "Payment date");
  if ("error" in paidAt) return { outcome: "failed", error: paidAt.error };

  const amount = readAmount(row.amount, ctx.currency, "Amount");
  if ("error" in amount) return { outcome: "failed", error: amount.error };
  if (amount.minor <= 0) {
    // A refund is a different record with a different ledger shape (§6.3), not
    // a negative payment. Saying so is more useful than accepting it and
    // producing a collection figure that can go down.
    return {
      outcome: "failed",
      error: "A payment must be positive. Record money going out as an expense or a refund.",
    };
  }

  // Resolve the deal by exact name, and the customer by name against both
  // accounts and contacts. A name that matches nothing leaves the payment
  // UNMATCHED rather than failing the row - §8's queue exists for exactly
  // that, and a file of 200 payments should not be refused because three
  // customers are spelled differently.
  let dealId: string | null = null;
  if (row.dealName?.trim()) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM deals
        WHERE org_id = $1 AND lower(name) = lower($2) AND status <> 'merged'
        ORDER BY created_at DESC LIMIT 1`,
      [ctx.orgId, row.dealName.trim()],
    );
    dealId = rows[0]?.id ?? null;
  }

  let accountId: string | null = null;
  let contactId: string | null = null;
  if (!dealId && row.customer?.trim()) {
    const name = row.customer.trim();
    const account = await client.query<{ id: string }>(
      `SELECT id FROM accounts
        WHERE org_id = $1 AND lower(name) = lower($2) AND status <> 'merged' LIMIT 1`,
      [ctx.orgId, name],
    );
    accountId = account.rows[0]?.id ?? null;
    if (!accountId) {
      const contact = await client.query<{ id: string }>(
        `SELECT id FROM contacts
          WHERE org_id = $1 AND lower(display_name) = lower($2) AND status <> 'merged' LIMIT 1`,
        [ctx.orgId, name],
      );
      contactId = contact.rows[0]?.id ?? null;
    }
  }

  const method = normaliseMethod(row.mode);
  const reference = row.reference?.trim() || null;

  const result = await recordFinancePayment(
    client,
    ctx.orgId,
    {
      // The digits as written, not a double: `toMinor`'s string path takes
      // them apart without multiplying, so ₹1,02,500.55 survives exactly.
      amount: toNumericString(amount.minor, ctx.currency),
      currency: ctx.currency,
      method,
      // The reference goes in `method_detail`, which is where §6.2's proof
      // lives for an offline payment - so an imported cheque row satisfies the
      // same proof rule a typed one does.
      methodDetail: reference ? { reference } : {},
      receivedOn: paidAt.date,
      dealId,
      memo: row.notes?.trim() || null,
      source: "csv_import",
      identity: { accountId, contactId },
    },
    ctx.actor,
  );

  return { outcome: "inserted", targetTable: "finance_payments", targetId: result.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Expenses
// ─────────────────────────────────────────────────────────────────────────────

export async function importExpenseRow(
  client: PoolClient,
  ctx: FinanceRowContext,
  row: Record<string, string | null>,
): Promise<FinanceRowOutcome> {
  const spentOn = readDate(row.spentOn, ctx.dateOrder, "Expense date");
  if ("error" in spentOn) return { outcome: "failed", error: spentOn.error };

  const amount = readAmount(row.amount, ctx.currency, "Amount");
  if ("error" in amount) return { outcome: "failed", error: amount.error };
  // A bracketed or Dr-marked figure in an expense column means the same thing
  // as a plain one - money out - so the sign is taken off rather than
  // rejected. A sheet that marks every cost negative is normal.
  const amountMinor = Math.abs(amount.minor);
  if (amountMinor === 0) return { outcome: "failed", error: "Amount is zero" };

  const rawCategory = row.category?.trim();
  if (!rawCategory) return { outcome: "failed", error: "Category is required" };
  // `expenses.category` is a CLOSED CHECK enum (0175), not free text. A
  // spreadsheet's own heading is mapped onto it, and anything unrecognised
  // becomes `other` with the original word kept in the memo - so nothing the
  // person wrote is lost and no row fails for a category name.
  const category = EXPENSE_CATEGORY_ALIASES[rawCategory.toLowerCase()] ?? "other";
  const categoryNote =
    category === "other" && rawCategory.toLowerCase() !== "other" ? `Category: ${rawCategory}` : null;

  let taxMinor: number | null = null;
  if (row.taxAmount?.trim()) {
    const tax = readAmount(row.taxAmount, ctx.currency, "Tax amount");
    if ("error" in tax) return { outcome: "failed", error: tax.error };
    taxMinor = Math.abs(tax.minor);
    if (taxMinor > amountMinor) {
      return { outcome: "failed", error: "The tax is larger than the amount" };
    }
  }

  // ── IMPORTED EXPENSES ARRIVE UNAPPROVED ─────────────────────────────────
  //
  // `approved_at` is left NULL, deliberately, and this is the single most
  // consequential line in this file. §11's cost figures count only approved
  // expenses - the Expenses page and the dashboard disagreed once because one
  // of them forgot that filter - so an import that marked its own rows
  // approved would let anybody with import rights move the margin on the
  // owner's dashboard by uploading a spreadsheet.
  //
  // So they land as pending and somebody approves them, exactly as a typed
  // expense does. The import's result page says how many are waiting.
  const memo = [row.notes?.trim() || null, categoryNote].filter(Boolean).join(" — ") || null;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO expenses
       (org_id, category, vendor, amount, currency, tax, incurred_on,
        bill_number, memo, source, created_by)
     VALUES ($1, $2, $3, $4::numeric, $5, COALESCE($6::numeric, 0), $7::date,
             $8, $9, 'csv_import', $10)
     RETURNING id`,
    [
      ctx.orgId,
      category,
      row.vendor?.trim() || null,
      toNumericString(amountMinor, ctx.currency),
      ctx.currency,
      taxMinor === null ? null : toNumericString(taxMinor, ctx.currency),
      spentOn.date,
      row.billNumber?.trim() || null,
      memo,
      actorUserId(ctx.actor),
    ],
  );

  return { outcome: "inserted", targetTable: "expenses", targetId: rows[0].id };
}

/**
 * Spreadsheet wording -> 0175's thirteen categories.
 *
 * Deliberately generous on the left and closed on the right. Every value here
 * must be one of the CHECK's thirteen, and `expense-categories.spec.ts` pins
 * that: a typo in this map would otherwise fail every row carrying it with a
 * 23514 at commit time, after the person had read a dry run that said it was
 * fine.
 */
const EXPENSE_CATEGORY_ALIASES: Record<string, string> = {
  advertising: "advertising",
  ads: "advertising",
  marketing: "advertising",
  "google ads": "advertising",
  "meta ads": "advertising",
  "facebook ads": "advertising",
  promotion: "advertising",

  "lead purchase": "lead_purchase",
  lead_purchase: "lead_purchase",
  leads: "lead_purchase",

  telephony: "telephony",
  telecom: "telephony",
  phone: "telephony",
  mobile: "telephony",
  internet: "telephony",
  broadband: "telephony",

  messaging: "messaging",
  sms: "messaging",
  whatsapp: "messaging",

  software: "software",
  saas: "software",
  subscription: "software",
  subscriptions: "software",
  it: "software",

  salary: "salary",
  salaries: "salary",
  payroll: "salary",
  wages: "salary",
  staff: "salary",

  incentive: "incentive",
  incentives: "incentive",
  commission: "incentive",
  bonus: "incentive",

  rent: "rent",
  lease: "rent",
  office: "rent",

  utilities: "utilities",
  utility: "utilities",
  electricity: "utilities",
  power: "utilities",
  water: "utilities",

  travel: "travel",
  fuel: "travel",
  petrol: "travel",
  diesel: "travel",
  conveyance: "travel",
  taxi: "travel",
  cab: "travel",

  "professional fees": "professional_fees",
  professional_fees: "professional_fees",
  legal: "professional_fees",
  audit: "professional_fees",
  ca: "professional_fees",
  consultant: "professional_fees",
  consulting: "professional_fees",

  "bank charges": "bank_charges",
  bank_charges: "bank_charges",
  "bank fees": "bank_charges",
  charges: "bank_charges",
  interest: "bank_charges",

  other: "other",
  misc: "other",
  miscellaneous: "other",
  general: "other",
};

/** Exported so a spec can prove every value is one the CHECK admits. */
export const EXPENSE_CATEGORY_TARGETS: readonly string[] = [
  ...new Set(Object.values(EXPENSE_CATEGORY_ALIASES)),
];

// ─────────────────────────────────────────────────────────────────────────────
// Bank statement lines
// ─────────────────────────────────────────────────────────────────────────────

export async function importBankTxnRow(
  client: PoolClient,
  ctx: FinanceRowContext,
  row: Record<string, string | null>,
): Promise<FinanceRowOutcome> {
  const valueDate = readDate(row.valueDate, ctx.dateOrder, "Date");
  if ("error" in valueDate) return { outcome: "failed", error: valueDate.error };

  const narration = row.narration?.trim();
  if (!narration) return { outcome: "failed", error: "Narration is required" };

  // ── THE THREE SHAPES A STATEMENT USES FOR ONE NUMBER ───────────────────
  //
  // Two columns (Deposit / Withdrawal), one signed column, or one column plus
  // a Dr/Cr marker. All three normalise to a signed `amount` here, so the
  // table has one column and the reconciliation has one rule.
  const credit = row.credit?.trim() ? readAmount(row.credit, ctx.currency, "Deposit") : null;
  const debit = row.debit?.trim() ? readAmount(row.debit, ctx.currency, "Withdrawal") : null;
  if (credit && "error" in credit) return { outcome: "failed", error: credit.error };
  if (debit && "error" in debit) return { outcome: "failed", error: debit.error };

  let amountMinor: number;
  if (credit && debit && !("error" in credit) && !("error" in debit)) {
    // Both filled is a mapping mistake often enough to be worth naming: a
    // statement with one signed column mapped to both.
    if (credit.minor !== 0 && debit.minor !== 0) {
      return { outcome: "failed", error: "This row has both a deposit and a withdrawal" };
    }
    amountMinor = credit.minor !== 0 ? Math.abs(credit.minor) : -Math.abs(debit.minor);
  } else if (credit && !("error" in credit)) {
    // A single signed column mapped to Deposit keeps its sign.
    amountMinor = credit.minor;
  } else if (debit && !("error" in debit)) {
    amountMinor = -Math.abs(debit.minor);
  } else {
    return { outcome: "failed", error: "This row has no amount in either column" };
  }
  if (amountMinor === 0) return { outcome: "skipped" };

  const balance = row.balance?.trim() ? parseAmountCell(row.balance, ctx.currency) : null;

  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO bank_transactions
         (org_id, value_date, narration, amount, currency, reference, balance)
       VALUES ($1, $2::date, $3, $4::numeric, $5, $6, $7::numeric)
       RETURNING id`,
      [
        ctx.orgId,
        valueDate.date,
        narration,
        toNumericString(amountMinor, ctx.currency),
        ctx.currency,
        row.reference?.trim() || null,
        balance ? toNumericString(balance.minor, ctx.currency) : null,
      ],
    );
    return { outcome: "inserted", targetTable: "bank_transactions", targetId: rows[0].id };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      // 0182's identity index. Re-uploading an overlapping date range is what
      // people actually do, so this is a skip rather than an error - the row
      // is already there and nothing is wrong.
      return { outcome: "skipped" };
    }
    throw err;
  }
}

/**
 * Match imported statement credits against payments already recorded.
 *
 * ── WHAT IT WILL AND WILL NOT CLAIM ─────────────────────────────────────────
 *
 * Only two rules, both exact:
 *
 *   1. the reference appears in the payment's `method_detail` (a UTR, a cheque
 *      number) and the amount agrees
 *   2. the amount agrees exactly AND the dates are within three days, and
 *      exactly one payment fits
 *
 * No fuzzy narration matching and no "closest amount". §8's matcher is allowed
 * to suggest, because a person works its queue; this runs unattended, and a
 * wrong reconciliation is worse than none - it marks money as accounted for
 * when it is not, which is precisely the condition the whole reconciliation
 * exists to detect. Everything it cannot match with certainty is left for a
 * person, which is the honest output.
 */
export async function reconcileBankTransactions(
  client: PoolClient,
  orgId: string,
  windowDays = 3,
): Promise<{ matched: number }> {
  const { rows } = await client.query<{ matched: string }>(
    // ── THE STATUS LIST AND THE DATE CAST ARE BOTH LOAD-BEARING ───────────
    //
    // `COLLECTED_STATUSES` is the vocabulary - received, cheque_cleared,
    // partially_refunded, disputed. 0173's CHECK has no 'succeeded' at all, so
    // the obvious-looking `IN ('received','succeeded')` matches a status that
    // cannot exist and silently reconciles nothing but plain receipts.
    //
    // `received_at` is `timestamptz` and `value_date` is `date`. Subtracting
    // them gives an INTERVAL, and comparing an interval to an integer is a
    // type error at execution time - inside a function that runs in a worker
    // sweep, where it would surface as a failed tick rather than as a test
    // failure. The `::date` cast makes it integer days.
    `WITH unmatched AS (
       SELECT id, value_date, amount, reference
         FROM bank_transactions
        WHERE org_id = $1
          AND matched_payment_id IS NULL
          AND ignored_at IS NULL
          AND amount > 0
     ),
     fits AS (
       SELECT u.id AS txn_id, p.id AS payment_id,
              abs(p.received_at::date - u.value_date) AS day_gap,
              count(*) OVER (PARTITION BY u.id) AS candidates
         FROM unmatched u
         JOIN finance_payments p
           ON p.org_id = $1
          AND p.status IN ('received', 'cheque_cleared', 'partially_refunded', 'disputed')
          AND p.amount = u.amount
          AND NOT EXISTS (SELECT 1 FROM bank_transactions b
                           WHERE b.matched_payment_id = p.id)
          AND (
            (u.reference IS NOT NULL AND u.reference <> ''
              AND p.method_detail::text ILIKE '%' || u.reference || '%')
            OR abs(p.received_at::date - u.value_date) <= $2
          )
     ),
     applied AS (
       UPDATE bank_transactions b
          SET matched_payment_id = f.payment_id, matched_at = now()
         FROM fits f
        -- candidates = 1 is the refusal to guess: a credit that two recorded
        -- payments could equally explain is left for a person. Marking money
        -- as accounted for when it is not is the exact condition this
        -- reconciliation exists to detect.
        WHERE b.id = f.txn_id AND f.candidates = 1
        RETURNING b.id
     )
     SELECT count(*)::text AS matched FROM applied`,
    [orgId, windowDays],
  );
  return { matched: Number(rows[0]?.matched ?? 0) };
}

/** Minor units from a `numeric` string, for a caller that has one. */
export const minorOf = (numeric: string | null, currency = "INR"): number =>
  numeric === null ? 0 : toMinor(numeric, currency);
