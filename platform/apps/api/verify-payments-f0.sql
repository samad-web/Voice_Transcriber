-- verify-payments-f0.sql - doc 26 F0 payment/invoice repairs, against a real
-- Postgres with migration 0139 applied. Every statement the API runs is pasted
-- VERBATIM as a PREPAREd statement (PREPARE infers parameter types exactly as
-- node-postgres' untyped parameters do, so a type-resolution error here is one
-- the API would hit too). Everything runs in BEGIN ... ROLLBACK: nothing stays.
--
-- LOCAL ONLY. Never against production:
--   docker exec -i platform-postgres-1 psql -U aura -d callintel -v ON_ERROR_STOP=1 \
--     < apps/api/verify-payments-f0.sql
--
-- `aura` is a superuser and bypasses RLS, so every tenant-side statement runs
-- after SET LOCAL ROLE aura_app; the webhooks' admin-pool reads run as aura.

\set ON_ERROR_STOP 1
BEGIN;

SELECT set_config('app.org_id', (SELECT id::text FROM organizations ORDER BY created_at LIMIT 1), true) AS org;

-- ══ Defect 1 - the OLD save statement fails with 42P10 ═══════════════════════
SET LOCAL ROLE aura_app;
DO $$
BEGIN
  BEGIN
    EXECUTE
      $q$INSERT INTO payment_gateway_config (org_id, provider, key_id, key_secret, webhook_secret, enabled)
         VALUES ($1, 'razorpay', $2, $3, $4, $5)
         ON CONFLICT (org_id) DO UPDATE SET
           key_id  = EXCLUDED.key_id,
           key_secret     = COALESCE(EXCLUDED.key_secret, payment_gateway_config.key_secret),
           webhook_secret = COALESCE(EXCLUDED.webhook_secret, payment_gateway_config.webhook_secret),
           enabled = EXCLUDED.enabled$q$
      USING current_setting('app.org_id')::uuid, 'rzp_test_abcdefgh', 'enc:secret', NULL::text, true;
    RAISE EXCEPTION 'OLD upsert unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42P10' THEN
    RAISE NOTICE 'defect 1 reproduced: old ON CONFLICT (org_id) -> 42P10';
  END;
END $$;

-- ══ Defect 1 - the NEW save statement (payment-settings.controller.ts save) ══
PREPARE save_cfg AS
        INSERT INTO payment_gateway_config (org_id, provider, key_id, key_secret, webhook_secret, enabled)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, provider) DO UPDATE SET
           key_id  = EXCLUDED.key_id,
           key_secret     = COALESCE(EXCLUDED.key_secret, payment_gateway_config.key_secret),
           webhook_secret = COALESCE(EXCLUDED.webhook_secret, payment_gateway_config.webhook_secret),
           enabled = EXCLUDED.enabled;

PREPARE existing_cfg AS
        SELECT (key_secret IS NOT NULL) AS has_secret
           FROM payment_gateway_config WHERE org_id = $1 AND provider = $2;

PREPARE audit_cfg AS
        INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', 'owner-console', 'payment_gateway.update', 'organization', $2, $3);

-- clean slate for this org inside the transaction
DELETE FROM payment_gateway_config WHERE org_id = current_setting('app.org_id')::uuid;

EXECUTE save_cfg(current_setting('app.org_id')::uuid, 'razorpay', 'rzp_test_first001', 'enc:rzp-secret', 'enc:rzp-webhook', true);
EXECUTE audit_cfg(current_setting('app.org_id')::uuid, current_setting('app.org_id'), '{"provider":"razorpay"}');
-- second save: key id corrected, secrets omitted (NULL) -> stored ones kept
EXECUTE save_cfg(current_setting('app.org_id')::uuid, 'razorpay', 'rzp_test_second02', NULL, NULL, true);
-- a Stripe row beside it
EXECUTE save_cfg(current_setting('app.org_id')::uuid, 'stripe', 'pk_test_stripe0001', 'enc:sk-secret', 'enc:whsec', true);
EXECUTE existing_cfg(current_setting('app.org_id')::uuid, 'stripe');

DO $$ BEGIN
  ASSERT (SELECT count(*) FROM payment_gateway_config WHERE org_id = current_setting('app.org_id')::uuid) = 2,
    'expected one razorpay and one stripe row';
  ASSERT (SELECT key_id FROM payment_gateway_config WHERE org_id = current_setting('app.org_id')::uuid AND provider = 'razorpay') = 'rzp_test_second02',
    'key id not updated';
  ASSERT (SELECT key_secret FROM payment_gateway_config WHERE org_id = current_setting('app.org_id')::uuid AND provider = 'razorpay') = 'enc:rzp-secret',
    'omitted secret did not keep the stored one';
  ASSERT (SELECT webhook_secret FROM payment_gateway_config WHERE org_id = current_setting('app.org_id')::uuid AND provider = 'razorpay') = 'enc:rzp-webhook',
    'omitted webhook secret did not keep the stored one';
  RAISE NOTICE 'defect 1 fixed: save upserts per (org, provider), keep-secret works';
END $$;

-- ══ Defect 2 - provider-filtered reads (gateway-availability.ts) ═════════════
PREPARE read_states AS
    SELECT provider, key_id,
            (key_secret IS NOT NULL)     AS has_secret,
            (webhook_secret IS NOT NULL) AS has_webhook,
            enabled
       FROM payment_gateway_config
      WHERE org_id = $1 AND provider = ANY($2::text[]);
EXECUTE read_states(current_setting('app.org_id')::uuid, '{razorpay,stripe}');

-- ══ Fixtures: an invoice and a Razorpay link row, written as aura_app ════════
PREPARE ins_invoice AS
          INSERT INTO invoices
             (org_id, workspace_id, account_id, contact_id, deal_id, quotation_id, invoice_number,
              currency, subtotal, discount_type, discount_value, cgst, sgst, igst, customer_gstin,
              place_of_supply, total, due_date, notes, owner_user_id, is_inter_state)
           VALUES ($1, $2, $3, $4, $5, $6, next_invoice_number($1), $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17, $18, $19, $20)
           RETURNING id, workspace_id, account_id, contact_id, deal_id, quotation_id,
  invoice_number, status, currency, subtotal, discount_type, discount_value, cgst, sgst, igst,
  (cgst + sgst + igst) AS tax_total, is_inter_state, payment_provider,
  customer_gstin, place_of_supply, total, amount_paid, due_date, notes, owner_user_id,
  created_at, updated_at;

-- 847.46 + 18% IGST = 1000 (inter-state)
EXECUTE ins_invoice(current_setting('app.org_id')::uuid, NULL, NULL, NULL, NULL, NULL, 'INR',
                    847.46, NULL, 0, 0, 0, 152.54, NULL, NULL, 1000, NULL, 'verify', NULL, true);
CREATE TEMP TABLE t_inv ON COMMIT DROP AS
  SELECT id FROM invoices WHERE notes = 'verify' AND org_id = current_setting('app.org_id')::uuid;
SELECT id AS inv_id FROM t_inv \gset

DO $$ BEGIN
  ASSERT (SELECT is_inter_state FROM invoices WHERE id = (SELECT id FROM t_inv)), 'is_inter_state not persisted';
  ASSERT (SELECT (cgst + sgst + igst) FROM invoices WHERE id = (SELECT id FROM t_inv)) = 152.54, 'tax_total wrong';
  RAISE NOTICE 'defect 5: is_inter_state persisted on create, tax_total derived';
END $$;

-- the payment-link row, exactly as payments.controller.ts writes it
PREPARE ins_link AS
          INSERT INTO payments (org_id, invoice_id, provider, razorpay_payment_link_id, status, amount, currency)
           VALUES ($1, $2, 'razorpay', $3, 'created', $4, $5)
           RETURNING id, status, amount, currency, razorpay_payment_link_id, created_at;
EXECUTE ins_link(current_setting('app.org_id')::uuid, :'inv_id', 'plink_VERIFYF0', 1000, 'INR');
SELECT id AS link_id FROM payments WHERE razorpay_payment_link_id = 'plink_VERIFYF0' \gset

-- ══ Defect 2/3 - the webhook's admin-pool reads (run as aura, like adminPool) ═
RESET ROLE;
PREPARE wh_row AS
      SELECT p.org_id, p.invoice_id, p.id AS payment_row_id
         FROM payments p
        WHERE p.razorpay_payment_link_id = $1;
EXECUTE wh_row('plink_VERIFYF0');
PREPARE wh_cfg AS
      SELECT key_id, key_secret, webhook_secret, enabled
         FROM payment_gateway_config WHERE org_id = $1 AND provider = 'razorpay';
EXECUTE wh_cfg(current_setting('app.org_id')::uuid);
DO $$ BEGIN
  ASSERT (SELECT key_secret FROM payment_gateway_config WHERE org_id = current_setting('app.org_id')::uuid AND provider = 'razorpay') = 'enc:rzp-secret',
    'razorpay webhook would read the wrong row';
  RAISE NOTICE 'defect 2 fixed: webhook config read is provider-filtered';
END $$;
SET LOCAL ROLE aura_app;

-- ══ Defect 3 - apply-gateway-payment.ts, verbatim ════════════════════════════
PREPARE claim AS
    UPDATE payments
        SET status              = 'paid',
            gateway_payment_id  = $2,
            amount_captured     = $3,
            captured_at         = now(),
            razorpay_payment_id = CASE WHEN provider = 'razorpay' THEN $2 ELSE razorpay_payment_id END,
            stripe_payment_intent_id = CASE WHEN provider = 'stripe'
                                            THEN COALESCE($4, stripe_payment_intent_id)
                                            ELSE stripe_payment_intent_id END
      WHERE id = $1 AND gateway_payment_id IS NULL
      RETURNING id, currency;

PREPARE claim_new AS
      INSERT INTO payments
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
       RETURNING id, currency;

PREPARE lock_credit AS
      SELECT LEAST($2::numeric, GREATEST(total - amount_paid, 0)) AS credit
         FROM invoices
        WHERE id = $1 AND status <> 'void'
        FOR UPDATE;

PREPARE apply_credit AS
        UPDATE invoices
            SET amount_paid = amount_paid + $2::numeric,
                status = CASE WHEN amount_paid + $2::numeric >= total THEN 'paid' ELSE status END
          WHERE id = $1;

-- Delivery 1: payment_link.paid for pay_A, captured 600 of the 1000 asked.
EXECUTE claim(:'link_id', 'pay_VERIFY_A', 600, NULL);
EXECUTE lock_credit(:'inv_id', 600);
EXECUTE apply_credit(:'inv_id', 600);
DO $$ BEGIN
  ASSERT (SELECT amount_paid FROM invoices WHERE id = (SELECT id FROM t_inv)) = 600, 'credited the link amount, not the captured amount';
  ASSERT (SELECT status FROM invoices WHERE id = (SELECT id FROM t_inv)) = 'draft', 'partial payment must not mark paid';
  RAISE NOTICE 'defect 3: captured amount (600) credited, status unchanged while partial';
END $$;

-- Delivery 2: payment.captured for THE SAME pay_A (the old double credit).
-- The claim finds the row taken; the insert hits the unique index -> nothing.
EXECUTE claim(:'link_id', 'pay_VERIFY_A', 600, NULL);
EXECUTE claim_new(:'link_id', 'pay_VERIFY_A', 600, NULL);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM payments WHERE gateway_payment_id = 'pay_VERIFY_A') = 1, 'replay inserted a second row for pay_A';
  ASSERT (SELECT amount_paid FROM invoices WHERE id = (SELECT id FROM t_inv)) = 600, 'replay credited again';
  RAISE NOTICE 'defect 3 fixed: second event for the same payment id writes nothing';
END $$;

-- A genuinely second payment, pay_B, 600 captured against a 400 balance:
-- its own row, credit capped at 400, invoice paid, 200 excess left on the row.
EXECUTE claim(:'link_id', 'pay_VERIFY_B', 600, NULL);
EXECUTE claim_new(:'link_id', 'pay_VERIFY_B', 600, NULL);
EXECUTE lock_credit(:'inv_id', 600);
EXECUTE apply_credit(:'inv_id', 400);
DO $$ BEGIN
  ASSERT (SELECT amount_paid FROM invoices WHERE id = (SELECT id FROM t_inv)) = 1000, 'amount_paid not capped at total';
  ASSERT (SELECT status FROM invoices WHERE id = (SELECT id FROM t_inv)) = 'paid', 'fully paid invoice not marked paid';
  ASSERT (SELECT amount_captured FROM payments WHERE gateway_payment_id = 'pay_VERIFY_B') = 600, 'captured amount not recorded';
  RAISE NOTICE 'defect 3 fixed: over-capture capped at the balance, status paid only when fully paid';
END $$;

-- A third capture on a fully paid invoice credits 0.
EXECUTE lock_credit(:'inv_id', 50);

-- Durable key: the unique index refuses the same (provider, payment id) twice.
DO $$ BEGIN
  BEGIN
    INSERT INTO payments (org_id, invoice_id, provider, status, amount, currency, gateway_payment_id)
    VALUES (current_setting('app.org_id')::uuid, (SELECT id FROM t_inv), 'razorpay', 'paid', 1, 'INR', 'pay_VERIFY_A');
    RAISE EXCEPTION 'unique index did not refuse a duplicate gateway payment id';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'payments_gateway_payment unique index holds';
  END;
END $$;

-- Stripe: the same claim for a stripe row sets the intent column too.
PREPARE ins_stripe AS
          INSERT INTO payments (org_id, invoice_id, provider, stripe_session_id, status, amount, currency)
           VALUES ($1, $2, 'stripe', $3, 'created', $4, $5)
           RETURNING id, status, amount, currency, stripe_session_id, created_at;
EXECUTE ins_stripe(current_setting('app.org_id')::uuid, :'inv_id', 'cs_test_VERIFY', 10, 'INR');
SELECT id AS stripe_id FROM payments WHERE stripe_session_id = 'cs_test_VERIFY' \gset
EXECUTE claim(:'stripe_id', 'pi_VERIFY', 10, 'pi_VERIFY');
DO $$ BEGIN
  ASSERT (SELECT stripe_payment_intent_id FROM payments WHERE stripe_session_id = 'cs_test_VERIFY') = 'pi_VERIFY', 'stripe intent not stored';
  ASSERT (SELECT razorpay_payment_id FROM payments WHERE stripe_session_id = 'cs_test_VERIFY') IS NULL, 'stripe row got a razorpay id';
  RAISE NOTICE 'stripe claim ok';
END $$;

PREPARE wh_audit AS
            INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
             VALUES ($1, 'system', 'razorpay-webhook', 'payment.captured', 'invoice', $2, $3);
EXECUTE wh_audit(current_setting('app.org_id')::uuid, :'inv_id', '{"gatewayPaymentId":"pay_VERIFY_B","credited":400,"excess":200}');

-- ══ Defect 4/5 - PATCH statements (invoices.controller.ts update) ═══════════
PREPARE patch_lock AS
        SELECT id, status, amount_paid, discount_type, discount_value, is_inter_state
           FROM invoices WHERE id = $1
           FOR UPDATE;
EXECUTE patch_lock(:'inv_id');

PREPARE patch_void_check AS
            SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1 AND status = 'paid';
EXECUTE patch_void_check(:'inv_id');

PREPARE patch_update AS
        UPDATE invoices SET
           account_id      = CASE WHEN $2::boolean THEN $3 ELSE account_id END,
           contact_id      = CASE WHEN $4::boolean THEN $5 ELSE contact_id END,
           deal_id         = CASE WHEN $6::boolean THEN $7 ELSE deal_id END,
           status          = COALESCE($8, status),
           discount_type   = $9,
           discount_value  = $10,
           subtotal        = $11,
           cgst            = $12,
           sgst            = $13,
           igst            = $14,
           is_inter_state  = $24,
           total            = $15,
           customer_gstin  = CASE WHEN $16::boolean THEN $17 ELSE customer_gstin END,
           place_of_supply = CASE WHEN $18::boolean THEN $19 ELSE place_of_supply END,
           due_date        = CASE WHEN $20::boolean THEN $21 ELSE due_date END,
           notes           = CASE WHEN $22::boolean THEN $23 ELSE notes END
         WHERE id = $1
         RETURNING id, workspace_id, account_id, contact_id, deal_id, quotation_id,
  invoice_number, status, currency, subtotal, discount_type, discount_value, cgst, sgst, igst,
  (cgst + sgst + igst) AS tax_total, is_inter_state, payment_provider,
  customer_gstin, place_of_supply, total, amount_paid, due_date, notes, owner_user_id,
  created_at, updated_at;

-- A second draft, intra-state, to exercise an edit that omits interState:
-- the split is recomputed from the STORED treatment (CGST+SGST), not left stale.
EXECUTE ins_invoice(current_setting('app.org_id')::uuid, NULL, NULL, NULL, NULL, NULL, 'INR',
                    100, NULL, 0, 9, 9, 0, NULL, NULL, 118, NULL, 'verify-2', NULL, false);
SELECT id AS inv2_id FROM invoices WHERE notes = 'verify-2' AND org_id = current_setting('app.org_id')::uuid \gset
EXECUTE patch_update(:'inv2_id',
                     false, NULL, false, NULL, false, NULL, NULL, NULL, 0, 200, 18, 18, 0, 236,
                     false, NULL, false, NULL, false, NULL, false, NULL, false);
DO $$ BEGIN
  ASSERT (SELECT cgst + sgst FROM invoices WHERE notes = 'verify-2' AND org_id = current_setting('app.org_id')::uuid) = 36, 'GST split stale after line edit';
  RAISE NOTICE 'defect 5 fixed: GST split recomputed on edit, is_inter_state stored';
END $$;

-- RLS: a foreign org sees none of it.
SELECT set_config('app.org_id', '00000000-0000-0000-0000-000000000000', true);
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM payments WHERE gateway_payment_id LIKE 'pay_VERIFY_%') = 0, 'RLS leak on payments';
  ASSERT (SELECT count(*) FROM payment_gateway_config) = 0, 'RLS leak on payment_gateway_config';
  RAISE NOTICE 'RLS holds for the new column paths';
END $$;

ROLLBACK;
