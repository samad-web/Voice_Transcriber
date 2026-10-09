-- 0173_finance_payments_ledger.sql
-- Build docs/finance-section-build-plan, M2: the canonical payment and the ledger.
--
-- ── WHY `finance_payments` AND NOT `payments` ───────────────────────────────
--
-- §6.1 wants ONE canonical payment record. Migration 0060's `payments` cannot
-- be it, for three reasons that are all structural rather than stylistic:
--
--   * `invoice_id` is NOT NULL. §6.1's record attaches to a deal and a
--     schedule item, and plenty of businesses on this platform collect money
--     without ever raising an invoice.
--   * its status CHECK is `created | paid | failed`. §6.1 needs eleven, four of
--     which (`pending_verification`, `cheque_cleared`, `cheque_bounced`,
--     `reversed`) are the entire substance of §6.2.
--   * it means "a gateway payment LINK", with `razorpay_payment_link_id` and a
--     unique index on it. A cash receipt has no link.
--
-- So 0060's table keeps its job and becomes a SOURCE: when its webhook
-- captures a payment, `apply-gateway-payment.ts` normalizes it into a
-- `finance_payments` row with `source = 'connector'` and `origin_payment_id`
-- pointing back. Nothing about today's invoice collection changes, and
-- "collected" acquires exactly one definition (DECISIONS.md §3.2).
--
-- ── NOTHING IN HERE IS EVER EDITED OR DELETED ───────────────────────────────
--
-- §6.3 is a MUST: "never edit or delete a posted payment or ledger row.
-- Correct by reversal entry plus a new entry." `ledger_entries` is therefore
-- granted SELECT, INSERT to `aura_app` and NOTHING ELSE - no UPDATE, no
-- DELETE, enforced by Postgres rather than by code review. It has no
-- `updated_at` column and no trigger, because there is no update to stamp.

-- ── §6.1 the canonical payment ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finance_payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- All three nullable: money can arrive before anybody knows what it is for.
  -- That is not a defect to be constrained away, it is §8's whole premise -
  -- the unmatched queue exists because a bank credit has no deal id on it.
  deal_id            uuid REFERENCES deals(id) ON DELETE SET NULL,
  schedule_item_id   uuid REFERENCES payment_schedules(id) ON DELETE SET NULL,
  -- "Customer" on this platform is an account or a contact, so both, and the
  -- matcher fills whichever it could identify.
  account_id         uuid REFERENCES accounts(id) ON DELETE SET NULL,
  contact_id         uuid REFERENCES contacts(id) ON DELETE SET NULL,

  amount             numeric NOT NULL CHECK (amount >= 0),
  currency           text NOT NULL DEFAULT 'INR',
  -- Set only when `currency` is not the org's own, so a foreign receipt can be
  -- restated without re-reading a rate table that has moved since.
  fx_rate            numeric CHECK (fx_rate IS NULL OR fx_rate > 0),

  -- §6.1's method list. TEXT, not an enum type: §6.1 says "owners can add
  -- custom methods", and a Postgres enum needs a migration to grow. The
  -- console offers `PaymentMethod`'s values and this column accepts the
  -- tenant's own words beside them.
  method             text NOT NULL,
  -- Cheque number, bank, UTR, the last four of a card. JSONB because every
  -- method needs different fields and none of them are queried on.
  method_detail      jsonb NOT NULL DEFAULT '{}'::jsonb,

  status             text NOT NULL CHECK (status IN (
                       'initiated', 'authorized', 'received', 'failed',
                       'refunded', 'partially_refunded', 'disputed', 'reversed',
                       'pending_verification', 'cheque_cleared', 'cheque_bounced')),
  source             text NOT NULL CHECK (source IN ('connector', 'bank_import', 'csv_import', 'manual')),

  connector_account_id uuid,  -- FK added in 0174, which creates the table
  external_id        text,
  -- The 0060 `payments` row this was normalized from, when it came from the
  -- existing gateway path. One-to-one, so a unique index: a second
  -- finance_payment for the same link payment would double "collected".
  origin_payment_id  uuid REFERENCES payments(id) ON DELETE SET NULL,
  -- The raw connector event, for §7.2.5's replayability. FK added in 0174.
  raw_event_id       uuid,

  received_at        timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz,

  -- §7.2.7: the gateway's cut, split out rather than netted, so "gateway fee %"
  -- has a numerator and `net` reconciles against the settlement.
  fee                numeric NOT NULL DEFAULT 0 CHECK (fee >= 0),
  tax_on_fee         numeric NOT NULL DEFAULT 0 CHECK (tax_on_fee >= 0),
  net                numeric,

  -- §8's matching verdict, on every payment.
  match_status       text NOT NULL DEFAULT 'unmatched'
                       CHECK (match_status IN ('matched', 'suggested', 'unmatched')),
  match_confidence   numeric CHECK (match_confidence IS NULL
                                    OR (match_confidence >= 0 AND match_confidence <= 1)),
  -- Which of §8's four rules produced the verdict. Shown in the queue so a
  -- person confirming a suggestion knows WHY it was suggested.
  match_rule         text,

  -- §6.2: proof is required for an offline method. Enforced by the API rather
  -- than a CHECK, because the proof may be a reference number in
  -- `method_detail` instead of an upload, and a CHECK spanning two columns
  -- with an OR is a constraint nobody can read.
  proof_url          text,
  -- §6.2's second-person approval. `verified_by` is NEVER the payment's own
  -- creator - asserted in the API and tested, because a CHECK cannot see who
  -- is making the request.
  recorded_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at        timestamptz,
  -- Set when a payment is reversed, bounced or corrected (§6.3). The REASON is
  -- mandatory for those transitions in the API; audit_log holds the actor.
  reversal_reason    text,
  memo               text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- §7.2.3's idempotency key. A duplicate webhook delivery must be harmless, and
-- this is what makes it so - the second INSERT violates the index and the
-- handler treats that as success rather than crediting again.
--
-- Per (connector_account, external_id) rather than per (org, provider): 0139
-- learned the narrower version of this lesson the hard way, and the same
-- reasoning applies - a gateway payment id is unique inside the account that
-- issued it, and a key that let one captured payment land twice would be the
-- weaker index.
CREATE UNIQUE INDEX IF NOT EXISTS finance_payments_external
  ON finance_payments (connector_account_id, external_id)
  WHERE external_id IS NOT NULL;

-- One canonical row per 0060 payment, so normalizing twice cannot double-count.
CREATE UNIQUE INDEX IF NOT EXISTS finance_payments_origin
  ON finance_payments (origin_payment_id) WHERE origin_payment_id IS NOT NULL;

-- §9's required indexes.
CREATE INDEX IF NOT EXISTS finance_payments_org_received
  ON finance_payments (org_id, received_at DESC);
CREATE INDEX IF NOT EXISTS finance_payments_org_match
  ON finance_payments (org_id, match_status, received_at DESC);
CREATE INDEX IF NOT EXISTS finance_payments_schedule
  ON finance_payments (schedule_item_id) WHERE schedule_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_payments_deal
  ON finance_payments (deal_id) WHERE deal_id IS NOT NULL;
-- The verification queue: what is waiting for a second person.
CREATE INDEX IF NOT EXISTS finance_payments_pending
  ON finance_payments (org_id, received_at)
  WHERE status = 'pending_verification';

ALTER TABLE finance_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_payments FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON finance_payments
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- No DELETE. §6.3: a payment is reversed, never removed.
GRANT SELECT, INSERT, UPDATE ON finance_payments TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON finance_payments FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON finance_payments FROM PUBLIC;
-- §6.3: a payment is reversed, never removed.
REVOKE DELETE ON finance_payments FROM aura_app;
DO $$ BEGIN
  CREATE TRIGGER finance_payments_set_updated_at BEFORE UPDATE ON finance_payments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §9/§13's period lock, on the date the money arrived.
DO $$ BEGIN
  CREATE TRIGGER finance_payments_period_lock
    BEFORE INSERT OR UPDATE OF received_at, amount, status ON finance_payments
    FOR EACH ROW EXECUTE FUNCTION finance_refuse_locked_period('received_at');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §9 refunds ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finance_refunds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: a payment with a refund against it must not be
  -- removable, and nothing may remove a payment anyway (no DELETE grant).
  payment_id  uuid NOT NULL REFERENCES finance_payments(id) ON DELETE RESTRICT,
  amount      numeric NOT NULL CHECK (amount > 0),
  currency    text NOT NULL DEFAULT 'INR',
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'processed'
                CHECK (status IN ('initiated', 'processed', 'failed')),
  external_id text,
  -- §10's clawback window is measured from here, not from the payment date.
  refunded_on date NOT NULL DEFAULT current_date,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_refunds_payment ON finance_refunds (payment_id);
CREATE INDEX IF NOT EXISTS finance_refunds_org_date ON finance_refunds (org_id, refunded_on DESC);
CREATE UNIQUE INDEX IF NOT EXISTS finance_refunds_external
  ON finance_refunds (org_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE finance_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_refunds FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON finance_refunds
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE ON finance_refunds TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON finance_refunds FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON finance_refunds FROM PUBLIC;
REVOKE DELETE ON finance_refunds FROM aura_app;

-- ── §9 disputes ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finance_disputes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_id  uuid NOT NULL REFERENCES finance_payments(id) ON DELETE RESTRICT,
  amount      numeric NOT NULL CHECK (amount > 0),
  status      text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'under_review', 'won', 'lost', 'closed')),
  opened_at   timestamptz NOT NULL DEFAULT now(),
  -- The gateway's own deadline for evidence. The single most expensive date in
  -- this table to miss, which is why it is a column and not a note.
  due_by      timestamptz,
  resolved_at timestamptz,
  external_id text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_disputes_payment ON finance_disputes (payment_id);
CREATE INDEX IF NOT EXISTS finance_disputes_open
  ON finance_disputes (org_id, due_by) WHERE status IN ('open', 'under_review');
CREATE UNIQUE INDEX IF NOT EXISTS finance_disputes_external
  ON finance_disputes (org_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE finance_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_disputes FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON finance_disputes
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE ON finance_disputes TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON finance_disputes FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON finance_disputes FROM PUBLIC;
REVOKE DELETE ON finance_disputes FROM aura_app;

-- ── §9 the ledger ──────────────────────────────────────────────────────────
--
-- ── WHY SEVEN ACCOUNTS AND A CHECK, RATHER THAN A CHART OF ACCOUNTS TABLE ──
--
-- §1 puts "full double-entry accounting replacement" out of scope. This is not
-- a general ledger - it is the audit trail that makes every dashboard number
-- drillable and every correction reversible. Seven accounts post every event
-- the module produces and each one has a metric that reads it (see
-- `LedgerAccount` in packages/shared/src/finance.ts).
--
-- A CHECK rather than a table, deliberately: an eighth account means a new
-- metric or a new event, which is a reviewed decision in a migration rather
-- than a string somebody inserted at 2am.
--
-- ── `posting_id` IS WHAT MAKES "DEBITS = CREDITS" CHECKABLE ────────────────
--
-- §16 wants the invariant as a property test. A single entry can never
-- balance - a receipt is cash DR / receivable CR, two rows - so the invariant
-- belongs to the POSTING, and without a column grouping the rows of one
-- posting there is nothing to sum. Every writer generates one `posting_id` per
-- event and the verification query groups on it.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  posting_id  uuid NOT NULL,
  account     text NOT NULL CHECK (account IN
                ('cash', 'receivable', 'revenue', 'gateway_fees',
                 'tax_payable', 'expense', 'customer_credit')),
  debit       numeric NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit      numeric NOT NULL DEFAULT 0 CHECK (credit >= 0),
  -- Exactly one side, always. A row with both is an error nobody would spot in
  -- a list, and a row with neither is noise that makes the ledger longer
  -- without making it say anything.
  CONSTRAINT ledger_entries_one_side CHECK ((debit > 0) <> (credit > 0)),
  currency    text NOT NULL DEFAULT 'INR',
  ref_type    text NOT NULL CHECK (ref_type IN
                ('deal', 'schedule_item', 'payment', 'refund', 'dispute',
                 'settlement', 'expense', 'adjustment')),
  ref_id      uuid,
  posted_at   timestamptz NOT NULL DEFAULT now(),
  -- §6.3: a correction is a REVERSING row pointing at what it reverses, plus a
  -- new one. Self-referencing, RESTRICT, and nothing may delete a ledger row
  -- anyway (no DELETE grant below).
  reverses_id uuid REFERENCES ledger_entries(id) ON DELETE RESTRICT,
  memo        text,
  -- Who caused this. `actor_type` mirrors audit_log's vocabulary so the two
  -- can be read side by side.
  actor_type  text NOT NULL DEFAULT 'system',
  actor_id    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- §9's required index, plus the posting grouping and the period sum.
CREATE INDEX IF NOT EXISTS ledger_entries_org_ref
  ON ledger_entries (org_id, ref_type, ref_id);
CREATE INDEX IF NOT EXISTS ledger_entries_posting
  ON ledger_entries (posting_id);
CREATE INDEX IF NOT EXISTS ledger_entries_org_posted
  ON ledger_entries (org_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS ledger_entries_account
  ON ledger_entries (org_id, account, posted_at);
-- A reversal must be findable FROM the row it reverses, which is how the API
-- refuses to reverse the same entry twice.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_reverses
  ON ledger_entries (reverses_id) WHERE reverses_id IS NOT NULL;

ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON ledger_entries
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── APPEND-ONLY, ENFORCED BY THE GRANT ─────────────────────────────────────
--
-- SELECT and INSERT only. §6.3's "never edit or delete a posted ledger row" is
-- a MUST, and the difference between a comment saying so and Postgres refusing
-- is the difference between a rule and a hope. A handler that tries to UPDATE
-- a ledger row gets a permission error in development, not a silently rewritten
-- audit trail in production.
GRANT SELECT, INSERT ON ledger_entries TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ledger_entries FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON ledger_entries FROM PUBLIC;
-- §6.3's MUST, enforced by Postgres rather than by code review.
REVOKE UPDATE, DELETE ON ledger_entries FROM aura_app;
-- ── THE GRANT ABOVE NARROWS NOTHING WITHOUT THIS ──────────────────────────
--
-- 0001 ends with
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aura_app;
--
-- so EVERY new table in `public` arrives with full DML for the app role. A
-- `GRANT SELECT, INSERT` is therefore a no-op that reads like a restriction -
-- the same trap the `marketing` schema hit, where a GRANT-only migration was
-- believed to have narrowed a role and had not.
--
-- 0001 handles its own two append-only surfaces exactly this way
-- (`REVOKE UPDATE, DELETE ON audit_log`), and these need the same. Found by
-- running the claim as SQL rather than trusting it: an UPDATE and a DELETE on
-- `ledger_entries` as `aura_app` both succeeded.


DO $$ BEGIN
  CREATE TRIGGER ledger_entries_period_lock
    BEFORE INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION finance_refuse_locked_period('posted_at');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §7.2.7 settlements ─────────────────────────────────────────────────────
--
-- "Settlements are first-class: store gross, gateway fee, tax on fee, net, and
-- the bank credit amount. Flag any settlement where net != bank_credit."
--
-- `mismatch` is a GENERATED column, not a value a job writes. A flag computed
-- by a sweep is a flag that is wrong between sweeps - and this one is the input
-- to a `critical` alert, so being right only sometimes is not an option.
-- `bank_credit` is NULL until somebody reconciles the statement, and NULL
-- minus anything is NULL, which correctly reads as "not yet checked" rather
-- than as a mismatch of the full amount.
CREATE TABLE IF NOT EXISTS finance_settlements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connector_account_id uuid,  -- FK added in 0174
  external_id          text,
  gross                numeric NOT NULL DEFAULT 0,
  fee                  numeric NOT NULL DEFAULT 0,
  tax                  numeric NOT NULL DEFAULT 0,
  net                  numeric NOT NULL DEFAULT 0,
  bank_credit          numeric,
  currency             text NOT NULL DEFAULT 'INR',
  settled_on           date NOT NULL,
  mismatch             numeric GENERATED ALWAYS AS (
                         CASE WHEN bank_credit IS NULL THEN NULL ELSE net - bank_credit END
                       ) STORED,
  utr                  text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_settlements_external
  ON finance_settlements (connector_account_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_settlements_org_date
  ON finance_settlements (org_id, settled_on DESC);
-- The detector's own query: settled, reconciled, and off.
CREATE INDEX IF NOT EXISTS finance_settlements_mismatch
  ON finance_settlements (org_id, settled_on) WHERE mismatch IS NOT NULL AND mismatch <> 0;

ALTER TABLE finance_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_settlements FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON finance_settlements
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT, INSERT, UPDATE ON finance_settlements TO aura_app;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON finance_settlements FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON finance_settlements FROM PUBLIC;
REVOKE DELETE ON finance_settlements FROM aura_app;
DO $$ BEGIN
  CREATE TRIGGER finance_settlements_set_updated_at BEFORE UPDATE ON finance_settlements
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── A read-only view of what each deal owes ────────────────────────────────
--
-- `security_invoker = true` IS LOAD-BEARING. Every table here has FORCE ROW
-- LEVEL SECURITY, and a view without this option runs as its OWNER - the
-- migration role - which bypasses RLS entirely and would make this view a
-- cross-tenant read of every deal's balance on the platform. Doc 26 flagged
-- exactly this for `invoice_balances` before it was written; this is the
-- schema's first view and it gets it right from the start.
--
-- Postgres 15+. The repo targets 14+, so the option is applied in a guarded
-- block: on 14 the view is NOT created rather than created unsafely, and the
-- API's balance query (which does not use the view) keeps working.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 150000 THEN
    CREATE OR REPLACE VIEW deal_balances WITH (security_invoker = true) AS
      SELECT d.id   AS deal_id,
             d.org_id,
             COALESCE(sum(ps.amount), 0)                        AS scheduled,
             COALESCE(sum(ps.paid_amount), 0)                   AS paid,
             COALESCE(sum(ps.amount - ps.paid_amount), 0)       AS outstanding,
             d.credit_balance,
             min(ps.due_date) FILTER (WHERE ps.status <> 'paid') AS next_due_date,
             count(ps.id) FILTER (WHERE ps.status <> 'paid')     AS open_items
        FROM deals d
        LEFT JOIN payment_schedules ps
          ON ps.deal_id = d.id AND ps.status <> 'cancelled'
       GROUP BY d.id, d.org_id, d.credit_balance;
    GRANT SELECT ON deal_balances TO aura_app;
    REVOKE ALL ON deal_balances FROM PUBLIC;
  ELSE
    RAISE WARNING '0173: Postgres < 15, skipping deal_balances - a view without security_invoker would bypass FORCE RLS';
  END IF;
END $$;
