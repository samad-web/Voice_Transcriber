import { BadRequestException, Body, Controller, Get, Param, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { z } from "zod";
import {
  BillingPeriod,
  BillingRegion,
  CAPTURE_PLANS,
  CAPTURE_PLAN_ORDER,
  CapturePlanKey,
  GST_STATES,
  GSTIN_PROBLEM_TEXT,
  gstinProblem,
  mandateCapHeadroom,
  normaliseGstin,
  planPriceMinor,
} from "@aura/shared";
import { DbService } from "../../db/db.service";
import {
  createPlatformOrder,
  resolvePlatformGateway,
} from "../billing/platform-razorpay";
import { assertSignupsOpen, signupReadiness } from "./signup-readiness";
import { SignupService } from "./signup.service";

/**
 * THE PUBLIC DOOR. Unauthenticated, by necessity.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM EVERY OTHER UNGUARDED ROUTE ──────────────
 *
 * Nothing else in the unguarded set creates rows in `organizations`. This is
 * the first route a stranger can touch that leads, eventually, to a tenant
 * existing. That is why the pre-payment record (`org_signups`, migration 0200)
 * carries no capability at all: a signup row grants nothing, costs nothing to
 * throw away, and only a VERIFIED PAYMENT promotes it into an org. The expensive
 * object is created by the webhook, never by the caller.
 *
 * ── THE THREE DEFENCES ──────────────────────────────────────────────────────
 *
 * 1. `@Throttle` at 60/min - a tenth of `PublicFormsController`'s 300, because
 *    a real human buys once and a script should not get 300 tries a minute at
 *    the gateway.
 * 2. A honeypot field, copying the lead-intake precedent: a filled `website`
 *    means a bot, and the response is a plausible success that creates nothing.
 * 3. The amount is computed HERE from the price list and frozen on the row. It
 *    is never read from the request, so a tampered body cannot buy Growth for
 *    ₹1 - and settlement re-checks it against what the gateway says was paid.
 *
 * ── WHY THE CATALOGUE IS FILTERED BY `selfServePeriods` ─────────────────────
 *
 * Not by `sellable`, and not by `negotiated`. The question this route answers is
 * narrower than "may this be sold": it is "will one debit of this clear the
 * bank's auto-debit ceiling", because a plan that fails that renews by
 * interrupting the customer. Selling it here would be selling a support ticket
 * on a three-week timer to somebody who was promised they would never need us.
 */

const CheckoutBody = z.object({
  planKey: z.string(),
  period: BillingPeriod,
  email: z.string().email().max(254),
  businessName: z.string().trim().min(2).max(120),
  // E.164, already normalised by the browser's PhoneInput.
  phone: z.string().trim().max(20).optional(),
  /**
   * GST place of supply. MANDATORY even for an unregistered buyer - CBIC
   * Circular 242/36/2024-GST treats the state recorded on the invoice as the
   * "address on record", and it decides IGST vs CGST+SGST. Getting it wrong is
   * our exposure, not the customer's.
   */
  billingState: z.string().trim().min(2).max(60),
  gstin: z.string().trim().length(15).optional(),
  /** Honeypot. A real browser leaves it empty; it is off-screen. */
  website: z.string().max(200).optional(),
});

@Controller("signup")
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PublicSignupController {
  constructor(
    private readonly db: DbService,
    private readonly signups: SignupService,
  ) {}

  /**
   * Refuse a new purchase unless the shop is open AND the product works.
   *
   * The ASR read is on the admin pool and narrowed to one tiny platform table
   * (0202), so it costs a round trip on a route that is already making several
   * - and it is wrapped: a failure reads as "unknown", which ALLOWS. The
   * switch is the control; this is the safety catch behind it, and a safety
   * catch that closes the shop over a blip on a bookkeeping query would be
   * worse than the thing it guards against.
   */
  private async assertOpen(): Promise<void> {
    let asrUsable: boolean | null = null;
    try {
      const { rows } = await this.db.adminPool().query<{ usable: boolean }>(
        `SELECT bool_or(parked_until IS NULL OR parked_until <= now()) AS usable
           FROM asr_provider_health`,
      );
      // No rows at all means 0202 has not been applied - genuinely unknown, not
      // "unusable", so it allows and the switch alone decides.
      asrUsable = rows[0]?.usable ?? null;
    } catch {
      asrUsable = null;
    }
    assertSignupsOpen(signupReadiness(asrUsable));
  }

  /**
   * The priced catalogue a stranger may buy from.
   *
   * Prices come from `CAPTURE_PLANS`, not `plan_prices`, because that is what
   * `quoteSubscription` charges against - serving a number here that the
   * checkout would not honour is worse than serving none.
   */
  @Get("plans")
  plans() {
    const region: BillingRegion = "IN";
    const out = [];
    for (const key of CAPTURE_PLAN_ORDER) {
      const plan = CAPTURE_PLANS[key];
      for (const period of plan.selfServePeriods ?? []) {
        if (!SignupService.isSelfServe(key, period, region)) continue;
        const quote = SignupService.quote(key, region, period);
        out.push({
          planKey: key,
          name: plan.name,
          blurb: plan.blurb,
          period,
          handsets: plan.handsets,
          transcriptionHours: plan.transcriptionHours,
          netMinor: planPriceMinor(plan, region, period),
          totalMinor: quote.totalMinor,
          taxMinor: quote.taxMinor,
          currency: quote.currency,
          // Proof, served rather than asserted: a client can see this plan
          // renews without interrupting the customer.
          mandateHeadroomMinor: mandateCapHeadroom(plan, region, period),
        });
      }
    }
    return { region, plans: out };
  }

  /**
   * Start a purchase. Creates the signup row and a gateway order; creates NO
   * tenant and grants nothing.
   */
  @Post("checkout")
  async checkout(@Body() body: unknown) {
    // ── IS THE SHOP OPEN, AND CAN THE PRODUCT DO ITS JOB? ──────────────────
    //
    // Checked FIRST, before the body is even parsed: a 503 for a closed shop
    // should not depend on sending a well-formed order, and nothing below this
    // line should run for a purchase that is not going to be allowed.
    //
    // Two conditions (see signup-readiness.ts): an explicit
    // PUBLIC_SIGNUPS_ENABLED, and at least one usable ASR provider. The second
    // is doc 49 P9's own precondition made mechanical - selling a
    // transcription product while no provider is usable is how a stranger's
    // first week becomes a refund and a review. It is re-checked per request
    // rather than at boot, because a vendor account empties at 2am.
    await this.assertOpen();

    const parsed = CheckoutBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    // Honeypot. Plausible success, nothing written - the same shape the funnel
    // uses, so a bot cannot tell it was caught.
    if (p.website && p.website.trim() !== "") {
      return { ok: true, claimRef: SignupService.newClaimRef(), gateway: null };
    }

    const region: BillingRegion = "IN";
    const planKey = p.planKey as CapturePlanKey;
    if (!CAPTURE_PLANS[planKey]) throw new BadRequestException("unknown plan");
    if (!SignupService.isSelfServe(planKey, p.period, region)) {
      // Deliberately specific: this is a real product rule, and a buyer who
      // picked Growth-monthly deserves to be told it is annual-only rather
      // than getting a blank refusal.
      throw new BadRequestException(
        "that plan and billing cycle cannot be bought online - please contact sales",
      );
    }

    if (p.gstin) {
      // The real validator, checksum and all - not a regex. A GSTIN whose state
      // code disagrees with the selected state means one of the two fields is
      // wrong, and guessing which would put the wrong place of supply on a tax
      // invoice. `gstinProblem` already distinguishes format, checksum and
      // state, and `GSTIN_PROBLEM_TEXT` already words each one.
      const stateCode = GST_STATES.find((s) => s.name === p.billingState)?.code ?? null;
      const problem = gstinProblem(normaliseGstin(p.gstin), stateCode);
      if (problem) throw new BadRequestException(GSTIN_PROBLEM_TEXT[problem]);
    }

    // Computed here, never taken from the request.
    const quote = SignupService.quote(planKey, region, p.period);
    if (!quote.chargeable) throw new BadRequestException("that plan cannot be charged online");

    const claimRef = SignupService.newClaimRef();
    const {
      rows: [signup],
    } = await this.db.adminPool().query<{ id: string }>(
      `INSERT INTO org_signups (email, email_normalised, business_name, phone,
                                billing_state, gstin, plan_key, billing_period,
                                region, amount_minor, currency, claim_ref)
       VALUES ($1, lower($1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        p.email,
        p.businessName,
        p.phone ?? null,
        p.billingState,
        p.gstin ?? null,
        planKey,
        p.period,
        region,
        quote.totalMinor,
        quote.currency,
        claimRef,
      ],
    );

    // No keys configured yet means no gateway. The signup row still exists, so
    // the work is not lost and an operator can settle it by hand - which is the
    // honest behaviour while RAZORPAY_PLATFORM_* are unset, rather than
    // pretending a checkout opened.
    const gateway = resolvePlatformGateway(quote.currency);
    if (gateway.provider !== "razorpay") {
      return { ok: true, claimRef, gateway: null, reason: gateway.reason };
    }

    const order = await createPlatformOrder(gateway.creds, {
      amountMinor: quote.totalMinor,
      currency: quote.currency,
      receipt: signup.id,
    });
    await this.db
      .adminPool()
      .query(`UPDATE org_signups SET provider_order_id = $2, updated_at = now() WHERE id = $1`, [
        signup.id,
        order.id,
      ]);

    return {
      ok: true,
      claimRef,
      gateway: {
        provider: "razorpay",
        orderId: order.id,
        keyId: gateway.creds.keyId,
        amountMinor: quote.totalMinor,
        currency: quote.currency,
      },
    };
  }

  /**
   * What the return page polls while provisioning finishes.
   *
   * Returns a STATUS and, once there is one, the claim URL. Never the email,
   * the amount, the org id or the error - `claim_ref` travels in a URL and
   * lands in browser history, so it must not be worth stealing.
   */
  @Get(":claimRef/state")
  async state(@Param("claimRef") claimRef: string) {
    const {
      rows: [row],
    } = await this.db.adminPool().query<{
      status: string;
      invite_id: string | null;
    }>(`SELECT status, invite_id FROM org_signups WHERE claim_ref = $1`, [claimRef]);

    if (!row) return { status: "unknown" };

    // 'failed' is deliberately reported as still working. It is true from the
    // buyer's side - the sweep retries - and telling somebody who has just paid
    // that something failed, with no support line to call, converts a
    // recoverable blip into a chargeback.
    const status =
      row.status === "provisioned" ? "ready" : row.status === "pending" ? "awaiting_payment" : "working";

    return { status, claimReady: Boolean(row.invite_id) };
  }
}
