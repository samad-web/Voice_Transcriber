import type { PoolClient } from "pg";
import {
  type AgingBucket,
  type FinanceTotals,
  type SnapshotScope,
  emptyTotals,
  toMinor,
  toNumericString,
} from "@aura/shared";

/**
 * The ONE aggregation behind every finance number
 * (Build docs/finance-section-build-plan §11: "One metrics layer. Each metric
 * has a single definition and code path; dashboards, reports and the Advisor
 * all call it.").
 *
 * ── WHY THIS IS IN `@aura/db` AND NOT IN THE API ────────────────────────────
 *
 * Three callers need it and they live in three processes:
 *
 *   the API      - the dashboard's live figures for today
 *   the worker   - the nightly snapshot builder
 *   the Advisor  - the baselines its statistical rules compare against
 *
 * The worker cannot import from `apps/api`, so an API-resident version would
 * have been copied - and two copies of "collected" is precisely the failure
 * §11 opens by naming. `packages/db` is the one place all three already
 * depend on, alongside `crm-projection.ts` and `lead-boards.ts` which are here
 * for the same reason.
 *
 * ── AND WHY IT RETURNS MINOR UNITS ──────────────────────────────────────────
 *
 * Every figure comes back as integer paise through `toMinor`, so the arithmetic
 * downstream - `netMargin`, `cac`, `dso` - happens in integers. A `numeric`
 * string handed to a caller is a value somebody will eventually `Number()` and
 * multiply.
 */

export interface RollupWindow {
  /** Inclusive, `YYYY-MM-DD`, in the org's own calendar. */
  from: string;
  to: string;
}

/**
 * Compute the totals for one window.
 *
 * ── THE FOUR THINGS THAT MAKE THIS SUBTLE ───────────────────────────────────
 *
 * 1. `booked` counts deals by `finance_closed_on`, not by `updated_at`. A deal
 *    closed in March and edited in April is March's.
 * 2. `billed` is what came DUE in the window, which is the only honest
 *    denominator for a collection rate - dividing by what was booked would
 *    report 8% for a business on twelve-month instalment plans.
 * 3. `outstanding` and the aging buckets are BALANCES as at `to`, not sums
 *    over the window. They are computed by a separate query for that reason.
 * 4. `newCustomers` counts first-ever payments, not payments - so a customer
 *    paying monthly is counted once, in their first month, which is what makes
 *    CAC mean anything.
 */
export async function computeTotals(
  client: PoolClient,
  orgId: string,
  window: RollupWindow,
  scope: { scope: SnapshotScope; scopeId: string | null } = { scope: "org", scopeId: null },
): Promise<FinanceTotals> {
  const totals = emptyTotals();
  const { from, to } = window;

  // Scope narrowing, as a pair of predicates applied to each query. A `user`
  // scope means the DEAL's owner, not whoever recorded the payment - §11's
  // "per-telecaller profitability" is about who sold it.
  const dealScope = scopePredicate(scope, "d");
  const expenseScope = expenseScopePredicate(scope);

  const { rows: booked } = await client.query<{ booked: string; deals: string }>(
    `SELECT COALESCE(sum(d.amount), 0)::text AS booked, count(*)::text AS deals
       FROM deals d
      WHERE d.finance_closed_on BETWEEN $1::date AND $2::date
        AND d.status = 'won'
        ${dealScope.sql}`,
    [from, to, ...dealScope.params],
  );
  totals.bookedMinor = toMinor(booked[0].booked);
  totals.dealsClosed = Number(booked[0].deals);

  const { rows: billed } = await client.query<{ billed: string }>(
    `SELECT COALESCE(sum(ps.amount), 0)::text AS billed
       FROM payment_schedules ps
       JOIN deals d ON d.id = ps.deal_id
      WHERE ps.due_date BETWEEN $1::date AND $2::date
        AND ps.status <> 'cancelled'
        ${dealScope.sql}`,
    [from, to, ...dealScope.params],
  );
  totals.billedMinor = toMinor(billed[0].billed);

  // ── Collected, and the fees that came out of it ──────────────────────────
  //
  // `COLLECTED_STATUSES` is the list in @aura/shared; it is spelled out here
  // because this is SQL and cannot import a Set. The duplication is deliberate
  // and bounded: a test asserts the two lists are identical, so adding a status
  // to one and not the other fails rather than quietly changing every revenue
  // figure in the product.
  const { rows: collected } = await client.query<{
    collected: string;
    fees: string;
    disputed: string;
    delays: number[] | null;
  }>(
    `SELECT COALESCE(sum(fp.amount), 0)::text              AS collected,
            COALESCE(sum(fp.fee + fp.tax_on_fee), 0)::text AS fees,
            COALESCE(sum(fp.amount) FILTER (WHERE fp.status = 'disputed'), 0)::text AS disputed,
            -- Days from each item's DUE DATE to the money arriving. Negative
            -- for an early payment, which is kept rather than clamped: a
            -- median of -2 is real information about a business.
            array_remove(array_agg(
              CASE WHEN ps.due_date IS NOT NULL
                   THEN (fp.received_at::date - ps.due_date)
              END
            ), NULL) AS delays
       FROM finance_payments fp
       LEFT JOIN payment_schedules ps ON ps.id = fp.schedule_item_id
       LEFT JOIN deals d ON d.id = fp.deal_id
      WHERE fp.received_at::date BETWEEN $1::date AND $2::date
        AND fp.status IN ('received', 'cheque_cleared', 'partially_refunded', 'disputed')
        ${dealScope.sql}`,
    [from, to, ...dealScope.params],
  );
  totals.collectedMinor = toMinor(collected[0].collected);
  totals.feesMinor = toMinor(collected[0].fees);
  totals.disputedMinor = toMinor(collected[0].disputed);
  totals.daysToCollect = collected[0].delays ?? [];

  const { rows: refunded } = await client.query<{ refunded: string }>(
    `SELECT COALESCE(sum(r.amount), 0)::text AS refunded
       FROM finance_refunds r
       JOIN finance_payments fp ON fp.id = r.payment_id
       LEFT JOIN deals d ON d.id = fp.deal_id
      WHERE r.refunded_on BETWEEN $1::date AND $2::date
        AND r.status = 'processed'
        ${dealScope.sql}`,
    [from, to, ...dealScope.params],
  );
  totals.refundedMinor = toMinor(refunded[0].refunded);

  // Costs net of recoverable tax, and incentive kept in its own column so
  // `totalCosts()` adds it exactly once.
  const { rows: costs } = await client.query<{ costs: string; incentive: string }>(
    `SELECT COALESCE(sum(e.amount - e.tax) FILTER (WHERE e.category <> 'incentive'), 0)::text AS costs,
            COALESCE(sum(e.amount - e.tax) FILTER (WHERE e.category = 'incentive'), 0)::text AS incentive
       FROM expenses e
      WHERE e.incurred_on BETWEEN $1::date AND $2::date
        -- Approved only. An entered bill is a claim, and letting unapproved
        -- rows into the margin makes the approval limit decorative - the same
        -- reasoning that keeps an unverified cash receipt out of "collected".
        AND e.approved_at IS NOT NULL
        ${expenseScope.sql}`,
    [from, to, ...expenseScope.params],
  );
  totals.costsMinor = toMinor(costs[0].costs);
  totals.incentiveMinor = toMinor(costs[0].incentive);

  // ── The balances, as at `to` ──────────────────────────────────────────────
  // Binds `[to, scopeId]`, NOT `[from, to, scopeId]`: this is a balance as at
  // the window's end and never mentions `from`, and an unused bind parameter
  // is an error rather than a warning. Hence the scope clause's `$2`.
  const agingScope = scopePredicate(scope, "d", 2);
  const { rows: aging } = await client.query<{ bucket: string; amount: string }>(
    `SELECT CASE
              WHEN ps.due_date > $1::date THEN 'current'
              WHEN $1::date - ps.due_date <= 30 THEN '0_30'
              WHEN $1::date - ps.due_date <= 60 THEN '31_60'
              WHEN $1::date - ps.due_date <= 90 THEN '61_90'
              ELSE '90_plus'
            END AS bucket,
            sum(ps.amount - ps.paid_amount)::text AS amount
       FROM payment_schedules ps
       JOIN deals d ON d.id = ps.deal_id
      WHERE ps.status <> 'cancelled'
        AND ps.paid_amount < ps.amount
        -- Not yet raised as at the window's end: an instalment generated
        -- after it closed was not outstanding then, and including it would
        -- make a historical aging report change every time a deal is sold.
        AND ps.created_at::date <= $1::date
        ${agingScope.sql}
      -- GROUP BY the bucket expression. Omitting it was the one defect that
      -- survived every unit test in this module and showed up the first time
      -- the dashboard was opened against a real database with real schedules:
      -- a CASE beside a sum() with nothing to group on is a 42803, and the
      -- route answered 500.
      --
      -- Nothing could have caught it earlier. The pure tests cover the
      -- arithmetic, not the SQL, and the two places this bucketing is written
      -- - here and the dues endpoint - were written an hour apart; the dues
      -- one has its GROUP BY. That is the cost of the same expression living
      -- twice, and it is the argument for the ONE place §11 asks for.
      GROUP BY 1`,
    [to, ...agingScope.params],
  );
  for (const row of aging) {
    totals.agingMinor[row.bucket as AgingBucket] = toMinor(row.amount);
    totals.outstandingMinor += toMinor(row.amount);
  }

  const { rows: customers } = await client.query<{ customers: string }>(
    `SELECT count(*)::text AS customers
       FROM (
         SELECT COALESCE(fp.account_id::text, fp.contact_id::text) AS customer,
                min(fp.received_at::date) AS first_paid
           FROM finance_payments fp
           LEFT JOIN deals d ON d.id = fp.deal_id
          WHERE fp.status IN ('received', 'cheque_cleared', 'partially_refunded', 'disputed')
            AND COALESCE(fp.account_id::text, fp.contact_id::text) IS NOT NULL
            ${dealScope.sql}
          GROUP BY 1
       ) first_payments
      WHERE first_paid BETWEEN $1::date AND $2::date`,
    [from, to, ...dealScope.params],
  );
  totals.newCustomers = Number(customers[0].customers);

  return totals;
}

/**
 * The scope clause, and the PARAMETER INDEX its value will occupy.
 *
 * ── WHY THE INDEX IS AN ARGUMENT AND NOT ALWAYS `$3` ───────────────────────
 *
 * It was `$3` everywhere, because every query here binds `[from, to, scopeId]`
 * - except the aging one, which is a BALANCE as at the window's end and
 * legitimately never mentions `from`. Postgres refuses a statement with a
 * parameter it cannot type ("could not determine data type of parameter $1"),
 * so that query binds `[to, scopeId]` and its scope value is `$2`.
 *
 * Found the same way the missing GROUP BY above was: the first real request.
 * An unused bind parameter is not a warning, it is an error, and no amount of
 * reading the SQL makes it visible.
 */
function scopePredicate(
  scope: { scope: SnapshotScope; scopeId: string | null },
  alias: string,
  index = 3,
): { sql: string; params: unknown[] } {
  if (scope.scope === "org" || !scope.scopeId) return { sql: "", params: [] };
  switch (scope.scope) {
    case "user":
      return { sql: `AND ${alias}.owner_user_id = $${index}`, params: [scope.scopeId] };
    case "source":
      return { sql: `AND ${alias}.marketing_source_id = $${index}`, params: [scope.scopeId] };
    case "campaign":
      // `deals` has no campaign column; a campaign reaches a deal through the
      // lead it came from. Left as the lead's project for now, which is the
      // nearest thing this schema has - and stated rather than silently
      // returning org-wide numbers under a campaign label.
      return { sql: `AND ${alias}.project_id = $${index}`, params: [scope.scopeId] };
    case "template":
      return { sql: `AND ${alias}.finance_template_id = $${index}`, params: [scope.scopeId] };
    default:
      return { sql: "", params: [] };
  }
}

/**
 * Expenses scope differently from deals, and the difference matters.
 *
 * A `user` scope on an expense is `expenses.user_id` - the salary or incentive
 * that belongs to that person - NOT the deals they own. A `template` scope has
 * no meaning for an expense at all, so it returns a predicate that matches
 * nothing rather than silently attributing the whole floor's rent to one
 * template: a per-template margin built on org-wide costs would be a number
 * that looks precise and is fiction.
 */
function expenseScopePredicate(scope: {
  scope: SnapshotScope;
  scopeId: string | null;
}): { sql: string; params: unknown[] } {
  if (scope.scope === "org" || !scope.scopeId) return { sql: "", params: [] };
  if (scope.scope === "user") return { sql: "AND e.user_id = $3", params: [scope.scopeId] };
  if (scope.scope === "source") {
    return { sql: "AND e.marketing_source_id = $3", params: [scope.scopeId] };
  }
  return { sql: "AND false", params: [] };
}

const SENTINEL = "00000000-0000-0000-0000-000000000000";

/**
 * Write one day's snapshot. Idempotent - re-running a day replaces it, which
 * is what makes a backfill and a nightly run the same operation.
 */
export async function writeSnapshot(
  client: PoolClient,
  orgId: string,
  date: string,
  scope: { scope: SnapshotScope; scopeId: string | null },
  totals: FinanceTotals,
): Promise<void> {
  await client.query(
    `INSERT INTO finance_snapshots
       (org_id, snapshot_date, scope, scope_id,
        booked, billed, collected, refunded, disputed, fees, costs, incentive,
        outstanding, aging_current, aging_0_30, aging_31_60, aging_61_90, aging_90_plus,
        deals_closed, new_customers, days_to_collect, computed_at)
     VALUES ($1, $2::date, $3, $4,
             $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric,
             $10::numeric, $11::numeric, $12::numeric, $13::numeric,
             $14::numeric, $15::numeric, $16::numeric, $17::numeric, $18::numeric,
             $19, $20, $21::int[], now())
     ON CONFLICT (org_id, snapshot_date, scope, scope_id) DO UPDATE SET
       booked = EXCLUDED.booked, billed = EXCLUDED.billed,
       collected = EXCLUDED.collected, refunded = EXCLUDED.refunded,
       disputed = EXCLUDED.disputed, fees = EXCLUDED.fees,
       costs = EXCLUDED.costs, incentive = EXCLUDED.incentive,
       outstanding = EXCLUDED.outstanding,
       aging_current = EXCLUDED.aging_current, aging_0_30 = EXCLUDED.aging_0_30,
       aging_31_60 = EXCLUDED.aging_31_60, aging_61_90 = EXCLUDED.aging_61_90,
       aging_90_plus = EXCLUDED.aging_90_plus,
       deals_closed = EXCLUDED.deals_closed, new_customers = EXCLUDED.new_customers,
       days_to_collect = EXCLUDED.days_to_collect, computed_at = now()`,
    [
      orgId,
      date,
      scope.scope,
      scope.scopeId ?? SENTINEL,
      toNumericString(totals.bookedMinor),
      toNumericString(totals.billedMinor),
      toNumericString(totals.collectedMinor),
      toNumericString(totals.refundedMinor),
      toNumericString(totals.disputedMinor),
      toNumericString(totals.feesMinor),
      toNumericString(totals.costsMinor),
      toNumericString(totals.incentiveMinor),
      toNumericString(totals.outstandingMinor),
      toNumericString(totals.agingMinor.current),
      toNumericString(totals.agingMinor["0_30"]),
      toNumericString(totals.agingMinor["31_60"]),
      toNumericString(totals.agingMinor["61_90"]),
      toNumericString(totals.agingMinor["90_plus"]),
      totals.dealsClosed,
      totals.newCustomers,
      totals.daysToCollect,
    ],
  );
}

/** Read snapshots for a window, oldest first - `sumTotals` requires that order. */
export async function readSnapshots(
  client: PoolClient,
  orgId: string,
  window: RollupWindow,
  scope: { scope: SnapshotScope; scopeId: string | null } = { scope: "org", scopeId: null },
): Promise<{ totals: FinanceTotals[]; computedAt: Date | null }> {
  const { rows } = await client.query<{
    booked: string;
    billed: string;
    collected: string;
    refunded: string;
    disputed: string;
    fees: string;
    costs: string;
    incentive: string;
    outstanding: string;
    aging_current: string;
    aging_0_30: string;
    aging_31_60: string;
    aging_61_90: string;
    aging_90_plus: string;
    deals_closed: number;
    new_customers: number;
    days_to_collect: number[] | null;
    computed_at: Date;
  }>(
    `SELECT booked::text, billed::text, collected::text, refunded::text, disputed::text,
            fees::text, costs::text, incentive::text, outstanding::text,
            aging_current::text, aging_0_30::text, aging_31_60::text,
            aging_61_90::text, aging_90_plus::text,
            deals_closed, new_customers, days_to_collect, computed_at
       FROM finance_snapshots
      WHERE org_id = $1
        AND snapshot_date BETWEEN $2::date AND $3::date
        AND scope = $4 AND scope_id = $5
      ORDER BY snapshot_date`,
    [orgId, window.from, window.to, scope.scope, scope.scopeId ?? SENTINEL],
  );

  return {
    totals: rows.map((row) => ({
      bookedMinor: toMinor(row.booked),
      billedMinor: toMinor(row.billed),
      collectedMinor: toMinor(row.collected),
      refundedMinor: toMinor(row.refunded),
      disputedMinor: toMinor(row.disputed),
      feesMinor: toMinor(row.fees),
      costsMinor: toMinor(row.costs),
      incentiveMinor: toMinor(row.incentive),
      outstandingMinor: toMinor(row.outstanding),
      agingMinor: {
        current: toMinor(row.aging_current),
        "0_30": toMinor(row.aging_0_30),
        "31_60": toMinor(row.aging_31_60),
        "61_90": toMinor(row.aging_61_90),
        "90_plus": toMinor(row.aging_90_plus),
      },
      dealsClosed: row.deals_closed,
      newCustomers: row.new_customers,
      daysToCollect: row.days_to_collect ?? [],
    })),
    computedAt: rows.at(-1)?.computed_at ?? null,
  };
}

/**
 * The statuses that count as money in, as SQL - so a caller writing its own
 * query uses the same list rather than retyping four strings.
 *
 * `finance-rollup.test.ts` asserts this equals `COLLECTED_STATUSES`. That test
 * is the whole reason the constant exists: SQL cannot import a Set, so the
 * list IS duplicated, and the only defence against the copy drifting is a
 * test that fails when it does.
 */
export const COLLECTED_STATUS_SQL =
  `('received', 'cheque_cleared', 'partially_refunded', 'disputed')`;
