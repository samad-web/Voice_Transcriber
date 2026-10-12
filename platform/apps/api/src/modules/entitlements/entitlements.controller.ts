import {
  BadRequestException,
  Body,
  ConflictException,
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
  ENTITLEMENTS,
  INSIGHTS_DEFAULTS,
  InsightsSettingsInput,
  PLAN_ORDER,
  type PlanKey,
  resolveInsightsSettings,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { EntitlementsService } from "./entitlements.service";

/** §9.7: at most one in-app upsell banner per user per week. */
const UPSELL_CAP_DAYS = 7;
/** §9.5/§16: 14 days of the next plan up, one trial per org per plan. */
const TRIAL_DAYS = 14;

const PlanRequestBody = z.object({
  kind: z.enum(["upgrade", "downgrade", "cancel", "demo"]),
  planKey: z.enum(PLAN_ORDER as [PlanKey, ...PlanKey[]]).optional(),
  note: z.string().trim().max(2000).optional(),
});

const ImpressionBody = z.object({
  triggerKey: z.string().trim().min(1).max(80),
  surface: z.string().trim().min(1).max(80),
  action: z.enum(["dismissed", "clicked", "upgraded"]).optional(),
});

/**
 * The plan, the usage against it, and the four things an owner can do about it
 * (`Build docs/no-crm-api-dashboard-build-plan.md` §8.10, §9).
 *
 * ── EVERY ROUTE HERE IS OWNER-PERSONA, AND THAT IS §9.7 ─────────────────────
 *
 * "Upsell visible only to Owner and Admin; telecallers and viewers never see
 * any upsell or billing." That guardrail is enforced HERE, at the API, and not
 * by hiding a nav entry - a nav entry is a hint and a route is the product.
 *
 * `@RequireOwnerRole("owner")` is the whole mechanism. Note what it is NOT: the
 * `insights_plan` feature switch does not gate it. A switch a client can throw
 * is not an access control, and conflating the two is how a telecaller ends up
 * looking at an invoice because somebody left a feature on.
 *
 * ── NOTHING HERE CHARGES ANYBODY ────────────────────────────────────────────
 *
 * The project owner's decision, 2026-10-10: there is no Razorpay account yet.
 * An upgrade is a `plan_change_requests` row an operator applies in /admin. No
 * price is read from code, and `plans.price_minor` is null on every seeded row,
 * which is what makes the Compare-plans CTA "Talk to us". When a provider
 * exists, its webhook resolves the same row and nothing else changes - see
 * INSIGHTS_TIER_DECISIONS §6.
 */
@Controller("insights")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
export class EntitlementsController {
  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Everything §8.10 and §9.1 need, in one payload.
   *
   * One route rather than three, because the Compare-plans page shows the
   * customer's own usage NEXT TO the limits of the plan above - "You use 41 of
   * 50" is the whole point of §9.1, and splitting it would mean the page
   * renders two half-answers and waits.
   */
  @Get("plan")
  @RequireOwnerRole("owner")
  async plan(@OrgId() orgId: string) {
    const [{ plan, meters }, catalogue] = await Promise.all([
      this.entitlements.usageReport(orgId),
      this.planCatalogue(),
    ]);

    return {
      current: {
        planKey: plan.planKey,
        planName: plan.planName,
        status: plan.status,
        trialPlanKey: plan.trialPlanKey,
        trialEndsAt: plan.trialEndsAt,
        pendingPlanKey: plan.pendingPlanKey,
        currentPeriodEnd: plan.currentPeriodEnd,
      },
      meters,
      // The whole table from the LIVE definitions, never a hard-coded copy
      // (§9.1). A plan whose limit an operator edited this morning shows the
      // new number here without a deploy, which is the §4 MUST.
      plans: catalogue,
      entitlements: ENTITLEMENTS.map((e) => ({
        key: e.key,
        label: e.label,
        blurb: e.blurb,
        limitType: e.limitType,
        variants: e.variants ?? null,
        hidesSurface: e.hidesSurface ?? false,
      })),
      openRequest: await this.openRequest(orgId),
      /** §9.6: a trial can only be taken once per plan. */
      trialsTaken: await this.trialsTaken(orgId),
    };
  }

  /**
   * Ask for a plan change (§9.6).
   *
   * Upserts the ONE open request rather than queueing a second, because
   * 0192's partial unique index says so and because an operator looking at a
   * list of three requests from one tenant cannot tell which is current.
   * Clicking "upgrade to Scale" after asking for Growth means they want Scale.
   */
  @Post("plan/request")
  @RequireOwnerRole("owner")
  async requestChange(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = PlanRequestBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { kind, planKey, note } = parsed.data;
    if (kind !== "cancel" && !planKey) {
      throw new BadRequestException("planKey is required unless kind is 'cancel'");
    }

    const actor = auditActor(req);
    // Resolved HERE, not in the statement below. `plans` is revoked from
    // `aura_app` (0192), so a sub-select against it inside `withOrg` answers
    // "permission denied for table plans" - see `EntitlementsService.planIds`.
    const planId = planKey ? await this.entitlements.planIdFor(planKey) : null;
    if (planKey && !planId) throw new BadRequestException(`no such plan '${planKey}'`);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO plan_change_requests (org_id, requested_plan_id, kind, note, requested_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id) WHERE status = 'open'
         DO UPDATE SET requested_plan_id = EXCLUDED.requested_plan_id,
                       kind = EXCLUDED.kind,
                       note = EXCLUDED.note,
                       requested_by = EXCLUDED.requested_by,
                       updated_at = now()
         RETURNING id, kind, status, created_at`,
        [orgId, planId, kind, note ?? null, actorUserId(actor)],
      );
      return { request: row };
    });
  }

  /**
   * Start a trial of a higher plan (§9.5).
   *
   * Self-serve, because it costs nothing to grant and the revert is a
   * scheduled write rather than a refund. `plan_id` is NOT overwritten - the
   * trial lives in its own column, which is the whole mechanism behind the
   * automatic revert: the plan the tenant pays for is never lost, so reverting
   * is clearing two columns rather than remembering what to restore.
   */
  @Post("plan/trial")
  @RequireOwnerRole("owner")
  async startTrial(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = z.object({ planKey: z.enum(PLAN_ORDER as [PlanKey, ...PlanKey[]]) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { planKey } = parsed.data;

    const plan = await this.entitlements.resolve(orgId);
    if (!plan.planKey) {
      // A tenant with no plan has no ceiling to trial past. Refusing is
      // honest; silently creating a subscription would put them INTO the plan
      // system, which §9 of 0192 deliberately avoids doing by accident.
      throw new ConflictException("this workspace is not on a plan yet - talk to us instead");
    }
    if (plan.trialPlanKey) throw new ConflictException("a trial is already running");
    if (PLAN_ORDER.indexOf(planKey) <= PLAN_ORDER.indexOf(plan.planKey)) {
      throw new BadRequestException("a trial has to be of a higher plan than the current one");
    }
    if ((await this.trialsTaken(orgId)).includes(planKey)) {
      throw new ConflictException(`this workspace has already trialled ${planKey}`);
    }

    const trialPlanId = await this.entitlements.planIdFor(planKey);
    if (!trialPlanId) throw new BadRequestException(`no such plan '${planKey}'`);

    const result = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `UPDATE org_subscriptions
            SET trial_plan_id = $2,
                trial_ends_at  = now() + make_interval(days => $3::int),
                status         = 'trialing',
                updated_at     = now()
          WHERE org_id = $1
          RETURNING trial_ends_at`,
        [orgId, trialPlanId, TRIAL_DAYS],
      );
      // An append-only record of which plans have been trialled, so §16's
      // "one trial per org per plan" survives the trial ending and the
      // columns being cleared.
      await client.query(
        `INSERT INTO plan_change_requests (org_id, requested_plan_id, kind, note, status, decided_at)
         VALUES ($1, $2, 'upgrade', 'trial started', 'applied', now())`,
        [orgId, trialPlanId],
      );
      return row;
    });

    // §9.6: "entitlement cache invalidated within seconds". Immediately, for
    // the instance that handled the request; the 30s TTL covers the others.
    this.entitlements.invalidate(orgId);
    return { trialEndsAt: result?.trial_ends_at ?? null, planKey };
  }

  /** §8.11's settings. */
  @Get("settings")
  @RequireOwnerRole("owner", "manager")
  async settings(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(`SELECT * FROM insights_settings LIMIT 1`);
      return { settings: resolveInsightsSettings(rows[0] ?? null), defaults: INSIGHTS_DEFAULTS };
    });
  }

  @Patch("settings")
  @RequireOwnerRole("owner")
  async updateSettings(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = InsightsSettingsInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    return this.db.withOrg(orgId, async (client) => {
      // COALESCE on the EXCLUDED side, so an omitted field means "leave
      // alone" rather than "set to null". Every column in that table is
      // nullable-means-default, so writing a null would silently reset the
      // setting to the shared default - which is a different thing from not
      // mentioning it.
      const { rows } = await client.query(
        `INSERT INTO insights_settings (org_id, leaderboard_visibility, demo_mode,
                                        stale_feed_hours, coverage_floor)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id) DO UPDATE SET
           leaderboard_visibility = COALESCE(EXCLUDED.leaderboard_visibility,
                                             insights_settings.leaderboard_visibility),
           demo_mode              = COALESCE(EXCLUDED.demo_mode, insights_settings.demo_mode),
           stale_feed_hours       = COALESCE(EXCLUDED.stale_feed_hours,
                                             insights_settings.stale_feed_hours),
           coverage_floor         = COALESCE(EXCLUDED.coverage_floor,
                                             insights_settings.coverage_floor),
           updated_at             = now()
         RETURNING *`,
        [
          orgId,
          input.leaderboardVisibility ?? null,
          input.demoMode ?? null,
          input.staleFeedHours ?? null,
          input.coverageFloor ?? null,
        ],
      );
      return { settings: resolveInsightsSettings(rows[0] ?? null) };
    });
  }

  /**
   * Whether an in-app upsell may be shown, and the record that it was (§9.2,
   * §9.7).
   *
   * ── THE CAP IS A QUERY, NOT AN INTENTION ────────────────────────────────────
   *
   * Showing a banner means writing the impression row first, so a surface that
   * forgets to check cannot show one. That inversion is the only way a
   * frequency cap holds across five independent trigger sites.
   *
   * Three rules, all in one statement:
   *   1. one banner per user per week, whatever the trigger;
   *   2. nothing on the first day of onboarding (§9.7);
   *   3. a dismissal of THIS trigger suppresses it for good, not for a week -
   *      "respected and stored" means respected.
   */
  @Get("upsell/eligible")
  @RequireOwnerRole("owner")
  async upsellEligible(@OrgId() orgId: string, @Query("trigger") trigger: string, @Req() req: PrincipalRequest) {
    const userId = actorUserId(auditActor(req));
    if (!trigger || !userId) return { eligible: false, reason: "no_subject" };

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{
        recent: string;
        dismissed: string;
        org_age_hours: string;
      }>(
        `SELECT (SELECT count(*) FROM upsell_impressions
                  WHERE org_id = $1 AND user_id = $2
                    AND shown_at > now() - make_interval(days => $4::int))          AS recent,
                (SELECT count(*) FROM upsell_impressions
                  WHERE org_id = $1 AND user_id = $2 AND trigger_key = $3
                    AND action = 'dismissed')                                       AS dismissed,
                (SELECT EXTRACT(epoch FROM (now() - created_at)) / 3600
                   FROM organizations LIMIT 1)                                      AS org_age_hours`,
        [orgId, userId, trigger, UPSELL_CAP_DAYS],
      );
      if (Number(row?.org_age_hours ?? 999) < 24) {
        return { eligible: false, reason: "onboarding_day_one" };
      }
      if (Number(row?.dismissed ?? 0) > 0) return { eligible: false, reason: "dismissed" };
      if (Number(row?.recent ?? 0) > 0) return { eligible: false, reason: "capped" };
      return { eligible: true, reason: "ok" };
    });
  }

  @Post("upsell/impression")
  @RequireOwnerRole("owner")
  async recordImpression(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() body: unknown) {
    const parsed = ImpressionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const userId = actorUserId(auditActor(req));
    if (!userId) throw new BadRequestException("an impression needs a user to belong to");
    const { triggerKey, surface, action } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `INSERT INTO upsell_impressions (org_id, user_id, trigger_key, surface, action)
              VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [orgId, userId, triggerKey, surface, action ?? null],
      );
      return { impressionId: row?.id ?? null };
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** The catalogue, from the live tables. Admin pool: `plans` has no org_id. */
  private async planCatalogue() {
    const { rows } = await this.db.adminPool().query<{
      key: string;
      name: string;
      blurb: string | null;
      price_minor: string | null;
      currency: string;
      period: string;
      sort: number;
      entitlements: Record<string, unknown>;
    }>(
      `SELECT p.key, p.name, p.blurb, p.price_minor, p.currency, p.period, p.sort,
              COALESCE(jsonb_object_agg(pe.entitlement_key, pe.value)
                       FILTER (WHERE pe.entitlement_key IS NOT NULL), '{}'::jsonb) AS entitlements
         FROM plans p
         LEFT JOIN plan_entitlements pe ON pe.plan_id = p.id
        WHERE p.active
        GROUP BY p.id
        ORDER BY p.sort`,
    );
    return rows.map((r) => ({
      key: r.key,
      name: r.name,
      blurb: r.blurb,
      // null everywhere today, which is what makes the CTA "Talk to us".
      priceMinor: r.price_minor === null ? null : Number(r.price_minor),
      currency: r.currency,
      period: r.period,
      entitlements: r.entitlements,
    }));
  }

  private async openRequest(orgId: string) {
    // The request row is org-scoped and read under RLS, as it should be. Its
    // PLAN is named from the catalogue map instead of joined, because `plans`
    // is not readable from this pool.
    const { byId } = await this.entitlements.planIds();
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        kind: string;
        note: string | null;
        created_at: Date;
        requested_plan_id: string | null;
      }>(
        `SELECT id, kind, note, created_at, requested_plan_id
           FROM plan_change_requests
          WHERE org_id = $1 AND status = 'open'
          LIMIT 1`,
        [orgId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        kind: row.kind,
        note: row.note,
        created_at: row.created_at,
        plan_key: row.requested_plan_id ? byId.get(row.requested_plan_id) ?? null : null,
      };
    });
  }

  private async trialsTaken(orgId: string): Promise<string[]> {
    const { byId } = await this.entitlements.planIds();
    const ids = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ requested_plan_id: string | null }>(
        `SELECT DISTINCT requested_plan_id
           FROM plan_change_requests
          WHERE org_id = $1 AND note = 'trial started'`,
        [orgId],
      );
      return rows.map((r) => r.requested_plan_id).filter((id): id is string => Boolean(id));
    });
    return ids.map((id) => byId.get(id)).filter((key): key is string => Boolean(key));
  }
}
