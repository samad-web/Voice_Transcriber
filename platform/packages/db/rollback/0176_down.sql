-- 0176_down.sql - reverse the finance module in full (0172-0176).
--
-- Run by hand, against a database you have checked twice:
--   psql "$DATABASE_URL" -f packages/db/rollback/0176_down.sql
--
-- ── ONE FILE FOR FIVE MIGRATIONS, AND WHY ───────────────────────────────────
--
-- 0172-0176 are one module. Their foreign keys run in both directions -
-- `finance_payments.connector_account_id` points forward into 0174, which in
-- turn constrains a column 0173 created - so there is no order in which they
-- can be dropped one migration at a time without disabling constraints
-- halfway. Reversing the module as a unit is the only honest way to do it, and
-- a per-migration file would be four files that each only work if the other
-- three have already run.
--
-- ── READ THIS FIRST: THIS DESTROYS THE MONEY RECORD ─────────────────────────
--
-- `ledger_entries` is the append-only audit trail of every receipt, refund,
-- reversal and expense the module has posted - §6.3's entire correction model.
-- NOTHING else in the schema can reconstruct it. `finance_payments` is every
-- cash, cheque and bank payment somebody recorded by hand, which exists
-- nowhere else at all: the gateway half can be re-derived from 0060's
-- `payments`, the manual half cannot.
--
-- Keep them, before anything else:
--
--   \copy (SELECT * FROM ledger_entries)     TO 'ledger.csv'      CSV HEADER
--   \copy (SELECT * FROM finance_payments)   TO 'payments.csv'    CSV HEADER
--   \copy (SELECT * FROM payment_schedules)  TO 'schedules.csv'   CSV HEADER
--   \copy (SELECT * FROM expenses)           TO 'expenses.csv'    CSV HEADER
--   \copy (SELECT * FROM incentive_payouts)  TO 'payouts.csv'     CSV HEADER
--   \copy (SELECT * FROM incentive_lines)    TO 'payout-lines.csv' CSV HEADER
--
-- `incentive_payouts` and `incentive_lines` are what somebody was PAID and the
-- statement that justified it. A business that has to re-answer "why was my
-- incentive this amount in March" with no copy of these has a problem no
-- migration can fix.
--
-- `connector_events` holds the raw gateway payloads. They are re-fetchable
-- from the gateway's own API within its retention window (§7.2.6's backfill is
-- the mechanism), so they are the one table here it is reasonable to lose.
--
-- ── WHAT THIS DELIBERATELY LEAVES STANDING ──────────────────────────────────
--
-- `audit_log` rows. Every approval, reversal and period lock the module
-- recorded stays - the same rule every other rollback in this directory
-- follows: human corrections and audit history are kept, not dropped.
--
-- `payments`, `invoices`, `invoice_items`, `payment_gateway_config`,
-- `payment_webhook_events` (0060/0099/0139). The module never owned them;
-- invoice collection worked before it and keeps working after.
--
-- `marketing_source_spend` (0171). The cost layer READ it and never wrote it.
--
-- `commission_plans` (0088). Untouched - the finance module deliberately did
-- not reuse it, because it pays on booked value and §10 pays on collected.
--
-- `notifications.kind`'s widened CHECK. Narrowing it back would fail against
-- any `finance_alert` row still in the table, and a leftover permissive value
-- in an enum harms nothing. The rows themselves are deleted below.

BEGIN;

-- ── 1. The permission grants (0172) ────────────────────────────────────────
--
-- First, not last: leaving them behind would be rows referencing object types
-- that `PermissionObjectType` no longer contains, which the roles screen
-- renders as a cell with no label and `permissions-inventory.spec.ts` cannot
-- explain.
DELETE FROM role_permissions WHERE object_type IN ('finance', 'incentive');

-- ── 2. The notifications the module raised ─────────────────────────────────
DELETE FROM notifications WHERE kind IN ('finance_alert', 'finance_payout');

-- ── 3. 0176 ────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS advisor_suggestions;
DROP TABLE IF EXISTS forecast_runs;
DROP TABLE IF EXISTS due_reminders;
DROP TABLE IF EXISTS alert_events;
DROP TABLE IF EXISTS advisor_alerts;
DROP TABLE IF EXISTS advisor_rules;
DROP TABLE IF EXISTS finance_snapshots;

-- ── 4. 0175 ────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS incentive_lines;
DROP TABLE IF EXISTS incentive_payouts;
DROP TABLE IF EXISTS incentive_plans;
DROP TABLE IF EXISTS cost_drivers;
DROP TABLE IF EXISTS expenses;

-- ── 5. 0174 ────────────────────────────────────────────────────────────────
--
-- The forward constraints 0174 added onto 0173's tables go with it, or the
-- DROP below fails on a dependency it did not create.
ALTER TABLE IF EXISTS finance_payments
  DROP CONSTRAINT IF EXISTS finance_payments_connector_account_id_fkey,
  DROP CONSTRAINT IF EXISTS finance_payments_raw_event_id_fkey;
ALTER TABLE IF EXISTS finance_settlements
  DROP CONSTRAINT IF EXISTS finance_settlements_connector_account_id_fkey;

DROP TABLE IF EXISTS connector_events;
DROP TABLE IF EXISTS connector_accounts;
DROP FUNCTION IF EXISTS connector_events_refuse_payload_edit();

-- ── 6. 0173 ────────────────────────────────────────────────────────────────
DROP VIEW  IF EXISTS deal_balances;
DROP TABLE IF EXISTS finance_settlements;
DROP TABLE IF EXISTS finance_disputes;
DROP TABLE IF EXISTS finance_refunds;
-- `ledger_entries` self-references through `reverses_id` with ON DELETE
-- RESTRICT; dropping the whole table is fine, deleting rows from it is not.
DROP TABLE IF EXISTS ledger_entries;
DROP TABLE IF EXISTS finance_payments;

-- ── 7. 0172 ────────────────────────────────────────────────────────────────
--
-- `payment_schedules` before `deal_templates`: the schedule references the
-- deal, the deal references the template. Nothing references the schedule.
DROP TABLE IF EXISTS payment_schedules;

-- The columns added to `deals`. Dropped, which loses which template a deal was
-- sold under and any credit balance owed back to a customer - the second of
-- which is money, so it is in the export list above via `deal_balances`:
--
--   \copy (SELECT id, finance_template_id, finance_template_version,
--                 finance_custom_fields, finance_closed_on, credit_balance
--            FROM deals WHERE finance_template_id IS NOT NULL
--                           OR credit_balance > 0) TO 'deal-finance.csv' CSV HEADER
--
-- `currency` is NOT dropped. It defaults to 'INR' for every existing row, the
-- quotations and invoices beside it have always had one, and a deal without a
-- currency is a bug this migration happened to fix.
ALTER TABLE deals
  DROP COLUMN IF EXISTS finance_template_id,
  DROP COLUMN IF EXISTS finance_template_version,
  DROP COLUMN IF EXISTS finance_custom_fields,
  DROP COLUMN IF EXISTS finance_closed_on,
  DROP COLUMN IF EXISTS credit_balance;

DROP TABLE IF EXISTS deal_templates;
DROP TABLE IF EXISTS finance_periods;
DROP TABLE IF EXISTS finance_settings;

DROP FUNCTION IF EXISTS finance_refuse_locked_period();
DROP FUNCTION IF EXISTS finance_period_locked(uuid, date);

-- ── 8. The ledger entry in schema_migrations ───────────────────────────────
--
-- Without this, `migrate.js` believes 0172-0176 are applied and will never
-- re-run them - so a re-deploy comes up with the code expecting tables that
-- are no longer there. This is the step every rollback in this directory ends
-- with and the one that is easiest to forget.
DELETE FROM schema_migrations
 WHERE filename IN ('0172_finance_foundations.sql',
                    '0173_finance_payments_ledger.sql',
                    '0174_finance_connectors.sql',
                    '0175_finance_costs.sql',
                    '0176_finance_advisor_snapshots.sql');

COMMIT;

-- ── AFTERWARDS, IN THE APPLICATION ─────────────────────────────────────────
--
-- Turn the module off for every tenant that had it, or `CrmPermissionsGuard`
-- will keep letting requests through to routes whose tables are gone:
--
--   UPDATE organizations
--      SET enabled_modules = array_remove(enabled_modules, 'finance')
--    WHERE 'finance' = ANY(enabled_modules);
--
-- Left as a comment rather than run, because it is a change to live
-- entitlements and whoever is rolling back should decide it deliberately.
