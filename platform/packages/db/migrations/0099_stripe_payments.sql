-- 0099_stripe_payments.sql - Stripe alongside Razorpay.
--
-- ── WHY BOTH AND NOT ONE ────────────────────────────────────────────────────
--
-- Razorpay is the right gateway for an Indian business collecting in rupees
-- from Indian customers, and it is the wrong one for the same business
-- invoicing a customer in Dubai or London. The tenants this product sells to
-- routinely do both, and "which gateway" is decided per invoice by who is
-- paying, not once per company.
--
-- ── THE SHAPE CHANGE THIS NEEDED ────────────────────────────────────────────
--
-- `payment_gateway_config` (0060) is keyed on `org_id` alone, with a `provider`
-- column defaulting to 'razorpay'. That is one gateway per org with the name of
-- the gateway written on it - which reads as multi-provider and is not: adding
-- Stripe would have meant overwriting the Razorpay credentials.
--
-- So the key becomes (org_id, provider). Nothing about existing rows changes -
-- they are all 'razorpay' and stay exactly where they are - and the table
-- finally means what its column always implied.
--
-- ── AND WHAT DOES NOT CHANGE ────────────────────────────────────────────────
--
-- `payments.provider` already exists and already defaults to 'razorpay'
-- (0060), so the ledger needed nothing. Nor did the rule 0060's own header
-- states and this migration preserves without exception: Aura NEVER marks an
-- invoice paid because a link was created or because a browser came back to a
-- success page. Only a signed webhook delivery does that, per provider, with
-- its own signature scheme - and `payment_webhook_events` is already keyed on
-- (provider, event_id) rather than on event_id alone, which is what lets a
-- second provider share it without a Stripe event id ever colliding with a
-- Razorpay one.

-- ── One row per provider per org ────────────────────────────────────────────
--
-- The primary key is dropped and rebuilt rather than added to, because
-- Postgres has no ALTER for a key's column list. The intermediate state is
-- inside this transaction and never visible.
ALTER TABLE payment_gateway_config DROP CONSTRAINT IF EXISTS payment_gateway_config_pkey;
ALTER TABLE payment_gateway_config
  ADD CONSTRAINT payment_gateway_config_pkey PRIMARY KEY (org_id, provider);

ALTER TABLE payment_gateway_config DROP CONSTRAINT IF EXISTS payment_gateway_config_provider_check;
ALTER TABLE payment_gateway_config ADD CONSTRAINT payment_gateway_config_provider_check
  CHECK (provider IN ('razorpay', 'stripe'));

COMMENT ON COLUMN payment_gateway_config.key_id IS
  'Razorpay: the key id. Stripe: the PUBLISHABLE key, which is not a secret - '
  'it is here so the console can show which account is connected without '
  'decrypting anything. The secret key is in key_secret, encrypted.';

-- ── The ledger's vocabulary ─────────────────────────────────────────────────
--
-- `payments.provider` was free text with a default. Constrained now, for the
-- reason every other small closed set in this schema is: a typo'd provider on
-- a payment row is a payment that reconciles against nothing and is invisible
-- to both gateways' reports.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_provider_check;
ALTER TABLE payments ADD CONSTRAINT payments_provider_check
  CHECK (provider IN ('razorpay', 'stripe', 'manual')) NOT VALID;

-- NOT VALID then validated, the same shape 0095 used. `payments.provider` has
-- been free text with a default since 0060, so a row carrying something else -
-- a hand-inserted reconciliation, a value from a branch that never shipped -
-- would abort this whole migration at the worst possible moment. Validating
-- separately means such a row raises a warning naming the count, the migration
-- completes, and somebody looks at it. The constraint stays NOT VALID until
-- they do, which still constrains every future write.
DO $do$ BEGIN
  ALTER TABLE payments VALIDATE CONSTRAINT payments_provider_check;
EXCEPTION WHEN check_violation THEN
  RAISE WARNING 'payments: % row(s) carry an unexpected provider; constraint left NOT VALID',
    (SELECT count(*) FROM payments WHERE provider NOT IN ('razorpay', 'stripe', 'manual'));
END $do$;

-- Stripe's own identifiers, beside Razorpay's rather than reusing them. A
-- column called razorpay_payment_id holding a Stripe session id is the kind of
-- thing that reads fine for a year and then produces a support conversation
-- nobody can follow.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS stripe_session_id       text,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;

-- Same partial-unique shape 0060 used for the Razorpay link: one payment row
-- per gateway object, so a replayed webhook cannot create a second.
CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_session
  ON payments (stripe_session_id) WHERE stripe_session_id IS NOT NULL;

-- ── Which gateway an invoice was sent through ───────────────────────────────
--
-- Recorded on the invoice, because the answer has to survive the payment
-- failing: an invoice sent through Stripe and never paid has no `payments` row
-- to read the provider off, and re-sending it through Razorpay by accident
-- would give the customer two links to the same money.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS payment_provider text;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_provider_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_payment_provider_check
  CHECK (payment_provider IS NULL OR payment_provider IN ('razorpay', 'stripe'));

-- Backfill from the payments that already exist.
--
-- Without it, every invoice that already has a live Razorpay link reads as
-- having no gateway, and the "this invoice already has a link" guard would
-- happily issue a Stripe one beside it - handing the customer two ways to pay
-- the same money on the day this ships. DISTINCT ON because an invoice can
-- carry several payment attempts; the earliest is the one whose link is out
-- in the world.
UPDATE invoices i
   SET payment_provider = p.provider
  FROM (
    SELECT DISTINCT ON (invoice_id) invoice_id, provider
      FROM payments
     WHERE provider IN ('razorpay', 'stripe')
     ORDER BY invoice_id, created_at ASC
  ) p
 WHERE i.id = p.invoice_id
   AND i.payment_provider IS NULL;
