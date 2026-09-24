-- 0139_down.sql - hand-run reversal of 0139_payments_f0.sql.
--
-- Roll the API back FIRST: the F0 webhooks key idempotency on
-- payments.gateway_payment_id, and with the column gone they fail every
-- delivery (Razorpay and Stripe then retry until the code matches again).
--
-- ── WHAT IS DELIBERATELY LEFT STANDING ────────────────────────────────────
--
--   payments.amount_captured - the only record of what a gateway actually
--     captured when it differed from what the link asked for. Unread once the
--     code is rolled back; dropping it destroys evidence of an over-payment.
--   invoices.is_inter_state - the GST treatment a person chose. Unread by the
--     old code; doc 26's F1 migration re-adds the same column anyway.
--
-- Drop those two by hand only if F0 is being abandoned permanently.

DROP INDEX IF EXISTS payments_gateway_payment;
ALTER TABLE payments DROP COLUMN IF EXISTS gateway_payment_id;
