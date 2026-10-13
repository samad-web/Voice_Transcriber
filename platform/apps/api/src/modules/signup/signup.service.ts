import { randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import {
  CAPTURE_PLANS,
  type BillingPeriod,
  type BillingRegion,
  type CapturePlanKey,
  OrgModule,
  PLAN_MODULES,
  quoteSubscription,
  tenantRoleForOwnerRole,
} from "@aura/shared";
import { assignPlanToOrg } from "@aura/db";
import { DbService } from "../../db/db.service";
import { provisionTenant } from "../admin/provisioning";
import { InvitesService } from "../owner/invites.service";

/**
 * TURNING MONEY INTO A TENANT, WITH NOBODY WATCHING.
 *
 * ── THE ONE RULE ────────────────────────────────────────────────────────────
 *
 * `provisionFromSignup` must be safe to call repeatedly, concurrently, for the
 * same signup, and must do its work exactly once. That is not a nicety: it is
 * called from THREE places that cannot coordinate -
 *
 *   1. the gateway webhook, which Razorpay delivers AT LEAST ONCE and in no
 *      guaranteed order;
 *   2. the buyer's return page, because a webhook that never arrives must not
 *      leave a paying customer staring at nothing;
 *   3. the reconciliation sweep, which exists precisely for the case where
 *      Razorpay disabled our endpoint after 24h of failures and nobody noticed.
 *
 * Remove any one of those and the flow stops being zero-touch in some failure
 * mode. Keep all three and the ONLY thing standing between a double-provisioned
 * customer and us is the row lock below.
 *
 * ── HOW ONCE-ONLY IS ENFORCED ───────────────────────────────────────────────
 *
 * `SELECT ... FOR UPDATE` on the signup row, inside the same transaction that
 * creates the org. A second caller blocks on the lock, then re-reads `status`
 * and finds 'provisioned', and returns the existing result. It is not enforced
 * by checking-then-acting, which is the version of this that looks right and
 * races.
 *
 * ── WHY PROVISIONING AND THE INVITE SHARE A TRANSACTION ─────────────────────
 *
 * A half-provisioned org with a paid signup against it is the worst state this
 * system can reach: the buyer has been charged, and there is no operator
 * watching the queue to notice. So the org, its plan, its modules and the claim
 * invite all land together or none of them do - and a failure leaves the signup
 * on 'paid', which the sweep will retry.
 */
@Injectable()
export class SignupService {
  private readonly log = new Logger(SignupService.name);

  constructor(
    private readonly db: DbService,
    private readonly invites: InvitesService,
  ) {}

  /** 32 random bytes. Public, carries nothing - see migration 0200's header. */
  static newClaimRef(): string {
    return randomBytes(32).toString("base64url");
  }

  /**
   * Is this plan+cadence one a stranger may buy with no human involved?
   *
   * Reads `selfServePeriods`, which exists because the answer is NOT "is it
   * sellable" - it is "does one debit of it clear the bank's auto-debit
   * ceiling". A plan that fails this renews by interrupting the customer, and
   * that is a support queue we do not have.
   */
  static isSelfServe(planKey: CapturePlanKey, period: BillingPeriod, region: BillingRegion): boolean {
    const plan = CAPTURE_PLANS[planKey];
    if (!plan || plan.negotiated) return false;
    if (!plan.prices[region]?.sellable) return false;
    return (plan.selfServePeriods ?? []).includes(period);
  }

  /**
   * Provision the tenant a paid signup bought, and issue the claim link.
   *
   * Idempotent. Returns the claim URL whether it provisioned now or found the
   * work already done. Throws only when the signup is not in a state that can
   * be provisioned at all; a FAILURE during provisioning is recorded on the row
   * and rethrown, so the sweep picks it up rather than it vanishing.
   */
  async provisionFromSignup(signupId: string): Promise<{ orgId: string; claimUrl: string | null }> {
    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");

      // The lock. Everything below depends on holding it.
      const {
        rows: [signup],
      } = await client.query(
        `SELECT * FROM org_signups WHERE id = $1 FOR UPDATE`,
        [signupId],
      );
      if (!signup) {
        await client.query("ROLLBACK");
        throw new Error(`signup ${signupId} not found`);
      }

      // Already done by whoever got here first. Not an error - it is the
      // expected outcome for two of the three callers.
      if (signup.status === "provisioned" && signup.provisioned_org_id) {
        await client.query("COMMIT");
        return { orgId: signup.provisioned_org_id, claimUrl: null };
      }

      // Not paid means there is nothing to provision. A webhook for an order we
      // never marked paid, or a return page polled by someone who abandoned.
      if (signup.status !== "paid" && signup.status !== "failed") {
        await client.query("ROLLBACK");
        throw new Error(`signup ${signupId} is ${signup.status}, not payable`);
      }

      const planKey = signup.plan_key as CapturePlanKey;
      // PARSED, not cast. `PLAN_MODULES` is typed `Record<PlanKey, string[]>`,
      // so a typo in it would otherwise reach `organizations.enabled_modules`
      // as a module name nothing gates on - the tenant would simply be missing
      // a product with no error anywhere. Parsing turns that into a throw here,
      // before the org exists, which the sweep then surfaces.
      const modules = (PLAN_MODULES[planKey] ?? ["aura"]).map((m) => OrgModule.parse(m));

      // The SAME provisioning the operator console uses. Not a copy of it -
      // see provisioning.ts for why that distinction has teeth.
      const { org } = await provisionTenant(
        client,
        {
          name: signup.business_name,
          workspaceName: signup.business_name,
          modules: [...modules],
          tokenTtlMinutes: 60 * 24 * 14,
          tokenMaxUses: 5,
        },
        { id: `signup:${signup.id}`, type: "system" },
      );

      // Plan, meters and enabled_modules in one place. Without this the buyer
      // lands in a console whose CRM nav is absent and whose CRM routes 403,
      // with no indication why.
      const {
        rows: [planRow],
      } = await client.query<{ id: string }>(`SELECT id FROM plans WHERE key = $1`, [planKey]);
      if (!planRow) throw new Error(`plan ${planKey} is not in the catalogue`);
      await assignPlanToOrg(client, {
        orgId: org.id,
        planId: planRow.id,
        planKey,
        modules: [...modules],
        billingPeriod: signup.billing_period as BillingPeriod,
        clearTrial: true,
      });

      // Record the money against the tenant now that there is one to record it
      // against. This is why billing_orders.org_id can stay NOT NULL.
      await client.query(
        `INSERT INTO billing_orders (org_id, kind, plan_id, billing_period, region,
                                     total_minor, currency, status, provider,
                                     provider_order_id, provider_payment_id, paid_at)
         SELECT $1, 'subscription', p.id, $2, $3, $4, $5, 'paid', $6, $7, $8, now()
           FROM plans p WHERE p.key = $9`,
        [
          org.id,
          signup.billing_period,
          signup.region,
          signup.amount_minor,
          signup.currency,
          signup.provider,
          signup.provider_order_id,
          signup.provider_payment_id,
          planKey,
        ],
      );

      await client.query(
        `UPDATE org_signups
            SET status = 'provisioned', provisioned_org_id = $2,
                provisioned_at = now(), error = NULL, updated_at = now()
          WHERE id = $1`,
        [signup.id, org.id],
      );

      await client.query("COMMIT");

      // AFTER the commit, deliberately. `InvitesService.issue` opens its own
      // tenant-scoped connection and would deadlock against the lock we were
      // holding; and an invite that fails to send is recoverable (the sweep
      // re-issues) while a rolled-back org is not.
      const invite = await this.issueClaim(org.id, signup);
      return { orgId: org.id, claimUrl: invite };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      // Record WHY, so the operator screen has something to show and the sweep
      // does not retry blind forever.
      await this.db
        .adminPool()
        .query(
          `UPDATE org_signups SET status = 'failed', error = $2, updated_at = now()
            WHERE id = $1 AND status <> 'provisioned'`,
          [signupId, err instanceof Error ? err.message : String(err)],
        )
        .catch(() => undefined);
      this.log.error(`provisioning signup ${signupId} failed: ${String(err)}`);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The claim link: an `org_invites` row with a NULL inviter.
   *
   * Not a new token system. `invited_by` NULL with no existing membership is
   * already how an operator invites a customer's first owner, and it is already
   * tested - so self-serve reuses the path rather than inventing a second one
   * with its own expiry and its own bugs.
   *
   * Failure here is logged and swallowed: the org exists and is paid for, and
   * the sweep re-issues. Throwing would strand a provisioned tenant.
   */
  private async issueClaim(orgId: string, signup: Record<string, any>): Promise<string | null> {
    try {
      const issued = await this.invites.issue(
        orgId,
        {
          email: signup.email,
          name: null,
          ownerRole: "owner",
          tenantRole: tenantRoleForOwnerRole("owner"),
          telecallerId: null,
          recordingsListen: true,
          recordingsExport: true,
          phone: signup.phone ?? null,
          whatsapp: null,
        },
        { id: `signup:${signup.id}` },
        { send: true, ttlHours: 24 * 14 },
      );
      await this.db.adminPool().query(
        `UPDATE org_signups SET invite_id = $2, updated_at = now() WHERE id = $1`,
        [signup.id, (issued as any).id ?? null],
      );
      return (issued as any).url ?? null;
    } catch (err) {
      this.log.error(`claim invite for signup ${signup.id} failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * Everything paid but not provisioned, oldest first.
   *
   * This is the query that makes the flow genuinely zero-touch. Razorpay
   * delivers at-least-once, retries for 24 hours, and then DISABLES the
   * endpoint until somebody re-enables it in their dashboard - a silent, total
   * provisioning outage with a human recovery step. Without a sweep, every
   * customer who paid during it has taken money out of their account and
   * received nothing, and the first we would hear of it is a chargeback.
   */
  async pendingProvision(limit = 25): Promise<string[]> {
    const { rows } = await this.db.adminPool().query<{ id: string }>(
      `SELECT id FROM org_signups
        WHERE status IN ('paid', 'failed')
          AND paid_at > now() - interval '7 days'
        ORDER BY paid_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.id);
  }

  /** The quote a checkout freezes. Thin wrapper so the controller stays dumb. */
  static quote(planKey: CapturePlanKey, region: BillingRegion, period: BillingPeriod) {
    return quoteSubscription({ planKey, region, period });
  }
}
