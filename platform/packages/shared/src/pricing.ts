import { z } from "zod";
import type { EntitlementKey } from "./entitlements";

/**
 * The published price list, as data, and the arithmetic that turns it into a
 * number somebody can be charged (`Build docs/47_PRICING_AND_COMPLIANCE.md`,
 * migration 0197).
 *
 * ── WHY A SECOND PRICING FILE, BESIDE `entitlements.ts` ─────────────────────
 *
 * `entitlements.ts` answers "what may this tenant do". This file answers "what
 * does it cost". They are deliberately separate objects, because the first is
 * read on the hot path of every request and the second is read when somebody
 * is about to pay. Mixing them would put a currency table behind a limit check.
 *
 * The split also matches who owns each: a limit is a product decision that
 * lives in `plan_entitlements` and can be edited without a release, while a
 * PRICE is a commercial commitment that appears on an invoice.
 *
 * ── THE NUMBERS BELOW ARE WHAT IS ACTUALLY CHARGED, TODAY ───────────────────
 *
 * Said plainly because the obvious guess is wrong. Migration 0197 creates and
 * seeds `plan_prices`, and the intention was that it become the authority so
 * product could move a price without a release - the same way
 * `plan_entitlements` already works for limits.
 *
 * **Nothing reads that table yet.** `quoteSubscription`, `quoteAddon` and the
 * console's price list all resolve against the constants in this file, which
 * are compiled into the build. So an operator editing `plan_prices` changes
 * nothing, and a price change means a deploy.
 *
 * That is a gap rather than a decision, and it is recorded as an open item in
 * `Build docs/47_PRICING_AND_COMPLIANCE.md`. Closing it means resolving the
 * region's row on the admin pool inside `BillingOrdersService` and falling
 * back to these constants when no row exists - at which point this comment has
 * to change with it.
 *
 * ── FOUR METERS, AND WHY NOT SEATS ──────────────────────────────────────────
 *
 * Handsets paired, transcription hours used, how long audio is kept, and a
 * storage ceiling. Every one of those is tied to a cost we pay: speech-to-text
 * is about 82% of what processing a call costs, and we rent storage for as long
 * as the audio lives.
 *
 * There is no per-seat meter and there must never be one. The cost of running
 * this product follows audio, not logins: a manager who only reads reports
 * costs us nothing while one telecaller on the phone all day costs real money.
 * Seat pricing would overcharge the first, undercharge the second, and punish
 * the behaviour the product exists to encourage - more people inside the CRM
 * looking at what the calls revealed. That is why every capture plan below
 * carries `dashboard_logins: null` and `active_telecallers: null`.
 *
 * ── EVERY AMOUNT IS INTEGER MINOR UNITS ─────────────────────────────────────
 *
 * Paise and fils, as `money.ts` requires. A tax line reached by two routes has
 * to agree to the last unit, and 18% of a float does not. Nothing in this file
 * constructs a fractional number.
 *
 * ── THE UAE PRICES ARE REAL AND NOT SELLABLE ────────────────────────────────
 *
 * Recording a call without the counterparty's consent is a criminal offence in
 * the UAE (Penal Code art. 431; Cybercrime Law art. 44, AED 150,000-500,000
 * plus imprisonment), and an announcement is notice rather than consent. The
 * AED column is therefore priced, seeded, and marked `sellable: false` until
 * affirmative consent capture ships and counsel has signed off per tenant.
 * `regionSellable()` is the one function that decides it, and migration 0197
 * pins `consent_policy = 'prohibited'` for an AE-region tenant so the handset
 * cannot record even if a price somehow got charged.
 */

// ── Regions, currencies, tax ────────────────────────────────────────────────

/**
 * A BILLING region, which is not `organizations.region` (an AWS region) and not
 * `org_business_profile.country` (what the tenant declares for its OWN
 * invoices, and which the tenant can edit).
 *
 * It has to be its own, operator-set column: the compliance position requires
 * `consent_policy` to be "enforced server-side, pinned to the tenant's
 * workspace country", and a country the tenant can type is not a pin. A UAE
 * tenant that could set its own country to `IN` would unlock recording for
 * itself, which is the single thing this gate exists to prevent.
 */
export const BillingRegion = z.enum(["IN", "AE"]);
export type BillingRegion = z.infer<typeof BillingRegion>;

export const BILLING_REGIONS: BillingRegion[] = ["IN", "AE"];

export interface TaxRegime {
  /** What it is called on the invoice. */
  label: string;
  kind: "gst" | "vat";
  /** Basis points, so 18% is 1800 and no percentage is ever a float. */
  rateBp: number;
}

/**
 * Tax is added ON TOP of every price in this file - the price list says so and
 * both markets expect it quoted that way. Storing the rate in basis points
 * keeps `taxOn()` integer-only.
 */
export const TAX_REGIMES: Record<BillingRegion, TaxRegime> = {
  IN: { label: "GST", kind: "gst", rateBp: 1800 },
  AE: { label: "VAT", kind: "vat", rateBp: 500 },
};

export const REGION_CURRENCY: Record<BillingRegion, string> = { IN: "INR", AE: "AED" };

// ── Plan families ───────────────────────────────────────────────────────────

/**
 * Which product line a plan belongs to.
 *
 * `capture` is the handset product this price list sells: we record the agent's
 * own SIM and do the analysis ourselves. `insights` is the API-only tier
 * (migration 0192) for a business that already runs a CRM or a dialer and
 * wants to push its own data at us.
 *
 * One catalogue holds both, because there is one `Entitlements.check()`, one
 * `org_subscriptions` row per tenant and one resolution path. The family is
 * what keeps a Compare-plans page from offering a capture tenant the API
 * tier's Scale, and it is why the two `growth`-shaped plans need distinct keys.
 */
export const PlanFamily = z.enum(["capture", "insights"]);
export type PlanFamily = z.infer<typeof PlanFamily>;

/** The four plans on the published price list, cheapest first. */
export const CAPTURE_PLAN_ORDER = [
  "record",
  "capture_starter",
  "capture_growth",
  "capture_enterprise",
] as const;
export type CapturePlanKey = (typeof CAPTURE_PLAN_ORDER)[number];

export const PLAN_FAMILY: Record<string, PlanFamily> = {
  record: "capture",
  capture_starter: "capture",
  capture_growth: "capture",
  capture_enterprise: "capture",
  starter: "insights",
  growth: "insights",
  scale: "insights",
  platform: "insights",
};

export function planFamily(key: string | null | undefined): PlanFamily | null {
  if (!key) return null;
  return PLAN_FAMILY[key] ?? null;
}

// ── The price list ──────────────────────────────────────────────────────────

/**
 * Monthly billing costs about 20% more than the same plan on annual billing.
 *
 * That is the normal convention in both markets and it is what gives a
 * customer a reason to commit for the year. Expressed in basis points and
 * applied by `monthlyFromAnnual()`, which rounds to a whole major unit so the
 * uplift produces a sellable price (₹999 -> ₹1,199) rather than ₹1,198.80.
 */
export const MONTHLY_UPLIFT_BP = 2000;

export interface RegionPrice {
  currency: string;
  /**
   * The monthly price when billed annually. This is the basis every number on
   * the published price list is quoted in, so it is the one stored and the one
   * the monthly figure is derived FROM - never the reverse.
   */
  annualMonthlyMinor: number;
  /**
   * True for Enterprise, where the number is a floor that keeps the
   * conversation serious rather than a description of what is included. The
   * console renders "from ₹39,999" and no checkout is offered.
   */
  fromPrice?: boolean;
  /**
   * Whether this region may be sold at all today. `false` for AE: the prices
   * are sound, the market is gated on law. See the file header.
   */
  sellable: boolean;
}

export interface CapturePlanSpec {
  key: CapturePlanKey;
  name: string;
  /** One line, as the price list words it. */
  blurb: string;
  sort: number;
  /** Handsets included. Enterprise is a floor, not a cap. */
  handsets: number;
  /** Included transcription hours per calendar month. 0 = none, null = custom. */
  transcriptionHours: number | null;
  /** Days a recording is kept before the file is deleted. */
  audioRetentionDays: number;
  /** Ceiling on stored recording bytes, in GiB. null = custom. */
  storageCapGb: number | null;
  /** Speaker labels and talk-time ratios. Gated to Growth and above. */
  speakerSeparation: boolean;
  /** Transcription, lead extraction, sentiment. Off on Record. */
  aiAnalysis: boolean;
  /** Negotiated rather than self-serve: no checkout, no trial, no top-up page. */
  negotiated?: boolean;
  /**
   * The cadences a stranger may buy from the public checkout with no human
   * involved. A cadence belongs here ONLY if its GST-inclusive debit clears
   * `MANDATE_AFA_CAP_MINOR` - otherwise the customer's bank interrupts every
   * renewal and the sale is not self-serve, it is a support ticket on a timer.
   *
   * Empty or absent = this plan is sales-led. `mandateCapHeadroom` is the
   * arithmetic, and `pricing.test.ts` fails the build if a price edit ever
   * puts a listed cadence over the line.
   */
  selfServePeriods?: readonly BillingPeriod[];
  prices: Record<BillingRegion, RegionPrice>;
}

/**
 * The largest recurring debit, INCLUDING tax, that clears without the customer
 * completing additional-factor authentication with their bank.
 *
 * RBI's e-mandate framework (consolidated 21 April 2026) sets this at ₹15,000
 * for ordinary merchants. The ₹1,00,000 ceiling that also circulates applies
 * only to insurance premiums, mutual-fund subscriptions and credit-card bills -
 * software does not qualify, and assuming otherwise is the most expensive
 * mistake available on this file.
 *
 * INR minor units. It is deliberately not per-region: AE is not sellable yet,
 * and inventing a UAE equivalent would be inventing a regulator's rule.
 */
export const MANDATE_AFA_CAP_MINOR = 1_500_000;

/**
 * What one debit of this plan/cadence leaves under the AFA cap, in minor units.
 * Negative means the bank will interrupt every renewal.
 *
 * Tax is applied the same way `quoteSubscription` applies it - once, on the
 * whole amount - so this answers the question the bank actually asks, which is
 * about the total it is asked to move, not the list price.
 */
export function mandateCapHeadroom(
  plan: CapturePlanSpec,
  region: BillingRegion,
  period: BillingPeriod,
): number {
  const net = planPriceMinor(plan, region, period);
  return MANDATE_AFA_CAP_MINOR - (net + taxOn(net, region));
}

/**
 * The four tiers.
 *
 * Record sells the recording alone and is nearly free for us to run, because it
 * uses a switch the platform already has: with transcription disabled a call is
 * stored, listed and playable but never sent to a speech-to-text provider, so
 * the per-hour cost is zero. Starter and Growth add transcription and analysis.
 * Enterprise is where every meter becomes a negotiated number.
 *
 * ── GROWTH: ₹12,699 FOR 185 HOURS ───────────────────────────────────────────
 *
 * Re-cut by the project owner on 2026-10-13 so the tier can be sold WITHOUT a
 * human. Growth is the only tier that sells speaker separation, which means
 * Sarvam diarized at ₹45 an audio-hour - an effective ₹54 once the pipeline's
 * own overhead is counted, which is the figure the 2026-10-12 analysis used.
 *
 * The binding constraint is no longer margin, it is the bank. RBI's e-mandate
 * framework clears a recurring debit WITHOUT the customer re-authenticating
 * only up to ₹15,000, and the ₹1,00,000 carve-out covers insurance, mutual
 * funds and credit-card bills - not software. The debit is GST-INCLUSIVE, so
 * the ceiling on the list price is ₹15,000 / 1.18 = ₹12,711. That is why this
 * is ₹12,699 and not the ₹14,999 it reads like it should be: ₹14,999 debits
 * ₹17,699 and would hand every customer a bank authentication link every
 * single renewal. See [[rbi-15k-mandate-ceiling]] and `mandateCapHeadroom`.
 *
 * At ₹12,699 the hours follow from the margin the owner accepted (~20%):
 * 185 hours costs ₹9,990 and leaves 21.3%. The previous shape - ₹19,999 for
 * 200 hours at 46% - was the right answer when a human closed every sale and
 * the debit size did not matter. It is the wrong answer for a tier that has to
 * renew by itself.
 *
 * ── WHY ANNUAL CADENCE ONLY, SELF-SERVE ─────────────────────────────────────
 *
 * Monthly billing adds `MONTHLY_UPLIFT_BP` (20%), so Growth billed monthly is
 * ₹15,239 ex-GST = ₹17,982 debited, which is back over the cap. Growth is
 * therefore self-serve on the ANNUAL cadence only (₹14,985 debited, monthly).
 * Record and Starter clear on both cadences and are self-serve on both.
 *
 * Note that "annual billing" here is a twelve-month commitment at a discounted
 * MONTHLY rate - `planPriceMinor` returns one month on either cadence. It is
 * not a lump sum, which is what makes an annual Growth subscription fit under
 * a ₹15,000 mandate at all.
 *
 * The UAE column is left at the published AED 899. It is not sellable (see the
 * header), so there is nothing to re-derive yet, and inventing a figure the
 * price list does not carry would be worse than leaving the ratio to be
 * decided when the market actually opens.
 *
 * ── WHY RECORD -> STARTER IS A SIX-TIMES JUMP ───────────────────────────────
 *
 * Deliberate. What is on the other side of it is transcription, lead
 * extraction, sentiment and search over what was actually said, which is the
 * whole reason the product exists. A smaller gap would sell the archive and
 * give the intelligence away.
 */
export const CAPTURE_PLANS: Record<CapturePlanKey, CapturePlanSpec> = {
  record: {
    key: "record",
    name: "Record",
    blurb: "Every call recorded, searchable and playable. No transcription.",
    sort: 1,
    handsets: 2,
    transcriptionHours: 0,
    audioRetentionDays: 30,
    storageCapGb: 5,
    speakerSeparation: false,
    aiAnalysis: false,
    // Both cadences clear the cap easily (₹1,179 and ₹1,415 debited).
    selfServePeriods: ["annual", "monthly"],
    prices: {
      IN: { currency: "INR", annualMonthlyMinor: 99_900, sellable: true },
      AE: { currency: "AED", annualMonthlyMinor: 9_900, sellable: false },
    },
  },
  capture_starter: {
    key: "capture_starter",
    name: "Starter",
    blurb: "100 transcription hours a month, with lead extraction and sentiment.",
    sort: 2,
    handsets: 2,
    transcriptionHours: 100,
    audioRetentionDays: 60,
    storageCapGb: 5,
    speakerSeparation: false,
    aiAnalysis: true,
    // ₹7,079 and ₹8,495 debited - both well under ₹15,000.
    selfServePeriods: ["annual", "monthly"],
    prices: {
      IN: { currency: "INR", annualMonthlyMinor: 599_900, sellable: true },
      AE: { currency: "AED", annualMonthlyMinor: 39_900, sellable: false },
    },
  },
  capture_growth: {
    key: "capture_growth",
    name: "Growth",
    blurb: "Four handsets, 185 hours, and who talked how much on every call.",
    sort: 3,
    handsets: 4,
    transcriptionHours: 185,
    audioRetentionDays: 90,
    storageCapGb: 15,
    speakerSeparation: true,
    aiAnalysis: true,
    // ANNUAL ONLY. Monthly adds the 20% uplift -> ₹17,982 debited, over the
    // cap. See the tier note above.
    selfServePeriods: ["annual"],
    prices: {
      IN: { currency: "INR", annualMonthlyMinor: 1_269_900, sellable: true },
      AE: { currency: "AED", annualMonthlyMinor: 89_900, sellable: false },
    },
  },
  capture_enterprise: {
    key: "capture_enterprise",
    name: "Enterprise",
    blurb: "Ten handsets or more, with every meter and the ASR provider negotiated.",
    sort: 4,
    handsets: 10,
    transcriptionHours: null,
    audioRetentionDays: 180,
    storageCapGb: null,
    speakerSeparation: true,
    aiAnalysis: true,
    negotiated: true,
    prices: {
      IN: { currency: "INR", annualMonthlyMinor: 3_999_900, fromPrice: true, sellable: true },
      AE: { currency: "AED", annualMonthlyMinor: 249_900, fromPrice: true, sellable: false },
    },
  },
};

/**
 * Per-handset cost, DERIVED and never stored.
 *
 * The price list carries a "per handset" row because it is how a buyer
 * compares us to a per-user product, but it is unit economics rather than a
 * charge: nothing in the product bills per handset. Deriving it means raising
 * Growth's headline price cannot leave a stale ₹3,750 sitting in a table
 * underneath a ₹19,999 plan - which is exactly what a stored column did.
 */
export function perHandsetMinor(plan: CapturePlanSpec, region: BillingRegion): number {
  const price = plan.prices[region];
  if (plan.handsets <= 0) return price.annualMonthlyMinor;
  return Math.round(price.annualMonthlyMinor / plan.handsets);
}

// ── Add-ons and top-ups ─────────────────────────────────────────────────────

/**
 * How an add-on behaves once it is paid for.
 *
 * `pack` is consumed and expires with the period it was bought in: hour packs,
 * which is what makes a top-up a one-off purchase rather than a price change.
 * `recurring` rides on the subscription and raises a ceiling for as long as it
 * is held: an extra handset, extra storage, extra retention days.
 */
export const AddonKind = z.enum(["pack", "recurring"]);
export type AddonKind = z.infer<typeof AddonKind>;

export const ADDON_KEYS = [
  "topup_hours_25",
  "topup_hours_100",
  "extra_handset",
  "extra_storage_5gb",
  "extra_retention_30d",
] as const;
export type AddonKey = (typeof ADDON_KEYS)[number];

export interface AddonSpec {
  key: AddonKey;
  name: string;
  kind: AddonKind;
  /** Which entitlement this raises, so enforcement reads the add-on by key. */
  entitlement: EntitlementKey;
  /** How much of that entitlement one unit grants. */
  grant: number;
  /** Price per unit per region, in minor units, ex-tax. */
  priceMinor: Record<BillingRegion, number>;
  /** How many units one tenant may hold. Keeps a typo from buying 400 handsets. */
  maxUnits: number;
}

/**
 * The add-on catalogue, priced so that buying past a limit repeatedly costs
 * more than moving up a tier.
 *
 * The hour packs work out at ₹80 and ₹70 an hour against an effective in-plan
 * rate of ₹60 on Starter. That ordering is the point: a customer who tops up
 * every month is paying a premium for the privilege and can see that upgrading
 * is cheaper. Margin on a top-up is still around 65%, so the premium is not
 * punitive - it is just the wrong way to buy a lot of hours.
 *
 * The retention add-on doubles as the answer for a customer with a documented
 * retention obligation, which in both markets is a routine procurement
 * question rather than an edge case.
 */
export const ADDONS: Record<AddonKey, AddonSpec> = {
  topup_hours_25: {
    key: "topup_hours_25",
    name: "25 transcription hours",
    kind: "pack",
    entitlement: "transcription_hours_monthly",
    grant: 25,
    priceMinor: { IN: 199_900, AE: 8_900 },
    maxUnits: 40,
  },
  topup_hours_100: {
    key: "topup_hours_100",
    name: "100 transcription hours",
    kind: "pack",
    entitlement: "transcription_hours_monthly",
    grant: 100,
    priceMinor: { IN: 699_900, AE: 29_900 },
    maxUnits: 20,
  },
  extra_handset: {
    key: "extra_handset",
    name: "Extra handset",
    kind: "recurring",
    entitlement: "paired_handsets",
    grant: 1,
    priceMinor: { IN: 149_900, AE: 9_900 },
    maxUnits: 50,
  },
  extra_storage_5gb: {
    key: "extra_storage_5gb",
    name: "Extra 5 GB of storage",
    kind: "recurring",
    entitlement: "storage_cap_gb",
    grant: 5,
    priceMinor: { IN: 49_900, AE: 2_900 },
    maxUnits: 40,
  },
  extra_retention_30d: {
    key: "extra_retention_30d",
    name: "Extra 30 days of audio retention",
    kind: "recurring",
    entitlement: "audio_retention_days",
    grant: 30,
    priceMinor: { IN: 79_900, AE: 4_900 },
    maxUnits: 12,
  },
};

export function addonSpec(key: string): AddonSpec | null {
  return (ADDONS as Record<string, AddonSpec>)[key] ?? null;
}

/**
 * Auto top-up is OPT-IN and takes a customer-set monthly ceiling.
 *
 * An auto-charge that renews itself without a cap is how a surprise bill
 * becomes a chargeback, and the ceiling costs us nothing to offer. The ceiling
 * is in minor units of the tenant's own currency and is checked against what
 * has already been auto-charged in the period, never against the plan price.
 */
export const AUTO_TOPUP_DEFAULT_CAP_MINOR: Record<BillingRegion, number> = {
  IN: 999_900,
  AE: 49_900,
};

// ── Arithmetic ──────────────────────────────────────────────────────────────

/** Billing cadence. The price list quotes `annual`; `monthly` is the uplift. */
export const BillingPeriod = z.enum(["annual", "monthly"]);
export type BillingPeriod = z.infer<typeof BillingPeriod>;

/**
 * The monthly-billing price for an annual-billing figure.
 *
 * Rounded to a whole major unit, which is what makes the uplift produce a
 * price somebody would print: ₹999 -> ₹1,199 rather than ₹1,198.80. The
 * rounding is to the nearest unit and not up, because at these amounts the
 * difference is under a rupee and a tidy number sells better than a greedy one.
 */
export function monthlyFromAnnual(annualMonthlyMinor: number, exponent = 2): number {
  const scale = 10 ** exponent;
  const uplifted = (annualMonthlyMinor * (10_000 + MONTHLY_UPLIFT_BP)) / 10_000;
  return Math.round(uplifted / scale) * scale;
}

/** What one plan costs per month on a given cadence, ex-tax. */
export function planPriceMinor(
  plan: CapturePlanSpec,
  region: BillingRegion,
  period: BillingPeriod,
): number {
  const annual = plan.prices[region].annualMonthlyMinor;
  return period === "annual" ? annual : monthlyFromAnnual(annual);
}

/**
 * Tax on a subtotal, in minor units.
 *
 * Integer throughout and rounded once, at the end, on the whole subtotal -
 * never per line. Taxing each line and summing gives a different answer from
 * taxing the sum, and an invoice whose lines do not add up to its total is a
 * support ticket every time.
 */
export function taxOn(subtotalMinor: number, region: BillingRegion): number {
  return Math.round((subtotalMinor * TAX_REGIMES[region].rateBp) / 10_000);
}

export interface QuoteLine {
  kind: "plan" | "addon";
  /** Plan key or add-on key. */
  key: string;
  label: string
  units: number;
  unitMinor: number;
  amountMinor: number;
}

export interface Quote {
  region: BillingRegion;
  currency: string;
  period: BillingPeriod;
  lines: QuoteLine[];
  subtotalMinor: number;
  taxLabel: string;
  taxRateBp: number;
  taxMinor: number;
  totalMinor: number;
  /**
   * False when this quote must not become a charge: an unsellable region, or a
   * negotiated tier. The checkout route refuses on exactly this flag rather
   * than re-deriving the reason, so the page and the API cannot disagree.
   */
  chargeable: boolean;
  /** Why not, when `chargeable` is false. One of these reaches the owner. */
  blockedReason: "region_not_sellable" | "negotiated_plan" | null;
}

export interface QuoteRequest {
  planKey: CapturePlanKey;
  region: BillingRegion;
  period: BillingPeriod;
  /** Recurring add-on units to include, by key. Packs are quoted separately. */
  addons?: Partial<Record<AddonKey, number>>;
}

/**
 * The one place a chargeable total is computed.
 *
 * Used by the owner's plan page, by the checkout route that creates a gateway
 * order, and by the operator's quote preview. One function, so the number on
 * the screen and the number sent to Razorpay are the same number - the whole
 * class of "the page said ₹7,079 and the gateway asked for ₹7,080" bug.
 */
export function quoteSubscription(req: QuoteRequest): Quote {
  const plan = CAPTURE_PLANS[req.planKey];
  const regionPrice = plan.prices[req.region];
  const regime = TAX_REGIMES[req.region];
  const lines: QuoteLine[] = [];

  const unitMinor = planPriceMinor(plan, req.region, req.period);
  lines.push({
    kind: "plan",
    key: plan.key,
    label: `${plan.name} (${req.period === "annual" ? "annual billing" : "monthly billing"})`,
    units: 1,
    unitMinor,
    amountMinor: unitMinor,
  });

  // Deterministic order, so two quotes for the same request are byte-identical
  // and an idempotency key computed over them matches.
  for (const key of ADDON_KEYS) {
    const units = req.addons?.[key] ?? 0;
    if (units <= 0) continue;
    const spec = ADDONS[key];
    if (spec.kind !== "recurring") continue;
    const capped = Math.min(units, spec.maxUnits);
    const unit = spec.priceMinor[req.region];
    lines.push({
      kind: "addon",
      key,
      label: spec.name,
      units: capped,
      unitMinor: unit,
      amountMinor: unit * capped,
    });
  }

  const subtotalMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const taxMinor = taxOn(subtotalMinor, req.region);
  const blockedReason: Quote["blockedReason"] = !regionPrice.sellable
    ? "region_not_sellable"
    : plan.negotiated
      ? "negotiated_plan"
      : null;

  return {
    region: req.region,
    currency: regionPrice.currency,
    period: req.period,
    lines,
    subtotalMinor,
    taxLabel: regime.label,
    taxRateBp: regime.rateBp,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
    chargeable: blockedReason === null,
    blockedReason,
  };
}

/** The same, for a one-off pack purchase. */
export function quoteAddon(
  key: AddonKey,
  units: number,
  region: BillingRegion,
): Quote {
  const spec = ADDONS[key];
  const capped = Math.max(1, Math.min(units, spec.maxUnits));
  const unit = spec.priceMinor[region];
  const subtotalMinor = unit * capped;
  const taxMinor = taxOn(subtotalMinor, region);
  const regime = TAX_REGIMES[region];
  const sellable = regionSellable(region);
  return {
    region,
    currency: REGION_CURRENCY[region],
    period: "monthly",
    lines: [
      {
        kind: "addon",
        key,
        label: spec.name,
        units: capped,
        unitMinor: unit,
        amountMinor: subtotalMinor,
      },
    ],
    subtotalMinor,
    taxLabel: regime.label,
    taxRateBp: regime.rateBp,
    taxMinor,
    totalMinor: subtotalMinor + taxMinor,
    chargeable: sellable,
    blockedReason: sellable ? null : "region_not_sellable",
  };
}

/**
 * Whether a region may be sold at all.
 *
 * Read off the price list rather than hard-coded, so opening the UAE is one
 * edit to four `sellable` flags plus the consent build the compliance position
 * requires - and so that nothing else in the codebase has to know which
 * country is which.
 */
export function regionSellable(region: BillingRegion): boolean {
  return CAPTURE_PLAN_ORDER.some((key) => CAPTURE_PLANS[key].prices[region].sellable);
}

// ── Meters ──────────────────────────────────────────────────────────────────

/**
 * Minutes in an included hour.
 *
 * The price list speaks hours; every meter in the platform already counts
 * MINUTES (`usage_events.quantity`, `organizations.asr_monthly_minutes_budget`,
 * the pipeline's ceiling check). So the entitlement is stored in hours - the
 * unit an operator editing `plan_entitlements` types and the unit the invoice
 * says - and converted exactly once, here, where anyone comparing against the
 * meter has to come through.
 */
export const MINUTES_PER_HOUR = 60;

export function hoursToMinutes(hours: number | null): number | null {
  return hours === null ? null : Math.round(hours * MINUTES_PER_HOUR);
}

/**
 * Bytes per gigabyte on the price list.
 *
 * `storage.ts` already owns this factor and `gbToBytes` - this is a
 * re-statement of its constant so pricing code does not have to reach for the
 * storage module to read its own table, and it is asserted equal in
 * pricing.test.ts. 1024-based but LABELLED GB, which is that module's
 * deliberate call: tenants read "GB", and two factors (1000 in one place, 1024
 * in another) are exactly how an owner's quota stops adding up.
 */
export const BYTES_PER_GIB = 1024 ** 3;

/**
 * Bytes one audio-hour of a recording occupies: 48 kbps mono AAC.
 *
 * 20.6 MiB, and the reason the two storage limits line up the way they do. At
 * this rate Starter's 60-day window holds about 2.3 GB against a 5 GB cap and
 * Growth's 90-day window about 7 GB against 15 GB - so the DAY limit does the
 * commercial work and the gigabyte cap sits behind it with roughly two times
 * headroom, waiting for the handset stuck in a loop or the floor that uploads
 * everything twice. A customer will never hit the gigabyte cap by working
 * normally, which is why eviction rather than refusal is the right behaviour.
 */
export const BYTES_PER_AUDIO_HOUR = Math.round(20.6 * 1024 * 1024);

/** What a plan's day window is expected to hold, for the operator's sanity check. */
export function expectedBytesForWindow(hoursPerMonth: number, retentionDays: number): number {
  return Math.round((hoursPerMonth / 30) * retentionDays * BYTES_PER_AUDIO_HOUR);
}

// ── What happens at each limit ──────────────────────────────────────────────

/**
 * The four limits and what each one does when it is reached.
 *
 * One principle governs all of them: **a call is never refused.** A recording
 * we decline is lost for good, the handset would retry it forever, and the
 * customer loses the one thing they are paying us to keep. So only the PAID
 * stages are ever skipped.
 *
 * The handset cap is the single limit that refuses anything, and it refuses an
 * administrative action rather than a call. That is the right place for a hard
 * stop: it is visible, it is immediate, the customer understands it, and it is
 * undone by spending money.
 *
 * This table is exported because three surfaces have to agree about it - the
 * owner's plan page, the operator's console, and the 402/403 bodies - and
 * because a behaviour written down in three places is a behaviour that drifts.
 */
export interface LimitBehaviour {
  entitlement: EntitlementKey;
  label: string;
  /** What the platform does. */
  action: "refuse" | "skip_paid_stages" | "delete_audio" | "evict_oldest";
  /** What the customer sees. */
  notice: string;
  /** Owners are notified when the meter crosses 80% and 100%. */
  warns: boolean;
}

export const LIMIT_BEHAVIOURS: LimitBehaviour[] = [
  {
    entitlement: "paired_handsets",
    label: "Handsets",
    action: "refuse",
    notice: "Pairing is refused, with the extra-handset add-on offered.",
    warns: false,
  },
  {
    entitlement: "transcription_hours_monthly",
    label: "Transcription hours",
    action: "skip_paid_stages",
    notice:
      "The call is still recorded, stored, listed and playable. Transcription and analysis are skipped, and the call can be reprocessed after a top-up or the next reset.",
    warns: true,
  },
  {
    entitlement: "audio_retention_days",
    label: "Audio retention",
    action: "delete_audio",
    notice:
      "The recording file is deleted. The transcript, the analysis and every CRM record stay, and the call reads \"recording expired\".",
    warns: false,
  },
  {
    entitlement: "storage_cap_gb",
    label: "Storage",
    action: "evict_oldest",
    notice: "The oldest audio is evicted. Uploads are never blocked.",
    warns: true,
  },
];

/**
 * Upgrading does NOT transcribe a customer's backlog for free.
 *
 * Turning transcription on already sweeps up the calls that were stored but
 * never transcribed, so "upgrade and we will transcribe your history" is a real
 * feature rather than a promise. But 5 GB of stored audio is about 248 hours,
 * and an unbounded sweep on upgrade would cost roughly ₹6,200 - the whole of
 * Starter's first-month allowance and more than the first month's fee.
 *
 * So backlog transcription draws down the customer's hour allowance like any
 * other hour. This constant is the cap on how much of a backlog one upgrade
 * will pick up without the owner asking again, expressed in hours.
 */
export const BACKLOG_TRANSCRIPTION_HOUR_CAP = 25;
