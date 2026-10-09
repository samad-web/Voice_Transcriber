import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { computeTotals, readSnapshots } from "@aura/db";
import {
  DateOnly,
  FINANCE_METRICS,
  type FinanceTotals,
  type Freshness,
  HEALTH_WEIGHTS,
  SnapshotScope,
  cac,
  collectionRate,
  compare,
  daysBetween,
  daysToCollect,
  dso,
  emptyTotals,
  freshnessLabel,
  gatewayFeeRate,
  healthScore,
  netCollected,
  netMargin,
  refundRate,
  runwayMonths,
  sumTotals,
  toMinor,
  toMajor,
  toCsv,
  totalCosts,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { loadFinanceSettings, orgToday } from "./finance-settings";

/**
 * §11's dashboards: the metrics layer's HTTP surface.
 *
 * ── SNAPSHOT FIRST, LIVE WHERE IT MATTERS ───────────────────────────────────
 *
 * §13 requires dashboards to "load from snapshots, not raw scans" at p95 under
 * two seconds. §11 requires "live counters for today". Both, in one response:
 * complete days come from `finance_snapshots` and TODAY is computed live, then
 * summed. So a payment recorded a minute ago shows up, and a year-to-date
 * figure is twelve sums of pre-computed rows rather than a scan of the ledger.
 *
 * When no snapshot exists for a day the figures fall back to `computeTotals` -
 * the SAME function the snapshot builder calls - so a tenant whose nightly job
 * has not run yet sees correct numbers slowly rather than wrong numbers
 * quickly. That is also what makes the snapshot a cache rather than a source
 * (DECISIONS.md §4).
 *
 * ── EVERY NUMBER CARRIES WHERE IT DRILLS TO ─────────────────────────────────
 *
 * §11 is a MUST: "every number is clickable and drills down to the underlying
 * payments, schedule items or expenses." The catalogue in
 * `FINANCE_METRICS` holds each metric's destination and the response echoes it,
 * so the console cannot show a figure it has no route for - and adding a metric
 * without a drill-down is caught by a test rather than by a user clicking.
 */

const PeriodQuery = z.object({
  from: DateOnly,
  to: DateOnly,
  scope: SnapshotScope.default("org"),
  scopeId: z.string().uuid().optional(),
  /** Period-over-period. Omitted, the previous window of equal length is used. */
  compareFrom: DateOnly.optional(),
  compareTo: DateOnly.optional(),
});

@Controller("finance")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class FinanceDashboardController {
  constructor(private readonly db: DbService) {}

  @Get("overview")
  @RequireCrmPermission("finance", "view")
  async overview(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = PeriodQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;
    if (q.from > q.to) throw new BadRequestException("from is after to");

    const scope = { scope: q.scope, scopeId: q.scopeId ?? null };

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const settings = await loadFinanceSettings(client, orgId);

      const current = await this.totalsFor(client, orgId, q.from, q.to, scope, today);

      // The comparison window. Defaults to the SAME NUMBER OF DAYS immediately
      // before - not "last month" - so comparing a 10-day window compares it
      // with the previous 10 days. A month-over-month default would make a
      // partial month look like a collapse every time.
      const span = daysBetween(q.from, q.to);
      const previousTo = addDays(q.from, -1);
      const previousFrom = addDays(previousTo, -span);
      const previous = await this.totalsFor(
        client,
        orgId,
        q.compareFrom ?? previousFrom,
        q.compareTo ?? previousTo,
        scope,
        today,
      );

      const freshness = await this.freshness(client, current.computedAt, q.to >= today);
      const daysInPeriod = span + 1;

      const metrics = {
        booked: current.totals.bookedMinor,
        collected: netCollected(current.totals),
        billed: current.totals.billedMinor,
        refunded: current.totals.refundedMinor,
        fees: current.totals.feesMinor,
        costs: totalCosts(current.totals),
        outstanding: current.totals.outstandingMinor,
        collectionRate: collectionRate(current.totals),
        netMargin: netMargin(current.totals),
        gatewayFeeRate: gatewayFeeRate(current.totals),
        refundRate: refundRate(current.totals),
        cac: cac(current.totals),
        dso: dso(current.totals, daysInPeriod),
        daysToCollect: daysToCollect(current.totals),
        dealsClosed: current.totals.dealsClosed,
        newCustomers: current.totals.newCustomers,
      };

      // ── Runway, from the burn the period actually shows ──────────────────
      //
      // §11: cash ÷ average monthly net burn. The burn is this window's net
      // scaled to a month, so a ten-day window does not report a tenth of the
      // real burn - and `runwayMonths` returns null when the business is
      // cash-positive rather than a negative number of months.
      const netMinor = netCollected(current.totals) - totalCosts(current.totals);
      const monthlyBurnMinor = Math.round((-netMinor / daysInPeriod) * 30);
      const cashMinor = await this.cashBalance(client, orgId);

      const health = healthScore({
        collectionRate: metrics.collectionRate,
        netMargin: metrics.netMargin,
        runwayMonths: runwayMonths(cashMinor, monthlyBurnMinor),
        leakageRatio: await this.leakageRatio(client, netCollected(current.totals)),
        dso: metrics.dso,
      });

      return {
        period: { from: q.from, to: q.to, days: daysInPeriod },
        scope,
        currency: "INR",
        /** Major units at the edge - every other controller in this API does. */
        metrics: {
          booked: toMajor(metrics.booked),
          collected: toMajor(metrics.collected),
          billed: toMajor(metrics.billed),
          refunded: toMajor(metrics.refunded),
          fees: toMajor(metrics.fees),
          costs: toMajor(metrics.costs),
          outstanding: toMajor(metrics.outstanding),
          collectionRate: metrics.collectionRate,
          netMargin: metrics.netMargin,
          gatewayFeeRate: metrics.gatewayFeeRate,
          refundRate: metrics.refundRate,
          cac: metrics.cac === null ? null : toMajor(metrics.cac),
          dso: metrics.dso,
          daysToCollect: metrics.daysToCollect,
          dealsClosed: metrics.dealsClosed,
          newCustomers: metrics.newCustomers,
          cash: toMajor(cashMinor),
          monthlyBurn: toMajor(Math.max(monthlyBurnMinor, 0)),
          runwayMonths: runwayMonths(cashMinor, monthlyBurnMinor),
        },
        aging: Object.fromEntries(
          Object.entries(current.totals.agingMinor).map(([k, v]) => [k, toMajor(v)]),
        ),
        comparison: {
          period: { from: q.compareFrom ?? previousFrom, to: q.compareTo ?? previousTo },
          booked: compare("booked", current.totals.bookedMinor, previous.totals.bookedMinor),
          collected: compare("collected", netCollected(current.totals), netCollected(previous.totals)),
          outstanding: compare(
            "outstanding",
            current.totals.outstandingMinor,
            previous.totals.outstandingMinor,
          ),
          collectionRate: compare(
            "collection_rate",
            collectionRate(current.totals),
            collectionRate(previous.totals),
          ),
          netMargin: compare("net_margin", netMargin(current.totals), netMargin(previous.totals)),
        },
        /** §12.6: the score, with every component and weight visible. */
        health: {
          score: health.score,
          weights: HEALTH_WEIGHTS,
          components: health.components,
          unmeasuredWeight: health.unmeasuredWeight,
        },
        /** §11's MUST: where each number drills to. */
        drillDowns: Object.fromEntries(FINANCE_METRICS.map((m) => [m.key, m.drillTo])),
        definitions: Object.fromEntries(FINANCE_METRICS.map((m) => [m.key, m.definition])),
        freshness: {
          ...freshness,
          label: freshnessLabel(freshness, new Date()),
        },
        settings: {
          autoMatchConfidence: settings.autoMatchConfidence,
          minimumCash: toMajor(settings.minimumCashMinor),
          configured: settings.configured,
        },
      };
    });
  }

  /**
   * §11's "per-telecaller profitability" and "per-campaign/source ROI", from
   * the same rollup.
   *
   * ── WHY THE SNAPSHOT IS NOT USED HERE ──────────────────────────────────────
   *
   * A per-user breakdown needs a row per user per day, and writing one for
   * every user every night is a lot of rows for a page somebody opens weekly.
   * So this computes live over the window, which is affordable because it is
   * one query per subject rather than per day. If it ever becomes slow, the
   * fix is to snapshot the `user` scope nightly - the builder already takes a
   * scope argument for exactly that.
   */
  @Get("breakdown")
  @RequireCrmPermission("finance", "view")
  async breakdown(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = PeriodQuery.extend({
      by: z.enum(["user", "source", "template"]),
    }).safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const subjects = await this.subjectsFor(client, q.by);
      const rows = [];
      for (const subject of subjects) {
        const totals = await computeTotals(
          client,
          orgId,
          { from: q.from, to: q.to },
          { scope: q.by, scopeId: subject.id },
        );
        // A subject with no activity at all is dropped rather than listed as a
        // row of zeros: a fifty-row table where forty are empty is a table
        // nobody reads.
        if (
          totals.bookedMinor === 0 &&
          totals.collectedMinor === 0 &&
          totals.costsMinor === 0 &&
          totals.outstandingMinor === 0
        ) {
          continue;
        }
        rows.push({
          id: subject.id,
          name: subject.name,
          booked: toMajor(totals.bookedMinor),
          collected: toMajor(netCollected(totals)),
          costs: toMajor(totalCosts(totals)),
          outstanding: toMajor(totals.outstandingMinor),
          netMargin: netMargin(totals),
          collectionRate: collectionRate(totals),
          cac: cac(totals) === null ? null : toMajor(cac(totals) as number),
          newCustomers: totals.newCustomers,
          dealsClosed: totals.dealsClosed,
        });
      }
      return {
        period: { from: q.from, to: q.to },
        by: q.by,
        rows: rows.sort((a, b) => b.collected - a.collected),
      };
    });
  }

  /**
   * §11's telecaller view: "my sales and collection status, my incentive
   * (projected vs confirmed), my dues to chase".
   *
   * ── WHY THIS IS A SEPARATE ROUTE AND NOT `overview?scope=user` ─────────────
   *
   * Because of what it must NOT return. `overview` publishes org-wide costs,
   * the cash balance, the burn and the health score - none of which a
   * telecaller should see, and all of which `scope=user` would still compute
   * for the org-level fields. A narrower route with a narrower response is the
   * only version where the restriction is structural rather than a filter
   * somebody has to remember.
   *
   * It is still gated on `finance:view`, which 0172 deliberately does NOT seed
   * to `workspace_member` - so a telecaller reaches this through the console's
   * own "My performance" page, which calls it with the owner's key and their
   * own user id, exactly as the existing my-performance surface does.
   */
  @Get("my-money")
  @RequireCrmPermission("finance", "view")
  async myMoney(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = z
      .object({ userId: z.string().uuid(), from: DateOnly, to: DateOnly })
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const today = await orgToday(client);
      const totals = await computeTotals(
        client,
        orgId,
        { from: q.from, to: q.to },
        { scope: "user", scopeId: q.userId },
      );

      const { rows: payout } = await client.query<{
        period: string;
        calculated: string;
        adjustments: string;
        payable: string;
        status: string;
      }>(
        `SELECT to_char(period, 'YYYY-MM') AS period, calculated::text,
                adjustments::text, payable::text, status
           FROM incentive_payouts
          WHERE user_id = $1 AND period >= date_trunc('month', $2::date)
          ORDER BY period DESC`,
        [q.userId, q.from],
      );

      const { rows: dues } = await client.query<{ items: string; amount: string }>(
        `SELECT count(*)::text AS items,
                COALESCE(sum(ps.amount - ps.paid_amount), 0)::text AS amount
           FROM payment_schedules ps
           JOIN deals d ON d.id = ps.deal_id
          WHERE d.owner_user_id = $1
            AND ps.status <> 'cancelled' AND ps.paid_amount < ps.amount`,
        [q.userId],
      );

      return {
        period: { from: q.from, to: q.to },
        today,
        sold: toMajor(totals.bookedMinor),
        collected: toMajor(netCollected(totals)),
        collectionRate: collectionRate(totals),
        duesToChase: { items: Number(dues[0].items), amount: Number(dues[0].amount) },
        /**
         * §11's "projected vs confirmed". `calculated` is projected - it moves
         * as money arrives and until somebody approves it; `approved` and
         * `paid` are confirmed. Labelling them the same would have a rep
         * reading a number that can still go down as a promise.
         */
        incentive: payout.map((p) => ({
          period: p.period,
          amount: Number(p.payable),
          calculated: Number(p.calculated),
          adjustments: Number(p.adjustments),
          status: p.status,
          confirmed: p.status !== "calculated",
        })),
      };
    });
  }

  /**
   * The ledger itself: every posting in a window, with what it refers to.
   *
   * ── THIS IS WHAT MAKES §17's "RECONCILES TO THE LEDGER" CHECKABLE ─────────
   *
   * Every other number in this module is an aggregate. This is the rows they
   * are aggregates OF, in posting order, with the debit and credit sides
   * visible - so somebody who does not believe the collected figure can add
   * the cash column up themselves. A finance module whose audit trail is only
   * reachable by SQL has an audit trail nobody audits.
   */
  @Get("ledger")
  @RequireCrmPermission("finance", "view")
  async ledger(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = z
      .object({
        from: DateOnly,
        to: DateOnly,
        account: z.string().trim().max(40).optional(),
        refType: z.string().trim().max(40).optional(),
        refId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const rows = await readLedger(client, q);
      const { rows: balances } = await client.query<{
        account: string;
        debit: string;
        credit: string;
      }>(
        `SELECT account, sum(debit)::text AS debit, sum(credit)::text AS credit
           FROM ledger_entries
          WHERE posted_at::date BETWEEN $1::date AND $2::date
          GROUP BY account ORDER BY account`,
        [q.from, q.to],
      );

      return {
        period: { from: q.from, to: q.to },
        entries: rows.entries,
        total: rows.total,
        /**
         * §16's invariant, published: the sums per account, and whether the
         * whole window balances. A screen that shows this cannot quietly
         * disagree with the test that asserts it.
         */
        accounts: balances.map((b) => ({
          account: b.account,
          debit: Number(b.debit),
          credit: Number(b.credit),
          balance: Number(b.debit) - Number(b.credit),
        })),
        balanced:
          balances.reduce((s, b) => s + toMinor(b.debit), 0) ===
          balances.reduce((s, b) => s + toMinor(b.credit), 0),
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  /**
   * The same rows as CSV.
   *
   * ── WHY THIS IS THE ONE `finance:export` ROUTE ────────────────────────────
   *
   * A client's entire money history leaving the system is a different act from
   * reading it on a screen, and `finance:export` is the grant that says who
   * may do it - seeded to the three admin roles and not to `viewer`, which can
   * read everything and take nothing.
   *
   * It streams no further than a page: the limit is the same 1000, and a
   * tenant wanting a year goes through the export engine (0148), which exists
   * for exactly that and does it off the request thread. Building a second
   * unbounded exporter here is how an API process gets killed by a download.
   */
  @Get("ledger/export")
  @RequireCrmPermission("finance", "export")
  async ledgerCsv(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = z
      .object({
        from: DateOnly,
        to: DateOnly,
        account: z.string().trim().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(1000),
      })
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const { entries } = await readLedger(client, { ...parsed.data, offset: 0 });
      return {
        filename: `ledger-${parsed.data.from}-to-${parsed.data.to}.csv`,
        contentType: "text/csv",
        // `toCsv` from @aura/shared, the same helper every other export in the
        // product uses - so a cell containing a comma, a quote or a newline is
        // escaped the one way rather than the four ways four controllers would
        // invent.
        csv: toCsv(
          [
            { header: "Posted", value: (e) => e.postedAt.toISOString().slice(0, 10) },
            { header: "Posting", value: (e) => e.postingId },
            { header: "Account", value: (e) => e.account },
            { header: "Debit", value: (e) => (e.debit === 0 ? "" : e.debit) },
            { header: "Credit", value: (e) => (e.credit === 0 ? "" : e.credit) },
            { header: "Currency", value: (e) => e.currency },
            { header: "Refers to", value: (e) => e.refType },
            { header: "Reference", value: (e) => e.refId ?? "" },
            { header: "Reversal of", value: (e) => e.reversesId ?? "" },
            { header: "Memo", value: (e) => e.memo ?? "" },
            { header: "By", value: (e) => `${e.actorType}:${e.actorId ?? ""}` },
          ],
          entries,
        ),
      };
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Snapshots for complete days, live for today, summed.
   *
   * ── THE GAP CHECK IS WHAT MAKES THIS HONEST ────────────────────────────────
   *
   * If the snapshot rows do not cover the whole window - a nightly job that
   * did not run, a tenant enabled mid-period - the figures are computed live
   * for the WHOLE window instead of silently reporting a partial sum. A
   * dashboard that under-reports because a cron job failed is worse than a
   * slow one, because nothing on screen says anything is wrong.
   */
  private async totalsFor(
    client: Parameters<typeof computeTotals>[0],
    orgId: string,
    from: string,
    to: string,
    scope: { scope: SnapshotScope; scopeId: string | null },
    today: string,
  ): Promise<{ totals: FinanceTotals; computedAt: Date | null; live: boolean }> {
    const completeTo = to < today ? to : addDays(today, -1);

    if (completeTo >= from) {
      const snapshots = await readSnapshots(client, orgId, { from, to: completeTo }, scope);
      const expectedDays = daysBetween(from, completeTo) + 1;
      if (snapshots.totals.length === expectedDays) {
        const parts = [...snapshots.totals];
        if (to >= today) {
          parts.push(await computeTotals(client, orgId, { from: today, to }, scope));
        }
        return { totals: sumTotals(parts), computedAt: snapshots.computedAt, live: to >= today };
      }
    }

    return {
      totals: await computeTotals(client, orgId, { from, to }, scope),
      computedAt: null,
      live: true,
    };
  }

  /**
   * §11's freshness stamp: when the numbers were computed, and when each
   * connector last heard from its gateway.
   */
  private async freshness(
    client: Parameters<typeof computeTotals>[0],
    computedAt: Date | null,
    live: boolean,
  ): Promise<Freshness> {
    const { rows } = await client.query<{
      type: string;
      last_event_at: Date | null;
      status: string;
      consecutive_failures: number;
    }>(
      `SELECT type, last_event_at, status, consecutive_failures
         FROM connector_accounts ORDER BY type`,
    );
    return {
      computedAt,
      live,
      connectors: rows.map((r) => ({
        type: r.type,
        lastEventAt: r.last_event_at,
        healthy: r.status === "connected" && r.consecutive_failures === 0,
      })),
    };
  }

  /**
   * The cash balance, from the ledger.
   *
   * Debits minus credits on the `cash` account - which is the only place this
   * number can come from, and the reason the ledger exists. Not a bank
   * balance: this platform has no bank connection, so it is "cash this system
   * knows about", and the console labels it that way rather than implying a
   * statement has been reconciled.
   */
  private async cashBalance(
    client: Parameters<typeof computeTotals>[0],
    orgId: string,
  ): Promise<number> {
    const { rows } = await client.query<{ balance: string }>(
      `SELECT COALESCE(sum(debit) - sum(credit), 0)::text AS balance
         FROM ledger_entries WHERE org_id = $1 AND account = 'cash'`,
      [orgId],
    );
    return toMinor(rows[0].balance);
  }

  /** §12.6's leakage ratio: money at risk in open alerts ÷ collected. */
  private async leakageRatio(
    client: Parameters<typeof computeTotals>[0],
    collectedMinor: number,
  ): Promise<number | null> {
    if (collectedMinor <= 0) return null;
    const { rows } = await client.query<{ at_risk: string }>(
      `SELECT COALESCE(sum(amount_at_risk), 0)::text AS at_risk
         FROM advisor_alerts WHERE status IN ('open', 'acknowledged')`,
    );
    return toMinor(rows[0].at_risk) / collectedMinor;
  }

  private async subjectsFor(
    client: Parameters<typeof computeTotals>[0],
    by: "user" | "source" | "template",
  ): Promise<{ id: string; name: string }[]> {
    if (by === "user") {
      const { rows } = await client.query<{ id: string; name: string }>(
        `SELECT DISTINCT u.id, COALESCE(u.name, u.email) AS name
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.status = 'active'
          ORDER BY 2`,
      );
      return rows;
    }
    if (by === "source") {
      const { rows } = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM marketing_sources ORDER BY name`,
      );
      return rows;
    }
    const { rows } = await client.query<{ id: string; name: string }>(
      `SELECT id, name || ' v' || version AS name FROM deal_templates ORDER BY name`,
    );
    return rows;
  }
}

interface LedgerEntryView {
  id: string;
  postingId: string;
  account: string;
  debit: number;
  credit: number;
  currency: string;
  refType: string;
  refId: string | null;
  postedAt: Date;
  reversesId: string | null;
  memo: string | null;
  actorType: string;
  actorId: string | null;
}

/**
 * One query behind both the JSON read and the CSV, so the export cannot show
 * a different set of rows from the screen somebody checked it against.
 */
async function readLedger(
  client: Parameters<typeof computeTotals>[0],
  q: {
    from: string;
    to: string;
    account?: string;
    refType?: string;
    refId?: string;
    limit: number;
    offset: number;
  },
): Promise<{ entries: LedgerEntryView[]; total: number }> {
  const where = ["l.posted_at::date BETWEEN $1::date AND $2::date"];
  const params: unknown[] = [q.from, q.to];
  if (q.account) {
    params.push(q.account);
    where.push(`l.account = $${params.length}`);
  }
  if (q.refType) {
    params.push(q.refType);
    where.push(`l.ref_type = $${params.length}`);
  }
  if (q.refId) {
    params.push(q.refId);
    where.push(`l.ref_id = $${params.length}`);
  }
  params.push(q.limit, q.offset);

  const { rows } = await client.query<{
    id: string;
    posting_id: string;
    account: string;
    debit: string;
    credit: string;
    currency: string;
    ref_type: string;
    ref_id: string | null;
    posted_at: Date;
    reverses_id: string | null;
    memo: string | null;
    actor_type: string;
    actor_id: string | null;
    total: string;
  }>(
    `SELECT l.id, l.posting_id, l.account, l.debit::text, l.credit::text, l.currency,
            l.ref_type, l.ref_id, l.posted_at, l.reverses_id, l.memo,
            l.actor_type, l.actor_id, count(*) OVER() AS total
       FROM ledger_entries l
      WHERE ${where.join(" AND ")}
      -- Grouped by POSTING, so the two or three rows of one event stay
      -- together. Ordering by the timestamp alone would interleave two
      -- payments posted in the same second and make a double entry unreadable.
      ORDER BY l.posted_at DESC, l.posting_id, l.account
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    entries: rows.map((r) => ({
      id: r.id,
      postingId: r.posting_id,
      account: r.account,
      debit: Number(r.debit),
      credit: Number(r.credit),
      currency: r.currency,
      refType: r.ref_type,
      refId: r.ref_id,
      postedAt: r.posted_at,
      reversesId: r.reverses_id,
      memo: r.memo,
      actorType: r.actor_type,
      actorId: r.actor_id,
    })),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Re-exported for the tests that build a window without duplicating the maths. */
export { emptyTotals };
