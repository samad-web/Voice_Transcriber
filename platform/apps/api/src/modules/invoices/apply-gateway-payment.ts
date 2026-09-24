/**
 * Credit one captured gateway payment to its invoice - the write both payment
 * webhooks share (doc 26 F0, defect 3).
 *
 * ── THE THREE RULES ─────────────────────────────────────────────────────────
 *
 * 1. Idempotent on the GATEWAY'S PAYMENT ID, not on the webhook event.
 *    Razorpay sends `payment_link.paid` AND `payment.captured` for one payment,
 *    and the old key `${event}:${paymentId}` gave them two keys and two
 *    credits. The id is held on `payments.gateway_payment_id`, unique per
 *    provider (migration 0139), so the database refuses a second claim even
 *    from two deliveries racing each other.
 *
 * 2. Credit what was CAPTURED, never what the link asked for. The two differ
 *    whenever a customer pays a stale link, and the gateway's number is the
 *    only one that describes money that exists.
 *
 * 3. Credit at most what is OUTSTANDING. Anything above the balance is kept on
 *    `payments.amount_captured` for a person to refund or apply - it is never
 *    folded into `invoices.amount_paid`, which would claim the customer paid an
 *    invoice more than its total. `status` becomes 'paid' only when the balance
 *    reaches zero.
 *
 * Runs inside the caller's `withOrg` transaction, so the claim and the credit
 * commit together or not at all: a crash between them cannot leave a claimed
 * payment that was never credited.
 */

type QueryClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export interface CapturedPayment {
  /** The `payments` row the webhook matched (the link / checkout session row). */
  paymentRowId: string;
  invoiceId: string;
  provider: "razorpay" | "stripe";
  /** Razorpay `pay_...`; Stripe payment intent `pi_...` (session id if Stripe gave none). */
  gatewayPaymentId: string;
  /** Major units, as the gateway reported capturing it. */
  amountCaptured: number;
  /** ISO code as the gateway reported it. */
  currency: string;
  /** Stripe only - kept on its own column as before. */
  stripePaymentIntentId?: string | null;
}

export type ApplyOutcome =
  /** Already recorded under this gateway payment id - a replay. Nothing written. */
  | { applied: false; reason: "duplicate" }
  /** Recorded as paid, and `credited` added to the invoice (0 when nothing was owed or the currency differs). */
  | { applied: true; credited: number; excess: number; currencyMismatch: boolean };

export async function applyGatewayPayment(
  client: QueryClient,
  p: CapturedPayment,
): Promise<ApplyOutcome> {
  // Claim the matched row - only while it holds no payment yet. Two deliveries
  // for one payment both reach here; the second blocks on the first's row lock
  // and then finds `gateway_payment_id` set, so it updates nothing.
  let claimed = await client.query(
    `UPDATE payments
        SET status              = 'paid',
            gateway_payment_id  = $2,
            amount_captured     = $3,
            captured_at         = now(),
            razorpay_payment_id = CASE WHEN provider = 'razorpay' THEN $2 ELSE razorpay_payment_id END,
            stripe_payment_intent_id = CASE WHEN provider = 'stripe'
                                            THEN COALESCE($4, stripe_payment_intent_id)
                                            ELSE stripe_payment_intent_id END
      WHERE id = $1 AND gateway_payment_id IS NULL
      RETURNING id, currency`,
    [p.paymentRowId, p.gatewayPaymentId, p.amountCaptured, p.stripePaymentIntentId ?? null],
  );

  if (claimed.rows.length === 0) {
    // The row already carries a payment. Either it is THIS payment (a replay,
    // or the second of Razorpay's two events) and the unique index turns the
    // insert into nothing, or it is a genuinely second payment against the
    // same link, which gets a row of its own.
    claimed = await client.query(
      `INSERT INTO payments
         (org_id, invoice_id, provider, status, amount, currency,
          gateway_payment_id, amount_captured, captured_at,
          razorpay_payment_id, stripe_payment_intent_id)
       SELECT org_id, invoice_id, provider, 'paid', $3, currency,
              $2, $3, now(),
              CASE WHEN provider = 'razorpay' THEN $2 END,
              CASE WHEN provider = 'stripe' THEN $4 END
         FROM payments WHERE id = $1
       ON CONFLICT (provider, gateway_payment_id) WHERE gateway_payment_id IS NOT NULL
       DO NOTHING
       RETURNING id, currency`,
      [p.paymentRowId, p.gatewayPaymentId, p.amountCaptured, p.stripePaymentIntentId ?? null],
    );
    if (claimed.rows.length === 0) return { applied: false, reason: "duplicate" };
  }

  // A capture in another currency than the link was raised in cannot be added
  // to the invoice's number without a rate nobody agreed. Recorded, not credited.
  const rowCurrency = String(claimed.rows[0].currency ?? "").toUpperCase();
  const currencyMismatch = rowCurrency !== p.currency.toUpperCase();

  let credited = 0;
  if (!currencyMismatch) {
    // Locked first, so two different payments crediting one invoice at the
    // same moment each see the balance the other left. status <> 'void': a
    // late delivery for an invoice voided meanwhile must not resurrect it.
    const {
      rows: [inv],
    } = await client.query(
      `SELECT LEAST($2::numeric, GREATEST(total - amount_paid, 0)) AS credit
         FROM invoices
        WHERE id = $1 AND status <> 'void'
        FOR UPDATE`,
      [p.invoiceId, p.amountCaptured],
    );
    if (inv) {
      // Both right-hand sides read the row's pre-update amount_paid.
      await client.query(
        `UPDATE invoices
            SET amount_paid = amount_paid + $2::numeric,
                status = CASE WHEN amount_paid + $2::numeric >= total THEN 'paid' ELSE status END
          WHERE id = $1`,
        [p.invoiceId, inv.credit],
      );
      credited = Number(inv.credit);
    }
  }

  return {
    applied: true,
    credited,
    excess: currencyMismatch ? 0 : Math.max(0, Math.round((p.amountCaptured - credited) * 100) / 100),
    currencyMismatch,
  };
}

/**
 * What the audit row records about a credit - amounts and ids, never a secret.
 * `excess` is the part of the capture NOT credited because the balance was
 * already covered: money a person has to refund or apply by hand.
 */
export function auditMeta(
  gatewayPaymentId: string,
  amountCaptured: number,
  currency: string,
  outcome: Extract<ApplyOutcome, { applied: true }>,
) {
  return {
    gatewayPaymentId,
    amountCaptured,
    currency,
    credited: outcome.credited,
    excess: outcome.excess,
    currencyMismatch: outcome.currencyMismatch,
  };
}
