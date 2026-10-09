import type { PoolClient } from "@aura/db";
import {
  MATCH_CONFIDENCE,
  type MatchRule,
  type MatchStatus,
  applyToSchedule,
  matchStatusFor,
  toMinor,
  toNumericString,
} from "@aura/shared";

/**
 * §8's matching engine: which deal, and which instalment, is this money for?
 *
 * ── THE FOUR RULES, IN ORDER, STOPPING AT THE FIRST CONFIDENT ONE ───────────
 *
 *   1. exact reference   a deal/schedule id in the gateway's notes, or a
 *                        payment-link id we issued           -> 1.0
 *   2. identity + amount phone or email, plus the exact amount
 *                        against an open schedule item        -> 0.9
 *   3. fuzzy             amount and a date window, with exactly
 *                        ONE candidate                        -> 0.6
 *   4. otherwise         the unmatched queue
 *
 * ── WHY RULE 3 REFUSES ON TWO CANDIDATES ────────────────────────────────────
 *
 * §8 says "multiple candidates -> no auto-match", and this is the rule that
 * earns the whole engine its trust. Two customers owing ₹25,000 in the same
 * week is not unusual - it is what a price list produces - and guessing between
 * them puts money against the wrong customer, who then gets chased for it while
 * the one who actually paid is marked current. A row in a queue costs somebody
 * thirty seconds; a wrong match costs a relationship and is not self-correcting.
 *
 * The same refusal is why this module never invents a customer: a payment with
 * no identifiable payer stays unmatched rather than being attached to the
 * nearest account by name similarity.
 */

export interface MatchCandidate {
  scheduleItemId: string;
  dealId: string;
  dueDate: string;
  amountMinor: number;
  paidMinor: number;
  accountId: string | null;
  contactId: string | null;
  dealName: string;
  customerName: string | null;
}

export interface MatchVerdict {
  status: MatchStatus;
  confidence: number | null;
  rule: MatchRule | null;
  /** The chosen item, when one rule produced a single confident answer. */
  chosen: MatchCandidate | null;
  /** Everything considered, for the queue's "suggest candidates" list. */
  candidates: MatchCandidate[];
  /** Why it did not match, in words the queue can show. */
  reason: string | null;
}

export interface MatchInput {
  orgId: string;
  amountMinor: number;
  receivedAt: Date;
  /** From the connector's notes/reference fields, or typed in by a person. */
  reference?: {
    dealId?: string | null;
    scheduleItemId?: string | null;
    /** A 0060 payment-link id, which resolves through its invoice. */
    paymentLinkId?: string | null;
  };
  /** From the gateway's payer block, or the bank narration. */
  identity?: {
    phone?: string | null;
    email?: string | null;
    accountId?: string | null;
    contactId?: string | null;
  };
  /** §8's auto-apply threshold, from finance_settings. */
  threshold: number;
  /** How wide rule 3's date window is. Days either side of the due date. */
  fuzzyWindowDays?: number;
}

const CANDIDATE_SELECT = `
  SELECT ps.id   AS schedule_item_id,
         ps.deal_id,
         to_char(ps.due_date, 'YYYY-MM-DD') AS due_date,
         ps.amount::text      AS amount,
         ps.paid_amount::text AS paid_amount,
         d.account_id,
         d.contact_id,
         d.name AS deal_name,
         COALESCE(a.name, c.first_name || ' ' || COALESCE(c.last_name, '')) AS customer_name
    FROM payment_schedules ps
    JOIN deals d ON d.id = ps.deal_id
    LEFT JOIN accounts a ON a.id = d.account_id
    LEFT JOIN contacts c ON c.id = d.contact_id`;

interface CandidateRow {
  schedule_item_id: string;
  deal_id: string;
  due_date: string;
  amount: string;
  paid_amount: string;
  account_id: string | null;
  contact_id: string | null;
  deal_name: string;
  customer_name: string | null;
}

function toCandidate(row: CandidateRow): MatchCandidate {
  return {
    scheduleItemId: row.schedule_item_id,
    dealId: row.deal_id,
    dueDate: row.due_date,
    amountMinor: toMinor(row.amount),
    paidMinor: toMinor(row.paid_amount),
    accountId: row.account_id,
    contactId: row.contact_id,
    dealName: row.deal_name,
    customerName: row.customer_name?.trim() || null,
  };
}

/**
 * Run the rules. Reads only - it never writes a match, because applying one is
 * a different decision (and in the suggested case, a person's).
 */
export async function match(client: PoolClient, input: MatchInput): Promise<MatchVerdict> {
  const windowDays = input.fuzzyWindowDays ?? 15;

  // ── Rule 1: an exact reference ────────────────────────────────────────────
  //
  // Checked first and trusted completely: this id was put on the payment by
  // THIS system when the link was created, so there is nothing to infer.
  const reference = input.reference ?? {};
  if (reference.scheduleItemId) {
    const { rows } = await client.query<CandidateRow>(
      `${CANDIDATE_SELECT} WHERE ps.id = $1 AND ps.org_id = $2`,
      [reference.scheduleItemId, input.orgId],
    );
    if (rows[0]) return confident(toCandidate(rows[0]), "exact_reference", input.threshold);
  }

  if (reference.dealId) {
    // A deal reference names the deal, not the instalment - so §15's
    // oldest-open-first rule picks which item within it. `applyToSchedule` is
    // the same function the application path uses, so the item suggested here
    // is the item that will actually be paid.
    const { rows } = await client.query<CandidateRow>(
      `${CANDIDATE_SELECT}
        WHERE ps.deal_id = $1 AND ps.org_id = $2 AND ps.status <> 'cancelled'
        ORDER BY ps.due_date, ps.id`,
      [reference.dealId, input.orgId],
    );
    const candidates = rows.map(toCandidate);
    const [first] = applyToSchedule(
      candidates.map((c) => ({
        id: c.scheduleItemId,
        dueDate: c.dueDate,
        amountMinor: c.amountMinor,
        paidMinor: c.paidMinor,
      })),
      input.amountMinor,
    ).applications;
    const chosen = candidates.find((c) => c.scheduleItemId === first?.id);
    if (chosen) return confident(chosen, "exact_reference", input.threshold);
    // A deal whose schedule is fully paid: the reference is still right, the
    // money is still an overpayment on THAT deal, so it matches the deal with
    // no item rather than falling through to a guess about another customer.
    if (candidates.length > 0) {
      return {
        status: matchStatusFor(MATCH_CONFIDENCE.exact_reference, input.threshold),
        confidence: MATCH_CONFIDENCE.exact_reference,
        rule: "exact_reference",
        chosen: { ...candidates[0], scheduleItemId: "" },
        candidates,
        reason: "Every instalment on this deal is already paid - this will become a credit.",
      };
    }
  }

  if (reference.paymentLinkId) {
    // 0060's payment links point at an INVOICE, and an invoice may bill a
    // schedule item (0172 added the column). This is the bridge between the
    // existing gateway path and the canonical record.
    const { rows } = await client.query<CandidateRow>(
      `${CANDIDATE_SELECT}
         JOIN invoices i ON i.id = ps.invoice_id
         JOIN payments p ON p.invoice_id = i.id
        WHERE p.razorpay_payment_link_id = $1 AND ps.org_id = $2
        LIMIT 1`,
      [reference.paymentLinkId, input.orgId],
    );
    if (rows[0]) return confident(toCandidate(rows[0]), "exact_reference", input.threshold);
  }

  // ── Rule 2: a known customer plus the exact amount ────────────────────────
  //
  // `ps.amount - ps.paid_amount = $amount` and not `ps.amount = $amount`: a
  // customer paying off the remainder of a part-paid instalment is paying an
  // exact amount, and comparing against the gross would miss every one of them.
  const identity = input.identity ?? {};
  const identityParams: unknown[] = [input.orgId, toNumericString(input.amountMinor)];
  const identityClauses: string[] = [];

  if (identity.accountId) {
    identityParams.push(identity.accountId);
    identityClauses.push(`d.account_id = $${identityParams.length}`);
  }
  if (identity.contactId) {
    identityParams.push(identity.contactId);
    identityClauses.push(`d.contact_id = $${identityParams.length}`);
  }
  if (identity.phone) {
    identityParams.push(identity.phone);
    // Matched through `contact_numbers` (0157's vault), which is where every
    // number a contact has actually lives - `contacts.phone` holds one, and a
    // customer paying from their second number would never match on it.
    identityClauses.push(
      `EXISTS (SELECT 1 FROM contact_numbers cn
                WHERE cn.contact_id = d.contact_id AND cn.e164 = $${identityParams.length})`,
    );
  }
  if (identity.email) {
    identityParams.push(identity.email.toLowerCase());
    identityClauses.push(`lower(c.email) = $${identityParams.length}`);
  }

  if (identityClauses.length > 0) {
    const { rows } = await client.query<CandidateRow>(
      `${CANDIDATE_SELECT}
        WHERE ps.org_id = $1
          AND ps.status <> 'cancelled'
          AND ps.amount - ps.paid_amount = $2::numeric
          AND (${identityClauses.join(" OR ")})
        ORDER BY ps.due_date, ps.id
        LIMIT 10`,
      identityParams,
    );
    const candidates = rows.map(toCandidate);
    if (candidates.length === 1) {
      return confident(candidates[0], "identity_amount", input.threshold);
    }
    if (candidates.length > 1) {
      // Same customer, two identical open instalments - an EMI plan, which is
      // the common case. Oldest first is not a guess here: §15's rule says the
      // money pays the oldest, and both items belong to the same person, so
      // the worst case is applying it to the right customer's wrong month.
      return confident(candidates[0], "identity_amount", input.threshold, candidates);
    }
  }

  // ── Rule 3: amount and a date window, ONE candidate only ──────────────────
  const { rows: fuzzy } = await client.query<CandidateRow>(
    `${CANDIDATE_SELECT}
      WHERE ps.org_id = $1
        AND ps.status <> 'cancelled'
        AND ps.amount - ps.paid_amount = $2::numeric
        AND ps.due_date BETWEEN ($3::timestamptz::date - $4::int)
                            AND ($3::timestamptz::date + $4::int)
      ORDER BY ps.due_date, ps.id
      LIMIT 10`,
    [input.orgId, toNumericString(input.amountMinor), input.receivedAt.toISOString(), windowDays],
  );
  const fuzzyCandidates = fuzzy.map(toCandidate);

  if (fuzzyCandidates.length === 1) {
    return confident(fuzzyCandidates[0], "fuzzy_single", input.threshold);
  }

  // ── Rule 4: the queue ─────────────────────────────────────────────────────
  return {
    status: "unmatched",
    confidence: null,
    rule: null,
    chosen: null,
    candidates: fuzzyCandidates,
    reason:
      fuzzyCandidates.length > 1
        ? `${fuzzyCandidates.length} customers owe exactly this amount - pick one.`
        : "No open instalment matches this amount, customer or reference.",
  };
}

function confident(
  chosen: MatchCandidate,
  rule: MatchRule,
  threshold: number,
  candidates: MatchCandidate[] = [chosen],
): MatchVerdict {
  const confidence = MATCH_CONFIDENCE[rule];
  return {
    status: matchStatusFor(confidence, threshold),
    confidence,
    rule,
    chosen,
    candidates,
    reason: null,
  };
}

/**
 * Apply a receipt to a deal's schedule and return what it did.
 *
 * ── THE LOCK IS A STATEMENT OF ITS OWN, OUTSIDE ANY CTE ─────────────────────
 *
 * `FOR UPDATE` on the schedule rows before deciding anything, and not inside a
 * CTE - the same rule `resources.controller.ts` records for its capacity
 * check, and for a sharper reason here. Two payments arriving for one deal at
 * the same moment (a customer clicking a link twice, a webhook and its
 * reconciliation catch-up) would both read `paid_amount = 0` from their own
 * snapshot, both apply in full, and the instalment would end up paid twice
 * while the second instalment stayed open. A lazy CTE does not take the lock
 * before the read that matters; a separate statement does.
 *
 * This is the lesson 0139 recorded about double credits, in the one place in
 * the new module where it could happen again.
 */
export async function applyReceipt(
  client: PoolClient,
  options: { orgId: string; dealId: string; amountMinor: number; currency: string },
): Promise<{ applications: { id: string; appliedMinor: number }[]; creditMinor: number }> {
  const { rows } = await client.query<{
    id: string;
    due_date: string;
    amount: string;
    paid_amount: string;
  }>(
    `SELECT id, to_char(due_date, 'YYYY-MM-DD') AS due_date, amount::text, paid_amount::text
       FROM payment_schedules
      WHERE deal_id = $1 AND org_id = $2 AND status <> 'cancelled'
      ORDER BY due_date, id
        FOR UPDATE`,
    [options.dealId, options.orgId],
  );

  const items = rows.map((r) => ({
    id: r.id,
    dueDate: r.due_date,
    amountMinor: toMinor(r.amount),
    paidMinor: toMinor(r.paid_amount),
  }));

  const result = applyToSchedule(items, options.amountMinor);

  for (const application of result.applications) {
    const item = items.find((i) => i.id === application.id);
    if (!item) continue;
    const paid = item.paidMinor + application.appliedMinor;
    await client.query(
      `UPDATE payment_schedules
          SET paid_amount = $1::numeric,
              status = $2,
              -- A promise is DISCHARGED by payment. Leaving it set would keep
              -- the slipped_promise rule firing on an instalment already paid.
              promised_on = CASE WHEN $2 = 'paid' THEN NULL ELSE promised_on END
        WHERE id = $3 AND org_id = $4`,
      [
        toNumericString(paid, options.currency),
        paid >= item.amountMinor ? "paid" : "partial",
        application.id,
        options.orgId,
      ],
    );
  }

  if (result.creditMinor > 0) {
    // §15: the remainder becomes a credit balance on the deal. `+ $1` rather
        // than a computed total, so two concurrent overpayments both land.
    await client.query(
      `UPDATE deals SET credit_balance = credit_balance + $1::numeric WHERE id = $2 AND org_id = $3`,
      [toNumericString(result.creditMinor, options.currency), options.dealId, options.orgId],
    );
  }

  return result;
}
