import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import {
  ADDONS,
  type AddonKey,
  type BillingPeriod,
  type LifecycleStep,
  type OrgCommercialRow,
  type SubscriptionStatus,
  concentration,
  deltaBp,
  lifecycleWithDrop,
  orgMrr,
  summariseMrr,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OperatorOnlyGuard } from "../../common/operator-only.guard";
import {
  describeScope,
  isRootOperator,
  operatorScopeSql,
  scopeForRequest,
} from "../../common/operator-scope";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import {
  BILLINGS_BY_MONTH_SQL,
  CALL_ISSUE_LIVE_STATUSES,
  FLEET_COMMERCIAL_SQL,
  FUNNEL_SQL,
  NET_NEW_SQL,
  PLATFORM_INCIDENTS_SQL,
} from "./commercial-sql";

/**
 * THE COMMERCIAL VIEW OF THE PLATFORM (doc 49 P13c).
 *
 * ── WHAT WAS MISSING ───────────────────────────────────────────────────────
 *
 * The operator console's hub has seven fleet tiles - active users, tenants,
 * pipeline health, booking rate, calls, recorded time, devices - and not one
 * commercial number. Not revenue, MRR, plan mix, outstanding cash, churn,
 * trial conversion or revenue per tenant. For the operator of a SaaS those are
 * the numbers the screen exists to show.
 *
 * ── EVERY FIGURE CARRIES ITS EVIDENCE ──────────────────────────────────────
 *
 * Each tile and each series returns the sentence that says what was counted.
 * That is not documentation: a commercial number whose method is invisible gets
 * argued with instead of acted on, and three of the numbers here are weaker
 * than they look. Saying which, on the screen, is what makes the other nine
 * trustworthy - the same discipline the adoption screen uses for its probes.
 *
 * ── SCOPED, LIKE EVERY OTHER CROSS-TENANT READ ─────────────────────────────
 *
 * Through `operatorScopeSql` (doc 49 P13b), so a superadmin sees their own
 * book's revenue and the root sees the platform's. The honest limitation in
 * `operator-scope.ts` applies here exactly as it does elsewhere, and matters
 * more: this is the screen where "I can still reach it with the admin key"
 * means "I can still read a colleague's revenue".
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 *
 * It computes nothing it cannot source. Three of doc 49's requested figures
 * have no honest source in this schema, and each is delivered as the nearest
 * true thing under its true name rather than as the thing that was asked for:
 *
 *   - "MRR by month" -> BILLINGS by month. Nothing records a subscription's
 *     price over time, so a 12-month MRR series would be invented.
 *   - "Outstanding (overdue)" -> UNSETTLED. `billing_orders` has no due date,
 *     so nothing here knows what overdue means.
 *   - "Net new = signups - churn" -> the churn half is a labelled PROXY.
 *     Nothing records when a tenant churned.
 *
 * `commercial-sql.ts` carries the argument for each, and DEPLOYMENT.md §14 has
 * the one migration that would fix all three.
 */
@Controller("admin/commercial")
@UseGuards(AdminKeyGuard, TenantGuard, OperatorOnlyGuard)
@CrossTenant()
export class AdminCommercialController {
  constructor(private readonly db: DbService) {}

  @Get()
  async overview(@Req() req: PrincipalRequest) {
    const admin = this.db.adminPool();
    const scope = scopeForRequest(req);

    // One gate per query, each with its own parameter index. Written out rather
    // than computed in a loop so the index beside each query is readable
    // against the query itself - an off-by-one here binds an email into the
    // wrong placeholder, which is a 42P02 at best and a wrong filter at worst.
    const fleetGate = operatorScopeSql(scope, "o.id", 2); // $1 = live statuses
    const billingsGate = operatorScopeSql(scope, "o.id", 1);
    const funnelGate = operatorScopeSql(scope, "o.id", 1);
    const incidentsGate = operatorScopeSql(scope, "o.id", 2); // $1 = live statuses
    const netNewGate = operatorScopeSql(scope, "o.id", 1);

    const [fleet, billings, funnel, incidents, netNew, addonPrices, recurringAddons] =
      await Promise.all([
        admin.query<FleetRow>(FLEET_COMMERCIAL_SQL(fleetGate.sql), [
          [...CALL_ISSUE_LIVE_STATUSES],
          ...fleetGate.params,
        ]),
        admin.query<BillingMonthRow>(BILLINGS_BY_MONTH_SQL(billingsGate.sql), billingsGate.params),
        admin.query<FunnelRow>(FUNNEL_SQL(funnelGate.sql), funnelGate.params),
        admin.query<IncidentRow>(PLATFORM_INCIDENTS_SQL(incidentsGate.sql), [
          [...CALL_ISSUE_LIVE_STATUSES],
          ...incidentsGate.params,
        ]),
        admin.query<NetNewRow>(NET_NEW_SQL(netNewGate.sql), netNewGate.params),
        // The price list, read whole. Four rows per add-on at most, and
        // resolving prices in JavaScript keeps the fleet query from growing a
        // join whose only job is arithmetic the pure module already tests.
        admin.query<{ addon_key: string; region: string; price_minor: string }>(
          `SELECT addon_key, region, price_minor::text FROM plan_addon_prices`,
        ),
        admin.query<{ key: string }>(
          // Recurring only. A PACK is a credit spent inside one period, so
          // counting it as recurring revenue would book one top-up as a
          // permanent monthly increase.
          `SELECT key FROM plan_addons WHERE kind = 'recurring'`,
        ),
      ]);

    // ── the price lookups the arithmetic needs ────────────────────────────
    const priceByAddonRegion = new Map<string, number>();
    for (const r of addonPrices.rows) {
      priceByAddonRegion.set(`${r.addon_key}:${r.region}`, Number(r.price_minor));
    }
    const recurring = new Set(recurringAddons.rows.map((r) => r.key));
    // The catalogue in `pricing.ts` is the fallback for a database that has not
    // been seeded with the add-on rows yet - a real state on a fresh install,
    // and one where returning "every add-on is unpriced" would be alarming
    // rather than informative.
    const addonPriceMinor = (key: string, region: string): number | null => {
      const fromDb = priceByAddonRegion.get(`${key}:${region}`);
      if (fromDb !== undefined) return fromDb;
      const spec = ADDONS[key as AddonKey];
      if (!spec) return null;
      const listed = spec.priceMinor[region as "IN" | "AE"];
      return typeof listed === "number" ? listed : null;
    };
    const isRecurring = (key: string): boolean => {
      if (recurring.size > 0) return recurring.has(key);
      return ADDONS[key as AddonKey]?.kind === "recurring";
    };

    // ── per-client, which both the table and every total are built from ──
    const clients = fleet.rows.map((row) => {
      const commercial: OrgCommercialRow = {
        orgId: row.id,
        subStatus: (row.sub_status as SubscriptionStatus | null) ?? null,
        billingPeriod: (row.billing_period as BillingPeriod | null) ?? null,
        planKey: row.plan_key,
        annualMonthlyMinor:
          row.annual_monthly_minor === null ? null : Number(row.annual_monthly_minor),
        currency: row.currency,
        billingRegion: row.billing_region,
        addonUnits: row.addon_units,
      };
      const mrr = orgMrr(commercial, addonPriceMinor, isRecurring);

      // The capture ceiling, from the plan's own entitlements. Hours on the
      // plan, minutes in the meter - the conversion is here and once, because
      // comparing hours against minutes is a factor-of-sixty error that looks
      // like a tenant using 2% of their allowance.
      const hoursLimit = quotaLimit(row.entitlements, "transcription_hours_monthly");
      const usedMinutes = Number(row.capture_minutes ?? 0);

      return {
        orgId: row.id,
        name: row.name,
        status: row.status,
        region: row.billing_region,
        enabledModules: row.enabled_modules ?? [],
        createdAt: row.created_at,
        onboardedBy: row.onboarded_by_operator,
        onboardedByRole: row.onboarded_by_role,
        planKey: row.plan_key,
        planName: row.plan_name,
        planFamily: row.plan_family,
        subStatus: row.sub_status,
        billingPeriod: row.billing_period,
        currentPeriodEnd: row.current_period_end,
        trialEndsAt: row.trial_ends_at,
        mrr: { state: mrr.state, minor: mrr.minor, currency: mrr.currency },
        unpricedAddons: mrr.unpricedAddons,
        capture: {
          usedMinutes,
          // null means unlimited, and it is NEVER "unknown": a limit that
          // reads as unlimited by accident is a limit that does not hold.
          limitMinutes: hoursLimit === null ? null : hoursLimit * 60,
          overLimit: hoursLimit !== null && usedMinutes > hoursLimit * 60,
        },
        lastCallAt: row.last_call_at,
        // Per client, over the same 24 hours and the same audio-bearing
        // denominator the fleet tile uses.
        transcription24h: {
          audioCalls: row.audio_calls_24h,
          complete: row.complete_24h,
          rateBp:
            row.audio_calls_24h > 0
              ? Math.round((row.complete_24h / row.audio_calls_24h) * 10_000)
              : null,
        },
        unsettled: {
          orders: row.unsettled_orders,
          minor: Number(row.unsettled_minor ?? 0),
          oldestAt: row.oldest_unsettled_at,
        },
        lastOrderStatus: row.last_order_status,
        openIncidents: row.open_incidents,
      };
    });

    // ── Row 1 ─────────────────────────────────────────────────────────────
    const mrrSummary = summariseMrr(
      clients.map((c) => ({
        state: c.mrr.state,
        minor: c.mrr.minor,
        currency: c.mrr.currency,
        unpricedAddons: c.unpricedAddons,
      })),
    );

    const unsettledTotal = clients.reduce((a, c) => a + c.unsettled.minor, 0);
    const unsettledOrders = clients.reduce((a, c) => a + c.unsettled.orders, 0);
    const oldestUnsettled = clients
      .map((c) => c.unsettled.oldestAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

    const captureClients = clients.filter((c) => c.capture.limitMinutes !== null);
    const net = netNew.rows[0]!;

    // ── Row 2 ─────────────────────────────────────────────────────────────
    const months = [...new Set(billings.rows.map((r) => r.month))].sort();
    const billingsByMonth = months.map((month) => {
      const rows = billings.rows.filter((r) => r.month === month);
      return {
        month,
        byPlan: rows.map((r) => ({
          planKey: r.plan_key,
          currency: r.currency,
          minor: Number(r.minor),
          orders: r.orders,
        })),
        // Per currency, because adding INR to AED produces a number that is
        // not money.
        totalsByCurrency: [...new Set(rows.map((r) => r.currency))].map((currency) => ({
          currency,
          minor: rows
            .filter((r) => r.currency === currency)
            .reduce((a, r) => a + Number(r.minor), 0),
        })),
      };
    });

    const f = funnel.rows[0]!;
    const lifecycle: LifecycleStep[] = [
      {
        key: "provisioned",
        label: "Provisioned",
        count: f.provisioned,
        evidence: "organizations rows in this book",
      },
      {
        key: "first_call",
        label: "First call",
        count: f.first_call,
        evidence: "has at least one calls row",
      },
      {
        key: "first_transcript",
        label: "First transcript",
        count: f.first_transcript,
        evidence: "has at least one call that reached COMPLETE",
      },
      {
        key: "first_lead",
        label: "First lead",
        count: f.first_lead,
        evidence: "has at least one leads row",
      },
      {
        key: "renewed",
        label: "Renewed",
        count: f.renewed,
        evidence: "two or more paid subscription orders",
      },
    ];

    // Concentration over recurring revenue only, and per currency for the same
    // reason every other total is: a share computed over a mixed-currency
    // denominator is not a share of anything.
    const concentrationByCurrency = mrrSummary.byCurrency.map((c) => ({
      currency: c.currency,
      ...(concentration(
        clients
          .filter((x) => x.mrr.state === "recurring" && x.mrr.currency === c.currency)
          .map((x) => x.mrr.minor),
      ) ?? { largestBp: 0, topThreeBp: 0, clients: 0 }),
      largest:
        clients
          .filter((x) => x.mrr.state === "recurring" && x.mrr.currency === c.currency)
          .sort((a, b) => b.mrr.minor - a.mrr.minor)
          .map((x) => ({ name: x.name, minor: x.mrr.minor }))[0] ?? null,
    }));

    // ── Row 3 ─────────────────────────────────────────────────────────────
    const audio24h = clients.reduce((a, c) => a + c.transcription24h.audioCalls, 0);
    const complete24h = clients.reduce((a, c) => a + c.transcription24h.complete, 0);

    return {
      scope: scope.kind,
      scopeNote: describeScope(scope),
      // Root-only controls are decided HERE, not in the browser: a console that
      // renders a control and refuses it is a console that taught somebody the
      // boundary by refusing them. Doc 49 is explicit - a superadmin must not
      // see "Invite a superadmin" at all, absent rather than disabled, because
      // a greyed-out control is an invitation to find out why.
      isRoot: isRootOperator(req.principal?.operatorEmail ?? null),

      mrr: {
        ...mrrSummary,
        evidence:
          "org_subscriptions joined to the published price list, ex-tax. Monthly-billed " +
          "tenants carry the 20% uplift the checkout charges. Trials, cancellations and " +
          "plans with no published price contribute nothing and are counted separately.",
      },
      clientCounts: {
        total: clients.length,
        active: clients.filter((c) => c.status === "active").length,
        suspended: clients.filter((c) => c.status === "suspended").length,
        churned: clients.filter((c) => c.status === "churned").length,
      },
      netNew: {
        newThisMonth: net.new_this_month,
        newLastMonth: net.new_last_month,
        deltaBp: deltaBp(net.new_this_month, net.new_last_month),
        churnedThisMonth: net.churned_this_month_proxy,
        churnedTotal: net.churned_total,
        net: net.new_this_month - net.churned_this_month_proxy,
        // Said on the screen, not buried here.
        churnIsProxy: true,
        evidence:
          "New: organizations.created_at this UTC month. Churned: a PROXY - subscriptions " +
          "now cancelled whose row was last touched this month. Nothing records when a " +
          "tenant churned, so this is an upper bound rather than a count.",
      },
      unsettled: {
        minor: unsettledTotal,
        orders: unsettledOrders,
        oldestAt: oldestUnsettled,
        evidence:
          "billing_orders with status 'pending' - what clients owe US. NOT the invoices " +
          "table, which is a tenant invoicing their own customers. These orders carry no " +
          "due date, so this is UNSETTLED, not overdue.",
      },
      capture: {
        clientsWithLimit: captureClients.length,
        usedMinutes: captureClients.reduce((a, c) => a + c.capture.usedMinutes, 0),
        limitMinutes: captureClients.reduce((a, c) => a + (c.capture.limitMinutes ?? 0), 0),
        overLimit: captureClients.filter((c) => c.capture.overLimit).length,
        // Under a quarter used, with a week of the month left. Margin leaks
        // both ways and this is the direction nobody looks at: a tenant using
        // 10% of what they bought is a renewal conversation, not a good month.
        under25pct: captureClients.filter(
          (c) => c.capture.limitMinutes! > 0 && c.capture.usedMinutes / c.capture.limitMinutes! < 0.25,
        ).length,
        evidence:
          "usage_events asr_minutes + asr_minutes_diarized this UTC month, against the " +
          "plan's transcription_hours_monthly. The same window the tenant's own billing " +
          "page shows and the worker's ceiling enforces.",
      },

      billingsByMonth: {
        months: billingsByMonth,
        evidence:
          "Paid billing_orders by the month they were paid. BILLINGS, not MRR: nothing " +
          "records a subscription's price over time, so an annual payment lands as one " +
          "tall month rather than spread across twelve.",
      },
      lifecycle: {
        steps: lifecycleWithDrop(lifecycle),
        paidNeverProvisioned: f.paid_never_provisioned,
        evidence:
          "Starts at PROVISIONED, not at signup: an operator-provisioned tenant has no " +
          "org_signups row, so a funnel starting at signup would climb. Paid-but-never- " +
          "provisioned is reported beside it and is platform-wide, because those rows " +
          "have no org to scope by.",
      },
      concentration: {
        byCurrency: concentrationByCurrency,
        evidence: "Share of recurring MRR, per currency. Trials and unpriced plans excluded.",
      },

      transcription24h: {
        audioCalls: audio24h,
        complete: complete24h,
        rateBp: audio24h > 0 ? Math.round((complete24h / audio24h) * 10_000) : null,
        evidence:
          "Calls started in the last 24 hours, NO_AUDIO excluded from both halves: a " +
          "missed-call log entry has no recording to transcribe, and counting it would " +
          "dilute the rate with calls that were never candidates.",
      },
      incidents: {
        rows: incidents.rows.map((r) => ({
          category: r.category,
          reason: r.platform_reason,
          tickets: r.tickets,
          occurrences: r.occurrences,
          oldestAt: r.oldest_at,
          latestAt: r.latest_at,
        })),
        tickets: incidents.rows.reduce((a, r) => a + r.tickets, 0),
        occurrences: incidents.rows.reduce((a, r) => a + r.occurrences, 0),
        evidence:
          "Live source='system' tickets from the escalation queue, with occurrence_count " +
          "SUMMED rather than tickets counted: one recurring platform failure is folded " +
          "into a single ticket, so counting tickets would report a 2,792-call outage as " +
          "one incident.",
      },

      clients,
    };
  }
}

/**
 * A quota's limit out of a plan's `plan_entitlements.value` blob.
 *
 * `null` for unlimited AND for absent, which is correct for this screen and
 * would not be for enforcement: here an absent limit means there is nothing to
 * draw a bar against, and a bar against an invented ceiling is worse than no
 * bar. Enforcement reads the same blob through `effectiveLimits`, which treats
 * the two differently on purpose.
 */
function quotaLimit(entitlements: Record<string, unknown> | null, key: string): number | null {
  const value = entitlements?.[key];
  if (!value || typeof value !== "object") return null;
  const limit = (value as { limit?: unknown }).limit;
  return typeof limit === "number" ? limit : null;
}

interface FleetRow {
  id: string;
  name: string;
  status: string;
  billing_region: string;
  enabled_modules: string[] | null;
  created_at: Date;
  onboarded_by_operator: string | null;
  onboarded_by_role: string | null;
  sub_status: string | null;
  billing_period: string | null;
  current_period_end: Date | null;
  trial_ends_at: Date | null;
  plan_key: string | null;
  plan_name: string | null;
  plan_family: string | null;
  annual_monthly_minor: string | null;
  currency: string | null;
  addon_units: Record<string, number> | null;
  entitlements: Record<string, unknown> | null;
  capture_minutes: string | null;
  last_call_at: Date | null;
  audio_calls_24h: number;
  complete_24h: number;
  unsettled_orders: number;
  unsettled_minor: string | null;
  oldest_unsettled_at: Date | null;
  last_order_status: string | null;
  open_incidents: number;
}

interface BillingMonthRow {
  month: string;
  plan_key: string;
  currency: string;
  minor: string;
  orders: number;
}

interface FunnelRow {
  provisioned: number;
  first_call: number;
  first_transcript: number;
  first_lead: number;
  renewed: number;
  paid_never_provisioned: number;
}

interface IncidentRow {
  category: string;
  platform_reason: string | null;
  tickets: number;
  occurrences: number;
  oldest_at: Date | null;
  latest_at: Date | null;
}

interface NetNewRow {
  new_this_month: number;
  new_last_month: number;
  churned_this_month_proxy: number;
  churned_total: number;
}
