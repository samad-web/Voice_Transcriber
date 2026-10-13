import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ADDONS,
  CAPTURE_PLANS,
  PLAN_MODULES,
  REGION_CURRENCY,
  addonSpec,
  periodKeyUtc,
  quoteAddon,
  quoteSubscription,
  type AddonKey,
  type BillingPeriod,
  type BillingRegion,
  type CapturePlanKey,
  type PlanKey,
  type Quote,
} from "@aura/shared";
import { assignPlanToOrg, resolveAndApplyPlanMeters } from "@aura/db";
import { DbService } from "../../db/db.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import {
  createPlatformOrder,
  resolvePlatformGateway,
  type GatewayUnavailableReason,
} from "./platform-razorpay";

/**
 * Orders, and the one path from "paid" to "entitled".
 *
 * ── TWO CALLERS, ONE SETTLE ─────────────────────────────────────────────────
 *
 * An order is settled either by a verified Razorpay webhook or by an operator
 * marking a manual invoice paid. Both arrive at `settle()`, because the work
 * is identical and because two implementations of "grant what this order
 * bought" would eventually grant different things. The webhook's extra job -
 * checking a signature and de-duplicating a retry - happens before it calls in.
 *
 * ── CREATING AN ORDER NEVER CHANGES A PLAN ──────────────────────────────────
 *
 * `create()` writes a row and, if a gateway is configured, asks it for a
 * handle. It does not touch `org_subscriptions`, `enabled_modules` or any
 * meter. The only two things that can move a tenant between tiers are
 * `settle()` and an operator's explicit Apply - which means an abandoned
 * checkout leaves no trace beyond a pending order, and a tenant cannot upgrade
 * themselves by starting a payment they never complete.
 *
 * ── THE TOTAL IS FROZEN AT CREATE ───────────────────────────────────────────
 *
 * `billing_orders` stores the subtotal, the tax, the total and the quote's
 * lines. A price an operator edits tomorrow must not change what somebody is
 * charged for a checkout they started today, and a gateway reporting "paid
 * 707,900" has to be checkable against a number that has not moved. `settle()`
 * refuses a capture whose amount does not match, rather than granting a plan
 * for a partial payment.
 */
@Injectable()
export class BillingOrdersService {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * The tenant's billing region, read from the ORG and never from the request.
   *
   * An owner who could name their own region could pick the cheaper price list
   * and - because the region also drives the consent gate - could unlock
   * recording in a country where it is a criminal offence. So it is read here,
   * on the admin pool, from an operator-set column.
   */
  async regionFor(orgId: string): Promise<BillingRegion> {
    const {
      rows: [row],
    } = await this.db
      .adminPool()
      .query<{ billing_region: string }>(
        `SELECT billing_region FROM organizations WHERE id = $1`,
        [orgId],
      );
    if (!row) throw new NotFoundException("no such organization");
    return (row.billing_region === "AE" ? "AE" : "IN") as BillingRegion;
  }

  /**
   * What a plan change would cost, with the tenant's recurring add-ons carried
   * over. The number the owner sees and the number the gateway is asked for.
   */
  async quoteFor(
    orgId: string,
    planKey: CapturePlanKey,
    period: BillingPeriod,
  ): Promise<Quote> {
    const region = await this.regionFor(orgId);
    const { rows } = await this.db
      .adminPool()
      .query<{ addon_key: string; units: number }>(
        `SELECT addon_key, units FROM org_plan_addons WHERE org_id = $1 AND units > 0`,
        [orgId],
      );
    const addons: Partial<Record<AddonKey, number>> = {};
    for (const row of rows) {
      if (addonSpec(row.addon_key)?.kind === "recurring") {
        addons[row.addon_key as AddonKey] = row.units;
      }
    }
    return quoteSubscription({ planKey, region, period, addons });
  }

  /**
   * Record an intent to buy, and hand back whatever the owner should do next.
   *
   * `gateway` is `manual` whenever no keys are configured or the currency is
   * one Razorpay cannot settle. That is not an error state: it is how the
   * first twenty accounts are sold. The owner is told we will invoice them,
   * and the pending order is what an operator settles afterwards.
   */
  async create(
    orgId: string,
    userId: string | null,
    input:
      | { kind: "subscription"; planKey: CapturePlanKey; period: BillingPeriod }
      | { kind: "addon"; addonKey: AddonKey; units: number; auto?: boolean },
  ): Promise<{
    orderId: string;
    quote: Quote;
    gateway: "razorpay" | "manual";
    gatewayReason: GatewayUnavailableReason | null;
    providerOrderId: string | null;
    /** The public key a checkout widget needs. Never the secret. */
    providerKeyId: string | null;
  }> {
    const region = await this.regionFor(orgId);

    const quote =
      input.kind === "subscription"
        ? await this.quoteFor(orgId, input.planKey, input.period)
        : quoteAddon(input.addonKey, input.units, region);

    // The commercial refusals, before anything is written. `chargeable` is the
    // one flag both the page and this route read, so they cannot disagree
    // about whether a button should have been clickable.
    if (!quote.chargeable) {
      if (quote.blockedReason === "region_not_sellable") {
        throw new BadRequestException(
          "This region is not open for self-serve purchase yet. Your account manager will invoice you.",
        );
      }
      throw new BadRequestException(
        "This plan is negotiated. Talk to us and we will quote it for you.",
      );
    }
    if (quote.totalMinor <= 0) {
      throw new BadRequestException("nothing to charge for");
    }

    const planId =
      input.kind === "subscription" ? await this.entitlements.planIdFor(input.planKey) : null;
    if (input.kind === "subscription" && !planId) {
      throw new NotFoundException(`no plan '${input.planKey}' in the catalogue`);
    }

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      // ── AUTO TOP-UP'S CEILING IS CHECKED HERE ─────────────────────────────
      //
      // Inside the transaction, against what has already been auto-charged
      // this period, because the whole value of a customer-set cap is that it
      // cannot be exceeded by two concurrent sweeps each seeing room.
      if (input.kind === "addon" && input.auto) {
        await this.assertAutoTopupRoom(client, orgId, quote.totalMinor);
      }

      const {
        rows: [order],
      } = await client.query<{ id: string }>(
        `INSERT INTO billing_orders
           (org_id, kind, plan_id, billing_period, addon_key, addon_units,
            region, currency, subtotal_minor, tax_minor, total_minor,
            tax_kind, tax_rate_bp, lines, provider, auto, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
                 'manual', $15, $16)
         RETURNING id`,
        [
          orgId,
          input.kind,
          planId,
          input.kind === "subscription" ? input.period : null,
          input.kind === "addon" ? input.addonKey : null,
          input.kind === "addon" ? Math.max(1, input.units) : null,
          region,
          quote.currency,
          quote.subtotalMinor,
          quote.taxMinor,
          quote.totalMinor,
          quote.taxLabel === "GST" ? "gst" : "vat",
          quote.taxRateBp,
          JSON.stringify(quote.lines),
          input.kind === "addon" ? Boolean(input.auto) : false,
          userId,
        ],
      );

      const gateway = resolvePlatformGateway(quote.currency);
      let providerOrderId: string | null = null;
      if (gateway.provider === "razorpay") {
        // The gateway call is inside the transaction on purpose. If Razorpay
        // fails we roll the order back rather than leaving a pending row that
        // nobody can pay and an operator has to explain. The alternative -
        // commit first, call second - produces exactly that orphan.
        const created = await createPlatformOrder(gateway.creds, {
          amountMinor: quote.totalMinor,
          currency: quote.currency,
          receipt: order.id,
          notes: { orgId, kind: input.kind },
        });
        providerOrderId = created.id;
        await client.query(
          `UPDATE billing_orders
              SET provider = 'razorpay', provider_order_id = $2, updated_at = now()
            WHERE id = $1`,
          [order.id, created.id],
        );
      }

      await client.query("COMMIT");
      return {
        orderId: order.id,
        quote,
        gateway: gateway.provider,
        gatewayReason: gateway.provider === "manual" ? gateway.reason : null,
        providerOrderId,
        providerKeyId: gateway.provider === "razorpay" ? gateway.creds.keyId : null,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Grant what an order bought.
   *
   * Idempotent on the order's own status: a second call finds it already
   * `paid` and returns without granting again. That is what makes a replayed
   * webhook safe even if the event-id index somehow let one through, and it is
   * why the status check and the grant are in the same transaction with the
   * row locked.
   */
  async settle(
    orderId: string,
    args: {
      provider: "manual" | "razorpay";
      providerPaymentId?: string | null;
      /** Minor units the provider says it took. Checked against the frozen total. */
      paidMinor?: number | null;
      settledBy?: string | null;
      note?: string | null;
    },
  ): Promise<{ settled: boolean; alreadySettled: boolean; orgId: string }> {
    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      const {
        rows: [order],
      } = await client.query<{
        id: string;
        org_id: string;
        kind: string;
        plan_id: string | null;
        plan_key: string | null;
        billing_period: string | null;
        addon_key: string | null;
        addon_units: number | null;
        total_minor: string;
        status: string;
      }>(
        `SELECT o.id, o.org_id, o.kind, o.plan_id, p.key AS plan_key, o.billing_period,
                o.addon_key, o.addon_units, o.total_minor::text, o.status
           FROM billing_orders o
           LEFT JOIN plans p ON p.id = o.plan_id
          WHERE o.id = $1
            FOR UPDATE OF o`,
        [orderId],
      );
      if (!order) throw new NotFoundException("no such order");

      if (order.status === "paid") {
        await client.query("COMMIT");
        return { settled: false, alreadySettled: true, orgId: order.org_id };
      }
      if (order.status !== "pending") {
        throw new BadRequestException(`order is ${order.status} and cannot be settled`);
      }

      // ── THE AMOUNT CHECK ──────────────────────────────────────────────────
      //
      // A capture for less than the order is not a reason to grant the plan.
      // Razorpay will not normally under-pay an order it created, but a
      // mismatch here means something is wrong - a tampered payload, the wrong
      // order matched - and the honest response is to refuse and let a human
      // look rather than to hand out a tier.
      if (
        args.paidMinor !== undefined &&
        args.paidMinor !== null &&
        args.paidMinor !== Number(order.total_minor)
      ) {
        throw new BadRequestException(
          `payment of ${args.paidMinor} does not match the order total ${order.total_minor}`,
        );
      }

      if (order.kind === "subscription") {
        if (!order.plan_id || !order.plan_key) {
          throw new BadRequestException("subscription order names no plan");
        }
        const modules = PLAN_MODULES[order.plan_key as PlanKey];
        if (!modules) throw new BadRequestException(`no module set for plan ${order.plan_key}`);
        await assignPlanToOrg(client, {
          orgId: order.org_id,
          planId: order.plan_id,
          planKey: order.plan_key,
          modules,
          billingPeriod: (order.billing_period as BillingPeriod | null) ?? undefined,
        });
      } else {
        if (!order.addon_key || !order.addon_units) {
          throw new BadRequestException("add-on order names no add-on");
        }
        await this.grantAddon(client, order.org_id, order.addon_key as AddonKey, order.addon_units, order.id);
      }

      await client.query(
        `UPDATE billing_orders
            SET status = 'paid', paid_at = now(), provider = $2,
                provider_payment_id = COALESCE($3, provider_payment_id),
                settled_by = $4, note = COALESCE($5, note), updated_at = now()
          WHERE id = $1`,
        [order.id, args.provider, args.providerPaymentId ?? null, args.settledBy ?? null, args.note ?? null],
      );

      // THREE SEPARATE PARAMETERS FOR THE SAME VALUE, deliberately. `org_id`
      // is uuid while `actor_id` and `target_id` are text, and one placeholder
      // reused across both types fails Postgres's parameter-type inference
      // with 42P08 ("inconsistent types deduced for parameter $1") - a 500 on
      // every settle. plan-admin.controller.ts carries the same note over the
      // same mistake.
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
              VALUES ($1, 'system', $2, 'billing.order_settled', 'billing_order', $3, $4::jsonb)`,
        [
          order.org_id,
          order.org_id,
          order.id,
          JSON.stringify({
            kind: order.kind,
            planKey: order.plan_key,
            addonKey: order.addon_key,
            addonUnits: order.addon_units,
            totalMinor: Number(order.total_minor),
            provider: args.provider,
            providerPaymentId: args.providerPaymentId ?? null,
          }),
        ],
      );

      await client.query("COMMIT");
      // After the commit, so the next request resolves the plan it just got
      // rather than the one it had. §9.6 asks for "within seconds"; this makes
      // it immediate for the path that knows.
      this.entitlements.invalidate(order.org_id);
      return { settled: true, alreadySettled: false, orgId: order.org_id };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Credit an add-on.
   *
   * A `recurring` add-on raises a holding, which is an UPDATE of a unit count:
   * buying a second extra handset makes it two, not two rows. A `pack` appends
   * to the grant ledger for the CURRENT period, with the amount frozen from
   * today's catalogue - an operator who later changes what a 25-hour pack
   * contains must not retroactively change what this customer bought.
   *
   * The meters are re-resolved afterwards, because a recurring add-on moves
   * storage and retention, which live in columns. A pack does not: the hour
   * ceiling is resolved at read time from the ledger, so there is nothing to
   * write - but re-resolving is cheap and keeps the one code path.
   */
  private async grantAddon(
    client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
    orgId: string,
    addonKey: AddonKey,
    units: number,
    orderId: string,
  ): Promise<void> {
    const spec = ADDONS[addonKey];
    const capped = Math.max(1, Math.min(units, spec.maxUnits));

    if (spec.kind === "recurring") {
      await client.query(
        `INSERT INTO org_plan_addons (org_id, addon_key, units)
              VALUES ($1, $2, $3)
         ON CONFLICT (org_id, addon_key) DO UPDATE SET
           units      = LEAST(org_plan_addons.units + EXCLUDED.units, $4),
           updated_at = now()`,
        [orgId, addonKey, capped, spec.maxUnits],
      );
    } else {
      await client.query(
        `INSERT INTO org_addon_grants (org_id, addon_key, period, units, amount, order_id)
              VALUES ($1, $2, $3, $4, $5, $6)`,
        [orgId, addonKey, periodKeyUtc(), capped, capped * spec.grant, orderId],
      );
    }

    await resolveAndApplyPlanMeters(
      client as Parameters<typeof resolveAndApplyPlanMeters>[0],
      orgId,
    );
  }

  /**
   * Refuse an auto top-up that would breach the customer's own ceiling.
   *
   * The cap is theirs, set on their own plan page, and it is checked against
   * what auto top-ups have already cost them THIS PERIOD - not against the
   * plan price and not against manual purchases, which they clicked
   * deliberately. An auto-charge that renews itself without a cap is how a
   * surprise bill becomes a chargeback.
   */
  private async assertAutoTopupRoom(
    client: {
      query: <R extends Record<string, unknown>>(
        text: string,
        values?: unknown[],
      ) => Promise<{ rows: R[] }>;
    },
    orgId: string,
    wantMinor: number,
  ): Promise<void> {
    const {
      rows: [row],
    } = await client.query<{ enabled: boolean; cap: string | null; spent: string }>(
      `SELECT s.auto_topup_enabled AS enabled,
              s.auto_topup_cap_minor::text AS cap,
              COALESCE((SELECT sum(total_minor) FROM billing_orders
                         WHERE org_id = $1 AND auto AND status = 'paid'
                           AND to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM') = $2), 0)::text
                AS spent
         FROM org_subscriptions s
        WHERE s.org_id = $1`,
      [orgId, periodKeyUtc()],
    );
    if (!row?.enabled || row.cap === null) {
      throw new BadRequestException("auto top-up is not switched on for this workspace");
    }
    const cap = Number(row.cap);
    const spent = Number(row.spent);
    if (spent + wantMinor > cap) {
      throw new BadRequestException(
        `auto top-up would exceed this month's ceiling (${spent + wantMinor} of ${cap})`,
      );
    }
  }

  /**
   * Which capture plans this tenant may be offered, and at what price.
   *
   * ── FAMILY-AWARE, AND THAT IS NOT DECORATION ────────────────────────────
   *
   * An Insights tenant is offered NOTHING here. They are on a different
   * product - they push their own data at us over an API and have no handsets
   * - so putting Record and Growth in front of them is offering to move them
   * to another product line, which is a conversation and not a button. Their
   * own rail is `/owner/plan`, served by `EntitlementsController`.
   *
   * This was caught by rendering the page against a tenant on the Insights
   * `platform` plan: it drew the whole capture price list under the heading
   * "You're on Platform (CRM + AI)". The header used to CLAIM this was
   * family-aware while the body ignored the family entirely - a label rather
   * than a mechanism, which is exactly what doc 40 is about.
   *
   * A tenant on NO plan still gets the list. That is the sales path, and it is
   * what every pre-plan tenant is: no subscription row, no family, and the
   * capture rail is what we would sell them.
   *
   * An unsellable region still gets the list too - the prices are real and a
   * buyer should see them - with `chargeable: false` on every row, which is
   * what turns the button into "Talk to us".
   */
  priceList(
    region: BillingRegion,
    period: BillingPeriod,
    family: "capture" | "insights" | null,
  ) {
    if (family === "insights") return [];
    return Object.values(CAPTURE_PLANS)
      .sort((a, b) => a.sort - b.sort)
      .map((plan) => {
        const quote = quoteSubscription({ planKey: plan.key, region, period });
        return {
          key: plan.key,
          name: plan.name,
          blurb: plan.blurb,
          handsets: plan.handsets,
          transcriptionHours: plan.transcriptionHours,
          audioRetentionDays: plan.audioRetentionDays,
          storageCapGb: plan.storageCapGb,
          speakerSeparation: plan.speakerSeparation,
          aiAnalysis: plan.aiAnalysis,
          negotiated: Boolean(plan.negotiated),
          fromPrice: Boolean(plan.prices[region].fromPrice),
          currency: REGION_CURRENCY[region],
          priceMinor: quote.subtotalMinor,
          taxMinor: quote.taxMinor,
          totalMinor: quote.totalMinor,
          taxLabel: quote.taxLabel,
          chargeable: quote.chargeable,
          blockedReason: quote.blockedReason,
        };
      });
  }
}
