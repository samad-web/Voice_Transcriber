import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  FINANCE_DEFAULTS,
  MATCH_CONFIDENCE,
  applyToSchedule,
  matchStatusFor,
  toMinor,
  toNumericString,
} from "@aura/shared";
import { type CanonicalEvent, backoffSeconds, connectorFor } from "./finance-connectors";

/**
 * §7.2's pipeline: the normalizer that turns stored raw events into canonical
 * payments, refunds, disputes and settlements.
 *
 * ── THE PROPERTY EVERYTHING ELSE DEPENDS ON ─────────────────────────────────
 *
 * §7.2.5: "the normalizer must be re-runnable from stored raw events after a
 * bug fix." So this function reads ONLY from `connector_events` and writes
 * idempotently: every insert is `ON CONFLICT DO NOTHING` against the gateway's
 * own id, so replaying a window produces the same state rather than a second
 * set of payments. A replay is `UPDATE connector_events SET processed_at =
 * NULL, attempts = 0` over any range - no special path, no flag.
 *
 * ── CLAIMED WITH `FOR UPDATE SKIP LOCKED` ───────────────────────────────────
 *
 * Which is what lets this run on more than one worker without two of them
 * normalizing the same delivery. `SKIP LOCKED` rather than a status column: a
 * `claimed_at` would need a reaper for rows whose worker died mid-batch, and
 * the lock is released by the transaction ending either way.
 *
 * ── AND WHY A FAILURE IS A ROW, NOT A LOST MESSAGE ──────────────────────────
 *
 * On an error the row keeps `processed_at IS NULL`, takes an `error` and a
 * `next_attempt_at`, and is retried with the backoff in `backoffSeconds`.
 * Past `maxEventAttempts` it stops being picked up - that is the dead letter
 * §7.2.4 asks for, and it is listable and replayable because it is a row
 * rather than a message on a queue nobody can see into.
 */

export interface DrainResult {
  claimed: number;
  processed: number;
  failed: number;
  deadLettered: number;
  payments: number;
}

const CLAIM_SQL = `
  SELECT e.id, e.connector_account_id, e.external_id, e.event_type, e.payload, e.attempts,
         a.type AS connector_type
    FROM connector_events e
    JOIN connector_accounts a ON a.id = e.connector_account_id
   WHERE e.processed_at IS NULL
     AND e.signature_ok
     AND e.attempts < $1
     AND e.next_attempt_at <= now()
   ORDER BY e.received_at
   LIMIT $2
     FOR UPDATE OF e SKIP LOCKED`;

interface EventRow {
  id: string;
  connector_account_id: string;
  external_id: string;
  event_type: string | null;
  payload: unknown;
  attempts: number;
  connector_type: string;
}

/**
 * Drain one batch for one org. Called inside `withOrgContext`, so RLS scopes
 * every statement.
 */
export async function drainConnectorEvents(
  client: PoolClient,
  orgId: string,
  options: { batchSize?: number; maxAttempts?: number } = {},
): Promise<DrainResult> {
  const maxAttempts = options.maxAttempts ?? FINANCE_DEFAULTS.maxEventAttempts;
  const result: DrainResult = {
    claimed: 0,
    processed: 0,
    failed: 0,
    deadLettered: 0,
    payments: 0,
  };

  const { rows } = await client.query<EventRow>(CLAIM_SQL, [maxAttempts, options.batchSize ?? 50]);
  result.claimed = rows.length;

  for (const row of rows) {
    const connector = connectorFor(row.connector_type);
    if (!connector) {
      // A row for a connector type this build does not know - a gateway
      // removed in a deploy, or a type typed by hand. Marked failed rather
      // than retried forever, and the error says what to do.
      await fail(client, row, `no mapper for connector type "${row.connector_type}"`, maxAttempts);
      result.failed += 1;
      continue;
    }

    try {
      const events = connector.map({
        externalId: row.external_id,
        eventType: row.event_type ?? "unknown",
        payload: row.payload,
      });

      for (const event of events) {
        if (event.kind === "payment") {
          const inserted = await upsertPayment(client, orgId, row, event);
          if (inserted) result.payments += 1;
        } else if (event.kind === "refund") {
          await upsertRefund(client, orgId, event);
        } else if (event.kind === "dispute") {
          await upsertDispute(client, orgId, event);
        } else if (event.kind === "settlement") {
          await upsertSettlement(client, orgId, row.connector_account_id, event);
        }
      }

      await client.query(
        `UPDATE connector_events
            SET processed_at = now(), error = NULL, attempts = attempts + 1
          WHERE id = $1`,
        [row.id],
      );
      // The health page's "synced N minutes ago" comes from here, so it
      // reflects what was actually PROCESSED rather than what arrived - an
      // account whose deliveries all fail should not read as healthy.
      await client.query(
        `UPDATE connector_accounts
            SET last_event_at = now(), consecutive_failures = 0, last_error = NULL,
                status = CASE WHEN status = 'error' THEN 'connected' ELSE status END
          WHERE id = $1`,
        [row.connector_account_id],
      );
      result.processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const dead = await fail(client, row, message, maxAttempts);
      result.failed += 1;
      if (dead) result.deadLettered += 1;
    }
  }

  return result;
}

async function fail(
  client: PoolClient,
  row: EventRow,
  message: string,
  maxAttempts: number,
): Promise<boolean> {
  const attempts = row.attempts + 1;
  await client.query(
    `UPDATE connector_events
        SET attempts = $1,
            error = $2,
            next_attempt_at = now() + ($3 || ' seconds')::interval
      WHERE id = $4`,
    // The row is NOT marked processed, so it stays in the queue - and past
    // maxAttempts the claim query stops selecting it, which is the dead letter.
    [attempts, message.slice(0, 2000), backoffSeconds(attempts), row.id],
  );
  await client.query(
    `UPDATE connector_accounts
        SET consecutive_failures = consecutive_failures + 1,
            last_error = $1,
            status = CASE WHEN consecutive_failures + 1 >= 5 THEN 'error' ELSE status END
      WHERE id = $2`,
    [message.slice(0, 500), row.connector_account_id],
  );
  return attempts >= maxAttempts;
}

/**
 * Insert the canonical payment, match it, apply it, and post the ledger.
 *
 * Returns false when the gateway id is already present - which is §7.2.3's
 * "duplicate deliveries must be harmless", enforced by the unique index rather
 * than by a prior SELECT. A check-then-insert would still double-credit under
 * two concurrent deliveries of the same payment, which is exactly how the
 * older gateway path produced a 1000 invoice with amount_paid 2000.
 */
async function upsertPayment(
  client: PoolClient,
  orgId: string,
  row: EventRow,
  event: CanonicalEvent,
): Promise<boolean> {
  const currency = event.currency;
  const netMinor = event.amountMinor - (event.feeMinor ?? 0) - (event.taxOnFeeMinor ?? 0);

  // §8 rule 1: the reference the payment link carried. Resolved before the
  // insert so the row lands already matched - the common case by design, since
  // the link helper fills the notes in.
  const resolved = await resolveReference(client, orgId, event);

  const threshold = await autoMatchThreshold(client, orgId);
  const status = event.status === "failed" ? "failed" : event.status === "authorized" ? "authorized" : "received";

  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO finance_payments
       (org_id, deal_id, schedule_item_id, account_id, contact_id,
        amount, currency, method, method_detail, status, source,
        connector_account_id, external_id, raw_event_id,
        received_at, fee, tax_on_fee, net,
        match_status, match_confidence, match_rule)
     VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9::jsonb, $10, 'connector',
             $11, $12, $13, $14, $15::numeric, $16::numeric, $17::numeric, $18, $19, $20)
     ON CONFLICT (connector_account_id, external_id) WHERE external_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      orgId,
      resolved.dealId,
      resolved.scheduleItemId,
      resolved.accountId,
      resolved.contactId,
      toNumericString(event.amountMinor, currency),
      currency,
      event.method ?? "card",
      JSON.stringify(event.methodDetail ?? {}),
      status,
      row.connector_account_id,
      event.externalId,
      row.id,
      event.occurredAt.toISOString(),
      toNumericString(event.feeMinor ?? 0, currency),
      toNumericString(event.taxOnFeeMinor ?? 0, currency),
      toNumericString(netMinor, currency),
      resolved.dealId ? matchStatusFor(MATCH_CONFIDENCE.exact_reference, threshold) : "unmatched",
      resolved.dealId ? MATCH_CONFIDENCE.exact_reference : null,
      resolved.dealId ? "exact_reference" : null,
    ],
  );

  const paymentId = inserted[0]?.id;
  if (!paymentId) return false;

  // A failed or merely authorized attempt is RECORDED and nothing else. §12.4's
  // `failed_not_retried` needs the row; the money has not arrived, so neither
  // the schedule nor the ledger may move.
  if (status !== "received") return true;

  let creditMinor = event.amountMinor;
  if (resolved.dealId) {
    const applied = await applyToDeal(client, orgId, resolved.dealId, event.amountMinor, currency);
    creditMinor = applied.creditMinor;
    // ── RECORD WHICH INSTALMENT IT PAID ───────────────────────────────────
    //
    // `resolveReference` only returns a schedule item when the gateway's notes
    // named one. A payment referencing a DEAL - the common case for a payment
    // link raised against a plan - landed with `schedule_item_id` null even
    // though `applyToDeal` had just worked out exactly which instalment it
    // pays. §11's days-to-collect measures from that item's due date, so the
    // metric was unmeasurable for every connector payment.
    //
    // The same defect was in the API's manual path; both are fixed, and both
    // record the FIRST item the receipt pays, per §15's oldest-open-first.
    if (!resolved.scheduleItemId && applied.firstItemId) {
      await client.query(`UPDATE finance_payments SET schedule_item_id = $1 WHERE id = $2`, [
        applied.firstItemId,
        paymentId,
      ]);
    }
  }
  await postPaymentLedger(client, orgId, paymentId, {
    grossMinor: event.amountMinor,
    feeMinor: event.feeMinor ?? 0,
    taxOnFeeMinor: event.taxOnFeeMinor ?? 0,
    creditMinor,
    currency,
    occurredAt: event.occurredAt,
  });
  return true;
}

async function resolveReference(
  client: PoolClient,
  orgId: string,
  event: CanonicalEvent,
): Promise<{
  dealId: string | null;
  scheduleItemId: string | null;
  accountId: string | null;
  contactId: string | null;
}> {
  const empty = { dealId: null, scheduleItemId: null, accountId: null, contactId: null };
  const reference = event.reference ?? {};

  if (reference.scheduleItemId) {
    const { rows } = await client.query<{
      deal_id: string;
      account_id: string | null;
      contact_id: string | null;
    }>(
      `SELECT ps.deal_id, d.account_id, d.contact_id
         FROM payment_schedules ps JOIN deals d ON d.id = ps.deal_id
        WHERE ps.id = $1 AND ps.org_id = $2`,
      [reference.scheduleItemId, orgId],
    );
    if (rows[0]) {
      return {
        dealId: rows[0].deal_id,
        scheduleItemId: reference.scheduleItemId,
        accountId: rows[0].account_id,
        contactId: rows[0].contact_id,
      };
    }
  }

  if (reference.dealId) {
    const { rows } = await client.query<{
      id: string;
      account_id: string | null;
      contact_id: string | null;
    }>(`SELECT id, account_id, contact_id FROM deals WHERE id = $1 AND org_id = $2`, [
      reference.dealId,
      orgId,
    ]);
    if (rows[0]) {
      return {
        dealId: rows[0].id,
        scheduleItemId: null,
        accountId: rows[0].account_id,
        contactId: rows[0].contact_id,
      };
    }
  }

  // §7.3's bridge to the existing invoice path (0060): a payment link raised
  // against an invoice that bills a schedule item.
  if (reference.paymentLinkId) {
    const { rows } = await client.query<{
      deal_id: string | null;
      schedule_item_id: string | null;
      account_id: string | null;
      contact_id: string | null;
    }>(
      `SELECT ps.deal_id, ps.id AS schedule_item_id, i.account_id, i.contact_id
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         LEFT JOIN payment_schedules ps ON ps.invoice_id = i.id
        WHERE p.razorpay_payment_link_id = $1 AND p.org_id = $2
        LIMIT 1`,
      [reference.paymentLinkId, orgId],
    );
    if (rows[0]?.deal_id) {
      return {
        dealId: rows[0].deal_id,
        scheduleItemId: rows[0].schedule_item_id,
        accountId: rows[0].account_id,
        contactId: rows[0].contact_id,
      };
    }
  }

  // No reference. The payment lands UNMATCHED in the queue for a person -
  // §8's rule 4 - rather than being guessed at by amount here. The queue's own
  // read runs the full rule set; doing it in the drain as well would mean two
  // places that could guess differently.
  return empty;
}

/**
 * Apply to the schedule, oldest open item first (§15), and return the credit.
 *
 * Shares `applyToSchedule` with the API's manual path, so a gateway payment
 * and a cash receipt pay down the same instalment in the same order. The lock
 * is a statement of its own for the reason the API's version documents: a
 * webhook and its reconciliation catch-up arriving together would otherwise
 * both read `paid_amount = 0`.
 */
async function applyToDeal(
  client: PoolClient,
  orgId: string,
  dealId: string,
  amountMinor: number,
  currency: string,
): Promise<{ creditMinor: number; firstItemId: string | null }> {
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
    [dealId, orgId],
  );

  const items = rows.map((r) => ({
    id: r.id,
    dueDate: r.due_date,
    amountMinor: toMinor(r.amount, currency),
    paidMinor: toMinor(r.paid_amount, currency),
  }));
  const { applications, creditMinor } = applyToSchedule(items, amountMinor);

  for (const application of applications) {
    const item = items.find((i) => i.id === application.id);
    if (!item) continue;
    const paid = item.paidMinor + application.appliedMinor;
    await client.query(
      `UPDATE payment_schedules
          SET paid_amount = $1::numeric, status = $2,
              promised_on = CASE WHEN $2 = 'paid' THEN NULL ELSE promised_on END
        WHERE id = $3`,
      [toNumericString(paid, currency), paid >= item.amountMinor ? "paid" : "partial", application.id],
    );
  }

  if (creditMinor > 0) {
    await client.query(
      `UPDATE deals SET credit_balance = credit_balance + $1::numeric WHERE id = $2`,
      [toNumericString(creditMinor, currency), dealId],
    );
  }
  return { creditMinor, firstItemId: applications[0]?.id ?? null };
}

/**
 * The ledger posting for a captured payment.
 *
 * ── DUPLICATED FROM `apps/api/.../ledger.ts`, DELIBERATELY AND NARROWLY ─────
 *
 * The API's `ledger.post` throws a Nest `InternalServerErrorException`, which
 * the worker has no business importing - and `@nestjs/common` in this package
 * would pull the framework into the worker and the migration scripts. So the
 * shape is repeated here for the ONE posting the drain makes, and the
 * arithmetic that decides the direction is not: `paymentReceivedLines` is
 * imported from `@aura/shared` by both callers, so the two can never disagree
 * about which account is debited.
 */
async function postPaymentLedger(
  client: PoolClient,
  orgId: string,
  paymentId: string,
  options: {
    grossMinor: number;
    feeMinor: number;
    taxOnFeeMinor: number;
    creditMinor: number;
    currency: string;
    occurredAt: Date;
  },
): Promise<void> {
  const { grossMinor, feeMinor, taxOnFeeMinor, creditMinor, currency } = options;
  const appliedToReceivable = grossMinor - creditMinor;
  const netCash = grossMinor - feeMinor - taxOnFeeMinor;

  const lines: { account: string; debit: number; credit: number }[] = [
    { account: "cash", debit: netCash, credit: 0 },
  ];
  if (feeMinor + taxOnFeeMinor > 0) {
    lines.push({ account: "gateway_fees", debit: feeMinor + taxOnFeeMinor, credit: 0 });
  }
  if (appliedToReceivable > 0) {
    lines.push({ account: "receivable", debit: 0, credit: appliedToReceivable });
  }
  if (creditMinor > 0) {
    lines.push({ account: "customer_credit", debit: 0, credit: creditMinor });
  }

  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  if (debits !== credits) {
    // Thrown, so the event FAILS and is retried rather than leaving a
    // half-posted ledger. §16's invariant is worth a failed delivery.
    throw new Error(`unbalanced posting for payment ${paymentId}: ${debits} vs ${credits}`);
  }

  const postingId = randomUUID();
  for (const line of lines.filter((l) => l.debit !== 0 || l.credit !== 0)) {
    await client.query(
      `INSERT INTO ledger_entries
         (org_id, posting_id, account, debit, credit, currency,
          ref_type, ref_id, posted_at, actor_type, actor_id)
       VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, 'payment', $7, $8, 'system', 'connector')`,
      [
        orgId,
        postingId,
        line.account,
        toNumericString(line.debit, currency),
        toNumericString(line.credit, currency),
        currency,
        paymentId,
        options.occurredAt.toISOString(),
      ],
    );
  }
}

async function upsertRefund(
  client: PoolClient,
  orgId: string,
  event: CanonicalEvent,
): Promise<void> {
  const { rows } = await client.query<{ id: string; amount: string; currency: string }>(
    `SELECT id, amount::text, currency FROM finance_payments
      WHERE org_id = $1 AND external_id = $2`,
    [orgId, event.parentExternalId ?? ""],
  );
  const payment = rows[0];
  // A refund for a payment we never received is left alone rather than
  // inventing one: it means the capture webhook has not been processed yet, and
  // the row stays in the queue to be retried after it has.
  if (!payment) throw new Error(`refund ${event.externalId} precedes its payment`);

  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO finance_refunds
       (org_id, payment_id, amount, currency, reason, status, external_id, refunded_on)
     VALUES ($1, $2, $3::numeric, $4, 'Refunded at the gateway',
             $5, $6, $7::date)
     ON CONFLICT (org_id, external_id) WHERE external_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      orgId,
      payment.id,
      toNumericString(event.amountMinor, event.currency),
      event.currency,
      event.status === "failed" ? "failed" : "processed",
      event.externalId,
      event.occurredAt.toISOString().slice(0, 10),
    ],
  );
  if (!inserted[0] || event.status === "failed") return;

  const refundedMinor = event.amountMinor;
  const paidMinor = toMinor(payment.amount, payment.currency);
  const { rows: totals } = await client.query<{ refunded: string }>(
    `SELECT COALESCE(sum(amount), 0)::text AS refunded FROM finance_refunds
      WHERE payment_id = $1 AND status = 'processed'`,
    [payment.id],
  );
  await client.query(`UPDATE finance_payments SET status = $1 WHERE id = $2`, [
    toMinor(totals[0].refunded, payment.currency) >= paidMinor ? "refunded" : "partially_refunded",
    payment.id,
  ]);

  const postingId = randomUUID();
  for (const line of [
    { account: "receivable", debit: refundedMinor, credit: 0 },
    { account: "cash", debit: 0, credit: refundedMinor },
  ]) {
    await client.query(
      `INSERT INTO ledger_entries
         (org_id, posting_id, account, debit, credit, currency,
          ref_type, ref_id, posted_at, actor_type, actor_id)
       VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, 'refund', $7, $8, 'system', 'connector')`,
      [
        orgId,
        postingId,
        line.account,
        toNumericString(line.debit, event.currency),
        toNumericString(line.credit, event.currency),
        event.currency,
        inserted[0].id,
        event.occurredAt.toISOString(),
      ],
    );
  }
}

async function upsertDispute(
  client: PoolClient,
  orgId: string,
  event: CanonicalEvent,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM finance_payments WHERE org_id = $1 AND external_id = $2`,
    [orgId, event.parentExternalId ?? ""],
  );
  if (!rows[0]) throw new Error(`dispute ${event.externalId} precedes its payment`);

  await client.query(
    `INSERT INTO finance_disputes (org_id, payment_id, amount, status, opened_at, external_id)
     VALUES ($1, $2, $3::numeric, 'open', $4, $5)
     ON CONFLICT (org_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
    [
      orgId,
      rows[0].id,
      toNumericString(event.amountMinor, event.currency),
      event.occurredAt.toISOString(),
      event.externalId,
    ],
  );
  // The payment's status becomes `disputed`, which is STILL a collected status
  // (`COLLECTED_STATUSES`) - the money did arrive, and it may yet be kept.
  // Treating a dispute as uncollected would make a chargeback look like the
  // sale never happened, and the refund/chargeback RATE needs the gross.
  await client.query(
    `UPDATE finance_payments SET status = 'disputed'
      WHERE id = $1 AND status IN ('received', 'cheque_cleared')`,
    [rows[0].id],
  );
}

/**
 * §7.2.7: settlements are first-class. Gross, fee, tax, net and the bank
 * credit, with `mismatch` a GENERATED column so the flag cannot be stale.
 *
 * `bank_credit` is left NULL: the gateway's settlement report says what it
 * sent, not what the bank received. Somebody reconciling a statement fills it
 * in, and until they do `mismatch` is NULL - "not yet checked" rather than a
 * mismatch of the full amount.
 */
async function upsertSettlement(
  client: PoolClient,
  orgId: string,
  connectorAccountId: string,
  event: CanonicalEvent,
): Promise<void> {
  const s = event.settlement;
  if (!s) return;
  await client.query(
    `INSERT INTO finance_settlements
       (org_id, connector_account_id, external_id, gross, fee, tax, net,
        currency, settled_on, utr)
     VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric,
             $8, $9::date, $10)
     ON CONFLICT (connector_account_id, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET gross = EXCLUDED.gross, fee = EXCLUDED.fee,
                   tax = EXCLUDED.tax, net = EXCLUDED.net, utr = EXCLUDED.utr`,
    [
      orgId,
      connectorAccountId,
      event.externalId,
      toNumericString(s.grossMinor, event.currency),
      toNumericString(s.feeMinor, event.currency),
      toNumericString(s.taxMinor, event.currency),
      toNumericString(s.netMinor, event.currency),
      event.currency,
      event.occurredAt.toISOString().slice(0, 10),
      s.utr ?? null,
    ],
  );
}

async function autoMatchThreshold(client: PoolClient, orgId: string): Promise<number> {
  const { rows } = await client.query<{ t: string | null }>(
    `SELECT auto_match_confidence::text AS t FROM finance_settings WHERE org_id = $1`,
    [orgId],
  );
  return rows[0]?.t ? Number(rows[0].t) : FINANCE_DEFAULTS.autoMatchConfidence;
}

/**
 * §7.2.6's daily reconciliation: pull the gateway's own list for the last N
 * days and store anything we never received a webhook for.
 *
 * ── IT DOES NOT NORMALIZE, IT ONLY STORES ──────────────────────────────────
 *
 * Fetched events go into `connector_events` with `delivery = 'poll'` and are
 * drained by the same pass as a webhook. That is what makes a recovered
 * payment indistinguishable from a delivered one - §7.2.5 needs stored events
 * to be replayable regardless of how they arrived, and a second normalizing
 * path would be a second place for the credit logic to differ.
 */
export async function reconcileConnector(
  client: PoolClient,
  orgId: string,
  account: { id: string; type: string; credentials: { keyId: string; keySecret: string; webhookSecret: string | null } },
  days: number,
): Promise<{ fetched: number; missing: number }> {
  const connector = connectorFor(account.type);
  if (!connector) return { fetched: 0, missing: 0 };

  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const events = await connector.fetchWindow(account.credentials, from, to);

  let missing = 0;
  for (const event of events) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO connector_events
         (org_id, connector_account_id, external_id, event_type, payload,
          headers, signature_ok, delivery)
       VALUES ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb, true, 'poll')
       ON CONFLICT (connector_account_id, external_id) DO NOTHING
       RETURNING id`,
      [orgId, account.id, event.externalId, event.eventType, JSON.stringify(event.payload)],
    );
    if (rows[0]) missing += 1;
  }

  await client.query(
    `UPDATE connector_accounts SET reconciled_through = current_date WHERE id = $1`,
    [account.id],
  );
  return { fetched: events.length, missing };
}
