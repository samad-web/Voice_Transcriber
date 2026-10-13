import { formatMoney } from "@aura/shared/dist/money";
import {
  ADDON_KEYS,
  ADDONS,
  CAPTURE_PLAN_ORDER,
  CAPTURE_PLANS,
  LIMIT_BEHAVIOURS,
  TAX_REGIMES,
  monthlyFromAnnual,
  perHandsetMinor,
  type CapturePlanKey,
} from "@aura/shared/dist/pricing";

/**
 * The published price list, as the website needs it.
 *
 * ── THE NUMBERS ARE NOT WRITTEN HERE, AND MUST NEVER BE ───────────────────
 *
 * Every figure is read from `CAPTURE_PLANS` in @aura/shared - the same
 * constants `quoteSubscription()` uses to build the total a customer is
 * actually charged, and the same ones the console's plan page renders. That
 * is the whole point of this file: the price on the marketing page and the
 * price on the invoice cannot disagree, because there is one source and a
 * price change is one edit in one place.
 *
 * Doc 43 §6 ends on King Kong publishing four contradictory review counts on
 * one page. A public price that contradicts the invoice is the same defect
 * with a refund attached.
 *
 * Doc 10 §6 said not to publish tiers until billing could enforce them. It
 * can now: migration 0197 seeds the plans, `Entitlements.check()` enforces
 * the four meters, and Growth was re-cut to ₹12,699/185h on 2026-10-13 so its
 * debit clears the ₹15,000 e-mandate ceiling - see pricing.ts.
 *
 * ── INDIA ONLY, DELIBERATELY ──────────────────────────────────────────────
 *
 * The price list carries an AED column and every AED price is marked
 * `sellable: false`: recording a call without the counterparty's consent is a
 * criminal offence in the UAE, so the market is gated on law rather than on
 * engineering. Publishing those prices would advertise something we must not
 * sell, so this file is pinned to the IN region and the UAE is absent from
 * the site entirely.
 *
 * ── EX-TAX, AND SAID SO ───────────────────────────────────────────────────
 *
 * Every amount in the price list is before tax, and GST is added on top at
 * 18%. The tax line is exported from the same regime table the invoice uses,
 * and `GST_NOTE` is rendered under every price block on the page.
 */

const REGION = "IN" as const;

export interface PlanRow {
  key: CapturePlanKey;
  name: string;
  blurb: string;
  /** Monthly cost on annual billing - the figure the price list quotes. */
  annual: string;
  /** Monthly cost on monthly billing: the same plan, ~20% more. */
  monthly: string;
  /** Unit economics, derived. Nothing is billed per handset. */
  perHandset: string;
  /**
   * Whether a figure is published for this tier at all.
   *
   * False for Enterprise, on the owner's instruction (2026-10-13). The price
   * list carries ₹39,999 as a FLOOR rather than a price - every meter on that
   * tier is negotiated - and a floor on a public page gets read as the price
   * and then argued about. Nothing renders the number when this is false, and
   * it is left out of the structured data for the same reason: a rich result
   * quoting a floor as a price is a misquote we published ourselves.
   */
  showPrice: boolean;
  /** No checkout, no trial: the tier is negotiated. */
  negotiated: boolean;
  handsets: string;
  transcription: string;
  retention: string;
  storage: string;
  speakerSeparation: boolean;
  aiAnalysis: boolean;
}

function money(minor: number): string {
  // `whole: true` - the price list has no paise in it, and "₹12,699.00" on a
  // marketing page reads like a bank statement.
  return formatMoney(minor, { currency: "INR", whole: true });
}

export const PLANS: PlanRow[] = CAPTURE_PLAN_ORDER.map((key) => {
  const plan = CAPTURE_PLANS[key];
  const price = plan.prices[REGION];
  return {
    key,
    name: plan.name,
    blurb: plan.blurb,
    annual: money(price.annualMonthlyMinor),
    monthly: money(monthlyFromAnnual(price.annualMonthlyMinor)),
    perHandset: money(perHandsetMinor(plan, REGION)),
    // `fromPrice` and `negotiated` are set on the same tier today, and either
    // one is reason enough not to print a figure.
    showPrice: price.fromPrice !== true && plan.negotiated !== true,
    negotiated: plan.negotiated === true,
    handsets:
      plan.negotiated === true ? `${plan.handsets} or more` : String(plan.handsets),
    transcription:
      plan.transcriptionHours === null
        ? "Negotiated"
        : plan.transcriptionHours === 0
          ? "None - recording only"
          : `${plan.transcriptionHours} hours a month`,
    retention: `${plan.audioRetentionDays} days`,
    storage: plan.storageCapGb === null ? "Negotiated" : `${plan.storageCapGb} GB`,
    speakerSeparation: plan.speakerSeparation,
    aiAnalysis: plan.aiAnalysis,
  };
});

/** The three tiers a visitor can actually buy into without a negotiation. */
export const SELF_SERVE_PLANS = PLANS.filter((p) => !p.negotiated);

export interface AddonRow {
  name: string;
  price: string;
  /** "Each month, for as long as you keep it" vs "Used up in the month". */
  cadence: string;
}

export const ADDON_ROWS: AddonRow[] = ADDON_KEYS.map((key) => {
  const spec = ADDONS[key];
  return {
    name: spec.name,
    price: money(spec.priceMinor[REGION]),
    cadence: spec.kind === "pack" ? "One-off, used within the month" : "Monthly, while you keep it",
  };
});

/** What the platform does at each ceiling. Straight from the shared table. */
export const LIMITS = LIMIT_BEHAVIOURS.map((b) => ({
  label: b.label,
  notice: b.notice,
}));

const regime = TAX_REGIMES[REGION];

export const GST_NOTE = `All prices are per month and exclude ${regime.label}, charged at ${
  regime.rateBp / 100
}%.`;

/**
 * The one sentence that keeps the page honest about buying.
 *
 * There is no self-serve checkout: the gateway integration is a placeholder by
 * decision, so a "Buy now" button on this page would lead nowhere. Every CTA
 * on the pricing page goes to /start like the rest of the site, and this line
 * explains why rather than leaving a visitor hunting for a card form.
 */
export const HOW_TO_BUY =
  "Plans are set up with you rather than through a card form, so your handsets are paired and your extraction fields are configured before you are charged for a month you cannot use yet.";
