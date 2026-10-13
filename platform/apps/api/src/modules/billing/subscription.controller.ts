import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  ADDONS,
  ADDON_KEYS,
  AUTO_TOPUP_DEFAULT_CAP_MINOR,
  BillingPeriod,
  CAPTURE_PLAN_ORDER,
  LIMIT_BEHAVIOURS,
  REGION_CURRENCY,
  readQuota,
  type AddonKey,
  type CapturePlanKey,
} from "@aura/shared";
import { readEffectiveLimits } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { BillingOrdersService } from "./billing-orders.service";

const CheckoutBody = z.object({
  planKey: z.enum(CAPTURE_PLAN_ORDER as unknown as [CapturePlanKey, ...CapturePlanKey[]]),
  period: BillingPeriod.default("annual"),
});

const TopupBody = z.object({
  addonKey: z.enum(ADDON_KEYS as unknown as [AddonKey, ...AddonKey[]]),
  units: z.number().int().positive().max(100).default(1),
});

const AutoTopupBody = z.object({
  enabled: z.boolean(),
  addonKey: z
    .enum(ADDON_KEYS as unknown as [AddonKey, ...AddonKey[]])
    .optional(),
  /** Minor units, in the tenant's own currency. Required to switch it on. */
  capMinor: z.number().int().positive().max(100_000_000).optional(),
});

/**
 * The owner's own billing surface: what they are on, what they are using, what
 * it would cost to change, and the two buttons that start a payment.
 *
 * ── OWNERS AND MANAGERS, NOT TELECALLERS ────────────────────────────────────
 *
 * `@RequireOwnerRole("owner", "manager")`, matching `plan-usage.controller.ts`:
 * a plan is the account manager's conversation. A telecaller seeing what the
 * workspace pays is not a security problem, but it is not their screen either,
 * and the quota numbers here are the same ones the owner is upsold on.
 *
 * ── NOTHING HERE GRANTS ANYTHING ────────────────────────────────────────────
 *
 * Every write in this file creates a `billing_orders` row. None of them
 * touches `org_subscriptions`, `enabled_modules` or a meter - those move only
 * on a verified webhook or an operator's Apply. So an owner cannot upgrade
 * themselves by starting a checkout they do not complete, which with no live
 * gateway is the only thing keeping the plan system meaningful.
 *
 * The one exception is `auto-topup`, which writes a PREFERENCE and a ceiling.
 * It grants no hours; it only permits a future order to be created without a
 * click, up to a limit the owner set themselves.
 */
@Controller("owner/billing")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class SubscriptionController {
  constructor(
    private readonly db: DbService,
    private readonly orders: BillingOrdersService,
  ) {}

  /**
   * The plan page's one read: the price list, this tenant's plan, their four
   * meters, their add-ons and what happens at each limit.
   *
   * One route rather than five, because the page draws them together and five
   * round trips to Seoul is 625ms of latency for a screen that is mostly
   * static (DB_LATENCY_MIGRATION.md: ~125ms each).
   */
  @Get("overview")
  async overview(@OrgId() orgId: string, @Query("period") periodRaw?: string) {
    const period = BillingPeriod.safeParse(periodRaw ?? "annual");
    const billingPeriod = period.success ? period.data : "annual";

    const admin = this.db.adminPool();
    const limits = await readEffectiveLimits(admin, orgId);

    // Live counts for the three meters that are counted rather than summed.
    // The handset count is `status = 'active' AND removed_at IS NULL`, which is
    // the same predicate the pairing cap applies - if these two ever disagree
    // the page tells an owner they have room they will then be refused.
    const {
      rows: [usage],
    } = await admin.query<{
      handsets: number;
      transcription_minutes: string;
      recording_bytes: string | null;
    }>(
      `SELECT (SELECT count(*)::int FROM devices
                WHERE org_id = $1 AND status = 'active' AND removed_at IS NULL)  AS handsets,
              -- The platform's UTC month, said explicitly: withOrgContext runs
              -- on the org's clock, and the budget month is a billing contract
              -- rather than a reporting view. The worker's ceiling check reads
              -- this same window, which is what makes this meter honest.
              (SELECT COALESCE(sum(quantity), 0)::text FROM usage_events
                WHERE org_id = $1
                  AND kind IN ('asr_minutes', 'asr_minutes_diarized')
                  AND occurred_at >= date_trunc('month', now(), 'UTC'))          AS transcription_minutes,
              (SELECT recording_bytes::text FROM org_storage_usage
                WHERE org_id = $1)                                               AS recording_bytes`,
      [orgId],
    );

    const { rows: addonRows } = await admin.query<{ addon_key: string; units: number }>(
      `SELECT addon_key, units FROM org_plan_addons WHERE org_id = $1 AND units > 0`,
      [orgId],
    );

    const {
      rows: [sub],
    } = await admin.query<{
      status: string | null;
      billing_period: string | null;
      current_period_end: Date | null;
      auto_topup_enabled: boolean | null;
      auto_topup_addon_key: string | null;
      auto_topup_cap_minor: string | null;
    }>(
      `SELECT status, billing_period, current_period_end,
              auto_topup_enabled, auto_topup_addon_key, auto_topup_cap_minor::text
         FROM org_subscriptions WHERE org_id = $1`,
      [orgId],
    );

    const usedMinutes = Number(usage?.transcription_minutes ?? 0);
    const usedBytes = Number(usage?.recording_bytes ?? 0);

    return {
      region: limits.region,
      currency: REGION_CURRENCY[limits.region],
      period: billingPeriod,
      plan: {
        key: limits.planKey,
        name: limits.planName,
        family: limits.family,
        status: sub?.status ?? null,
        billingPeriod: sub?.billing_period ?? "annual",
        currentPeriodEnd: sub?.current_period_end ?? null,
      },
      // The four meters, each as a reading the page can draw a bar from. Built
      // with `readQuota` rather than by dividing here, so the bar, the warning
      // banner and the code that refuses all agree about where the line is.
      meters: {
        handsets: readQuota(limits.handsets, usage?.handsets ?? 0),
        transcriptionMinutes: readQuota(limits.transcriptionMinutes, usedMinutes),
        storageBytes: readQuota(limits.storageCapBytes, usedBytes),
        audioRetentionDays: limits.audioRetentionDays,
        includedHours: limits.transcriptionHours,
        toppedUpHours: limits.toppedUpHours,
      },
      features: {
        speakerSeparation: limits.speakerSeparation,
        aiAnalysis: limits.aiAnalysis,
        transcriptionAllowed: limits.transcriptionAllowed,
      },
      // Why a tenant in an unsellable region records nothing. Surfaced rather
      // than left as silence: an owner whose handsets capture no audio deserves
      // the reason, and "the law in your country requires consent we cannot yet
      // capture" is a very different message from "something is broken".
      recordingProhibited: limits.recordingProhibited,
      addons: addonRows.map((row) => ({
        key: row.addon_key,
        units: row.units,
        name: ADDONS[row.addon_key as AddonKey]?.name ?? row.addon_key,
      })),
      autoTopup: {
        enabled: Boolean(sub?.auto_topup_enabled),
        addonKey: sub?.auto_topup_addon_key ?? null,
        capMinor: sub?.auto_topup_cap_minor === null || sub?.auto_topup_cap_minor === undefined
          ? null
          : Number(sub.auto_topup_cap_minor),
        defaultCapMinor: AUTO_TOPUP_DEFAULT_CAP_MINOR[limits.region],
      },
      // Empty for an Insights tenant: that is a different product with its own
      // rail at /owner/plan, and the page hides the whole card rather than
      // drawing a price list for something nobody here can buy.
      plans: this.orders.priceList(limits.region, billingPeriod, limits.family),
      topups: ADDON_KEYS.map((key) => ({
        key,
        name: ADDONS[key].name,
        kind: ADDONS[key].kind,
        grant: ADDONS[key].grant,
        entitlement: ADDONS[key].entitlement,
        priceMinor: ADDONS[key].priceMinor[limits.region],
        maxUnits: ADDONS[key].maxUnits,
      })),
      // What happens at each limit, from the one table three surfaces read.
      limitBehaviours: LIMIT_BEHAVIOURS,
    };
  }

  /** What a plan change would cost, before committing to it. */
  @Get("quote")
  async quote(
    @OrgId() orgId: string,
    @Query("planKey") planKey?: string,
    @Query("period") periodRaw?: string,
  ) {
    const parsed = CheckoutBody.safeParse({ planKey, period: periodRaw ?? "annual" });
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return {
      quote: await this.orders.quoteFor(orgId, parsed.data.planKey, parsed.data.period),
    };
  }

  /**
   * Start paying for a plan.
   *
   * Returns a gateway handle when one is configured and a `manual` notice
   * otherwise - and `manual` is a complete answer, not a failure. With no
   * platform keys the owner is told we will invoice them and the pending order
   * is what an operator settles.
   */
  @Post("checkout")
  async checkout(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = CheckoutBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.orders.create(orgId, actorUserId(auditActor(req)), {
      kind: "subscription",
      planKey: parsed.data.planKey,
      period: parsed.data.period,
    });
  }

  /** Buy an hour pack, an extra handset, extra storage or extra retention. */
  @Post("topup")
  async topup(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = TopupBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.orders.create(orgId, actorUserId(auditActor(req)), {
      kind: "addon",
      addonKey: parsed.data.addonKey,
      units: parsed.data.units,
    });
  }

  /**
   * Switch auto top-up on or off, with the owner's own monthly ceiling.
   *
   * The ceiling is mandatory to switch it on - the CHECK in 0197 enforces that
   * at the table so this route cannot forget - and only a `pack` add-on may be
   * automated. Auto-buying a recurring add-on would quietly raise a tenant's
   * monthly bill forever rather than cover one month's overage, which is not
   * what anybody means by a top-up.
   */
  @Patch("auto-topup")
  async setAutoTopup(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = AutoTopupBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { enabled, addonKey, capMinor } = parsed.data;

    if (enabled) {
      if (!addonKey || !capMinor) {
        throw new BadRequestException("auto top-up needs an hour pack and a monthly ceiling");
      }
      if (ADDONS[addonKey].kind !== "pack") {
        throw new BadRequestException("only an hour pack can be bought automatically");
      }
    }

    const { rowCount } = await this.db.adminPool().query(
      `UPDATE org_subscriptions
          SET auto_topup_enabled   = $2,
              auto_topup_addon_key = CASE WHEN $2 THEN $3 ELSE NULL END,
              auto_topup_cap_minor = CASE WHEN $2 THEN $4::bigint ELSE NULL END,
              updated_at           = now()
        WHERE org_id = $1`,
      [orgId, enabled, addonKey ?? null, capMinor ?? null],
    );
    // No subscription row means no plan, and a tenant with no plan has no
    // ceiling to top up past. Said rather than silently succeeding, because a
    // switch that reports "on" and does nothing is worse than a refusal.
    if (!rowCount) {
      throw new BadRequestException("this workspace is not on a plan yet");
    }
    return { enabled, addonKey: enabled ? addonKey : null, capMinor: enabled ? capMinor : null };
  }

  /** Their own order history, for a receipt or a question about a charge. */
  @Get("orders")
  async orderHistory(@OrgId() orgId: string) {
    const { rows } = await this.db.adminPool().query(
      `SELECT o.id, o.kind, p.key AS plan_key, o.addon_key, o.addon_units,
              o.currency, o.subtotal_minor::text, o.tax_minor::text, o.total_minor::text,
              o.tax_kind, o.tax_rate_bp, o.status, o.provider, o.auto,
              o.created_at, o.paid_at, o.lines
         FROM billing_orders o
         LEFT JOIN plans p ON p.id = o.plan_id
        WHERE o.org_id = $1
        ORDER BY o.created_at DESC
        LIMIT 100`,
      [orgId],
    );
    return { orders: rows };
  }
}
