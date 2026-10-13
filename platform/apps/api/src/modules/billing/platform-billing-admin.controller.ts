import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  ADDONS,
  ADDON_KEYS,
  BILLING_REGIONS,
  BillingRegion,
  periodKeyUtc,
  type AddonKey,
} from "@aura/shared";
import { resolveAndApplyPlanMeters } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OperatorOnlyGuard } from "../../common/operator-only.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { BillingOrdersService } from "./billing-orders.service";

const SettleBody = z.object({
  /** The invoice or UTR number the money arrived against. */
  reference: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
});

const RegionBody = z.object({
  region: BillingRegion,
  /**
   * Recording a call without consent is a criminal offence in the UAE, so an
   * AE tenant records nothing until an operator records that a counsel opinion
   * exists. This is that record. It is never set by a plan, never by a tenant,
   * and the trigger in 0197 clamps `consent_policy` back to 'prohibited' the
   * moment it is cleared.
   */
  consentCleared: z.boolean().optional(),
  consentNote: z.string().trim().max(2000).optional(),
});

const GrantBody = z.object({
  addonKey: z.enum(ADDON_KEYS as unknown as [AddonKey, ...AddonKey[]]),
  units: z.number().int().positive().max(100),
  note: z.string().trim().max(2000).optional(),
});

/**
 * The operator's half of billing: settling what was invoiced by hand, setting
 * a tenant's billing region, and issuing a credit.
 *
 * ── THIS IS THE PAYMENT PROVIDER, UNTIL THERE IS ONE ────────────────────────
 *
 * With no Razorpay keys configured every order is created as `manual`, and
 * this controller is how it completes: an operator invoices the customer out
 * of band, the money arrives, and `POST orders/:id/settle` grants exactly what
 * the order bought. It goes through the SAME `BillingOrdersService.settle()`
 * the webhook calls, which is the point - the manual path is not a lesser one
 * that might grant something different.
 *
 * ── OPERATOR ONLY, AND REFUSED FOR ANYBODY WITH A USER BEHIND THEM ──────────
 *
 * `OperatorOnlyGuard` denies any request carrying a real user identity, which
 * is both shapes a person arrives in. An owner who could settle their own
 * order could grant themselves Enterprise for nothing, and with no live
 * gateway that is the only thing keeping the plan system meaningful. Same
 * chain and same ordering as `PlanAdminController`: `OperatorOnlyGuard` reads
 * `req.principal`, which only `AdminKeyGuard` writes, so it has to run after
 * it; `@CrossTenant()` is what says these routes legitimately span tenants.
 */
@Controller("admin/billing")
@UseGuards(AdminKeyGuard, TenantGuard, OperatorOnlyGuard)
@CrossTenant()
export class PlatformBillingAdminController {
  constructor(
    private readonly db: DbService,
    private readonly orders: BillingOrdersService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** The queue: orders waiting to be settled, newest first. */
  @Get("orders")
  async list(@Query("status") status?: string) {
    const wanted = ["pending", "paid", "failed", "cancelled", "refunded"].includes(status ?? "")
      ? status
      : "pending";
    const { rows } = await this.db.adminPool().query(
      `SELECT o.id, o.org_id, org.name AS org_name, o.kind, p.key AS plan_key,
              o.billing_period, o.addon_key, o.addon_units, o.region, o.currency,
              o.subtotal_minor::text, o.tax_minor::text, o.total_minor::text,
              o.tax_kind, o.tax_rate_bp, o.status, o.provider, o.provider_order_id,
              o.auto, o.lines, o.created_at, o.paid_at, o.note
         FROM billing_orders o
         JOIN organizations org ON org.id = o.org_id
         LEFT JOIN plans p ON p.id = o.plan_id
        WHERE o.status = $1
        ORDER BY o.created_at DESC
        LIMIT 200`,
      [wanted],
    );
    return { orders: rows };
  }

  /**
   * Mark a manual order paid, which grants the plan or the add-on.
   *
   * No `paidMinor` is passed: there is no gateway report to check against, and
   * the operator confirming it is the authority. The reference they give goes
   * into the order's note and the audit row, which is what reconciles it
   * against the bank later.
   */
  @Post("orders/:id/settle")
  async settle(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = SettleBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { reference, note } = parsed.data;
    const result = await this.orders.settle(id, {
      provider: "manual",
      note: [reference ? `ref ${reference}` : null, note].filter(Boolean).join(" - ") || null,
    });
    return result;
  }

  /** Abandon an order nobody is going to pay, so the queue stays readable. */
  @Post("orders/:id/cancel")
  async cancel(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const parsed = SettleBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { rowCount } = await this.db.adminPool().query(
      `UPDATE billing_orders
          SET status = 'cancelled', note = COALESCE($2, note), updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [id, parsed.data.note ?? null],
    );
    if (!rowCount) throw new BadRequestException("no pending order with that id");
    return { cancelled: true };
  }

  /**
   * Set a tenant's billing region, and record a counsel opinion if there is one.
   *
   * The region is operator-set and nothing else, because it decides three
   * things at once: which price list applies, which tax regime, and - through
   * the consent gate - whether this tenant's handsets may record at all. A
   * tenant that could name its own region could unlock recording in a country
   * where it is a criminal offence.
   */
  @Post("orgs/:orgId/region")
  async setRegion(@Param("orgId", ParseUUIDPipe) orgId: string, @Body() body: unknown) {
    const parsed = RegionBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { region, consentCleared, consentNote } = parsed.data;
    if (!BILLING_REGIONS.includes(region)) throw new BadRequestException("unknown region");

    const {
      rows: [row],
    } = await this.db.adminPool().query<{ consent_policy: string; consent_cleared_at: Date | null }>(
      `UPDATE organizations
          SET billing_region       = $2,
              -- Only ever SET by an explicit true, and cleared by an explicit
              -- false. Omitting the field leaves whatever was recorded alone,
              -- so changing a tenant's region does not silently revoke an
              -- opinion that was obtained for it.
              consent_cleared_at   = CASE
                                       WHEN $3::bool IS NULL THEN consent_cleared_at
                                       WHEN $3::bool THEN COALESCE(consent_cleared_at, now())
                                       ELSE NULL END,
              consent_cleared_note = COALESCE($4, consent_cleared_note),
              updated_at           = now()
        WHERE id = $1
        RETURNING consent_policy, consent_cleared_at`,
      [orgId, region, consentCleared ?? null, consentNote ?? null],
    );
    if (!row) throw new BadRequestException("no such organization");

    // The region changes which price list and which meters apply, so the
    // tenant's columns are re-resolved. `consent_policy` is not touched here -
    // the trigger in 0197 has already clamped it if it needed clamping, which
    // is why the value is read back rather than assumed.
    await resolveAndApplyPlanMeters(this.db.adminPool(), orgId);
    this.entitlements.invalidate(orgId);

    return {
      orgId,
      region,
      consentPolicy: row.consent_policy,
      consentClearedAt: row.consent_cleared_at,
    };
  }

  /**
   * Issue an add-on without an order: a goodwill credit, or hours a customer
   * paid for before any of this existed.
   *
   * Deliberately separate from `settle` and deliberately audited. It is the
   * one way entitlement is granted with no money attached, so it names the
   * operator's note as a required piece of the story rather than an optional
   * one, and it writes an `addon_granted` audit row that a reconciliation can
   * find.
   */
  @Post("orgs/:orgId/grant")
  async grant(@Param("orgId", ParseUUIDPipe) orgId: string, @Body() body: unknown) {
    const parsed = GrantBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { addonKey, units, note } = parsed.data;
    const spec = ADDONS[addonKey];
    const capped = Math.min(units, spec.maxUnits);

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");
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
          `INSERT INTO org_addon_grants (org_id, addon_key, period, units, amount, note)
                VALUES ($1, $2, $3, $4, $5, $6)`,
          [orgId, addonKey, periodKeyUtc(), capped, capped * spec.grant, note ?? null],
        );
      }
      const limits = await resolveAndApplyPlanMeters(client, orgId);

      // Three separate parameters for the same value: org_id is uuid while
      // actor_id and target_id are text, and one placeholder across both types
      // fails parameter-type inference with 42P08. See plan-admin's note.
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
              VALUES ($1, 'system', $2, 'billing.addon_granted', 'organization', $3, $4::jsonb)`,
        [
          orgId,
          orgId,
          orgId,
          JSON.stringify({
            addonKey,
            units: capped,
            amount: capped * spec.grant,
            entitlement: spec.entitlement,
            period: spec.kind === "pack" ? periodKeyUtc() : null,
            note: note ?? null,
          }),
        ],
      );
      await client.query("COMMIT");
      this.entitlements.invalidate(orgId);
      return { orgId, addonKey, units: capped, meters: limits };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
