-- 0139_payments_f0.sql - doc 26 F0: repairs to today's invoicing.
--
-- ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
--
-- Both payment webhooks decided "have I already credited this?" with a row in
-- payment_webhook_events keyed on something that is NOT the payment:
--
--   Razorpay: `${event}:${paymentId}`. Razorpay sends BOTH `payment_link.paid`
--             and `payment.captured` for one payment. Two event names, two keys,
--             two credits. Reproduced against local Postgres on 2026-09-24: a
--             1000 invoice finished at amount_paid 2000, status 'paid'.
--   Stripe:   the event id. Stripe gives each delivery its own id, so a second
--             event about the same payment would also have credited again.
--
-- And both credited `payments.amount` (what the link ASKED for) rather than what
-- the gateway says it CAPTURED, with no cap at the invoice total.
--
-- ── THE DURABLE FIX ─────────────────────────────────────────────────────────
--
-- The idempotency key is the gateway's own payment id, held on the payment row
-- and made unique per provider by an index. Not per (org, provider): a gateway
-- payment id is globally unique inside its provider, and orgs on the platform
-- gateway share one Razorpay account and one webhook secret, so an index that
-- let the same captured payment land in two orgs would be the weaker one.
--
-- `amount_captured` is what the gateway reported, kept beside `amount` (what
-- was asked for) so an over- or under-payment is visible on the row instead of
-- silently folded into the invoice. The webhook credits at most the invoice's
-- outstanding balance; anything above that stays on this column for a person.
--
-- ── invoices.is_inter_state ─────────────────────────────────────────────────
--
-- The API took `interState` on create and never stored it, so an edit that did
-- not repeat it could not recompute the CGST/SGST vs IGST split against the new
-- total. Stored now. Doc 26's F1 lifecycle migration plans the same column with
-- the same backfill (`igst > 0`); ADD COLUMN IF NOT EXISTS keeps that a no-op.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS gateway_payment_id text,
  ADD COLUMN IF NOT EXISTS amount_captured    numeric;

COMMENT ON COLUMN payments.gateway_payment_id IS
  'The gateway''s own id for the captured payment (Razorpay pay_..., Stripe pi_...). '
  'Unique per provider: the webhook idempotency key that stops a second credit.';
COMMENT ON COLUMN payments.amount_captured IS
  'What the gateway reported capturing, in major units. `amount` is what the link asked for.';

-- Backfill from the ids the webhooks already stored. Only the earliest row per
-- (provider, id) takes it, so a historical duplicate - the very bug this fixes
-- - cannot abort the unique index below; any such rows are counted instead.
WITH src AS (
  SELECT id,
         provider,
         CASE provider
           WHEN 'razorpay' THEN razorpay_payment_id
           WHEN 'stripe'   THEN stripe_payment_intent_id
         END AS gid,
         created_at
    FROM payments
   WHERE gateway_payment_id IS NULL
), ranked AS (
  SELECT id, gid,
         row_number() OVER (PARTITION BY provider, gid ORDER BY created_at, id) AS rn
    FROM src
   WHERE gid IS NOT NULL
)
UPDATE payments p
   SET gateway_payment_id = r.gid
  FROM ranked r
 WHERE p.id = r.id
   AND r.rn = 1;

DO $do$
DECLARE dupes int;
BEGIN
  SELECT count(*) INTO dupes
    FROM payments
   WHERE gateway_payment_id IS NULL
     AND (   (provider = 'razorpay' AND razorpay_payment_id IS NOT NULL)
          OR (provider = 'stripe'   AND stripe_payment_intent_id IS NOT NULL));
  IF dupes > 0 THEN
    RAISE WARNING 'payments: % row(s) repeat a gateway payment id already held by an earlier row; left without gateway_payment_id - check them for a double credit', dupes;
  END IF;
END $do$;

-- What was credited under the old code is the best record of what was captured.
UPDATE payments
   SET amount_captured = amount
 WHERE status = 'paid'
   AND amount_captured IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payments_gateway_payment
  ON payments (provider, gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS is_inter_state boolean NOT NULL DEFAULT false;

UPDATE invoices
   SET is_inter_state = true
 WHERE igst > 0
   AND NOT is_inter_state;
