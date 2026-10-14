import type { Metadata } from "next";
import Link from "next/link";
import { CAPTURE_PLANS } from "@aura/shared";
import { BreadcrumbSchema } from "@/components/breadcrumbs";
import { JsonLd } from "@/components/json-ld";
import { ADDON_ROWS, GST_NOTE, HOW_TO_BUY, LIMITS, PLANS, type PlanRow } from "@/lib/content/pricing";
import { pageMetadata } from "@/lib/metadata";
import { BRAND, LEGAL_ENTITY, SITE_URL, startHref } from "@/lib/site";

/**
 * /pricing - the published price list.
 *
 * ── WHY THIS PAGE EXISTS NOW ──────────────────────────────────────────────
 *
 * Doc 10 §6: showing the price is standard for enterprise and fatal to hide
 * from an SMB, who simply closes the tab. The same section said not to
 * publish tiers until billing could enforce them - and that is now true
 * (migration 0197 seeds the plans, `Entitlements.check()` enforces the four
 * meters, and Growth was re-cut to ₹12,699 on 2026-10-13 to clear the RBI
 * auto-debit ceiling), so the
 * block is lifted.
 *
 * ── EVERY NUMBER COMES FROM @aura/shared ──────────────────────────────────
 *
 * Nothing on this page is typed into it. See lib/content/pricing.ts: the
 * figures are the same constants `quoteSubscription()` charges against, so
 * this page cannot drift from an invoice. The India region only - the AED
 * column is priced but not sellable, because recording without consent is a
 * criminal offence in the UAE.
 *
 * ── WHAT IS NOT ON THE PAGE, AND WHY ──────────────────────────────────────
 *
 * No checkout button: the payment gateway is a placeholder by decision, so
 * every CTA here goes to /start like the rest of the site, and HOW_TO_BUY
 * says plainly that a plan is set up with a person. No trial, because there
 * is no self-serve trial to give. No countdown, no "was ₹X" anchor price, and
 * no annual-saving badge screaming a percentage - the two cadences are shown
 * side by side and the reader can do the arithmetic.
 */

const CTA = startHref("pricing-cta", "pricing");

/**
 * The checkout link for a tier, or null when that tier cannot be bought online.
 *
 * The plan and cadence travel in the query string, so a buyer who clicked
 * "Start now" on Growth arrives at /signup with Growth already selected. Before
 * this, every button on this page landed on the same URL and the checkout
 * defaulted to the first plan in the catalogue - which meant the cheapest tier
 * was pre-selected for somebody who had just chosen the dearest one.
 *
 * `selfServePeriods` is the test, not `negotiated` - Growth is sellable and not
 * negotiated, but only on the annual cadence, because its monthly debit exceeds
 * the ceiling a bank will clear without interrupting the customer every month.
 * The first entry is the cadence the card's headline price is quoted at.
 */
function signupHref(key: PlanRow["key"]): string | null {
  const [period] = CAPTURE_PLANS[key]?.selfServePeriods ?? [];
  if (!period) return null;
  return `/signup?plan=${encodeURIComponent(key)}&period=${period}`;
}

export const metadata: Metadata = pageMetadata({
  title: "Pricing",
  description:
    "What Auratel costs: four plans from ₹999 a month for recording alone to " +
    "₹12,699 for 185 transcription hours with speaker separation. Per month, " +
    "excluding GST, with every included limit stated.",
  path: "/pricing",
});

/* ── Hero ─────────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="relative overflow-x-clip">
      <div className="mk-wash" />
      <div className="relative z-10 mx-auto max-w-6xl px-5 pt-6 pb-10 sm:px-6 sm:pt-10 sm:pb-14">
        <BreadcrumbSchema current={{ label: "Pricing", href: "/pricing" }} />
        <div className="max-w-[44rem]">
          <p className="mk-eyebrow mb-4">Pricing</p>
          <h1 className="mk-display mk-h1">
            Priced by what we actually <span className="mk-gradient-text">spend on your calls.</span>
          </h1>
          <p className="mk-lede mt-5 sm:mt-6">
            Four meters, and not one of them is a seat: handsets paired, transcription hours
            used, how long we keep the audio, and a storage ceiling. A manager who only reads
            reports costs us nothing, so they cost you nothing.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ── The tiers ────────────────────────────────────────────────────────────
   Four cards, every number read from the shared price list. The headline
   figure is the annual-billing monthly price, because that is the figure the
   price list quotes and the one the plan is designed around; the
   monthly-billing figure sits underneath it rather than being hidden behind a
   toggle nobody clicks. */

function Plans() {
  return (
    <section
      id="plans"
      className="mk-anchor border-y py-14 sm:py-16 lg:py-20"
      style={{ borderColor: "var(--mk-line)", background: "var(--mk-surface)" }}
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <div className="grid gap-4 sm:gap-5 lg:grid-cols-2 xl:grid-cols-4">
          {PLANS.map((p) => (
            <div
              key={p.key}
              className="flex flex-col rounded-[20px] border p-6"
              style={{
                borderColor: "var(--mk-line)",
                background: "var(--mk-ground)",
              }}
            >
              <h2 className="text-lg font-semibold">{p.name}</h2>
              <p
                className="mt-2 min-h-[3.25rem] text-[0.8125rem] leading-relaxed"
                style={{ color: "var(--mk-muted)" }}
              >
                {p.blurb}
              </p>

              {/* Enterprise prints no figure at all. Its price list entry is
                  a floor rather than a price, so there is nothing honest to
                  put here - see `showPrice` in lib/content/pricing.ts. */}
              {p.showPrice ? (
                <>
                  <p className="mt-4">
                    <span className="mk-display tabular text-3xl">{p.annual}</span>
                    <span className="text-[0.8125rem]" style={{ color: "var(--mk-muted)" }}>
                      {" "}
                      /month
                    </span>
                  </p>
                  <p className="mt-1 text-[0.75rem]" style={{ color: "var(--mk-muted)" }}>
                    billed annually, or {p.monthly}/month billed monthly
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-4">
                    <span className="mk-display text-3xl">Quoted</span>
                  </p>
                  <p className="mt-1 text-[0.75rem]" style={{ color: "var(--mk-muted)" }}>
                    every meter on this tier is set with you
                  </p>
                </>
              )}

              <dl className="mt-5 flex-1 space-y-2.5 border-t pt-5" style={{ borderColor: "var(--mk-line)" }}>
                {[
                  ["Handsets", p.handsets],
                  ["Transcription", p.transcription],
                  ["Audio kept for", p.retention],
                  ["Storage", p.storage],
                  /* Unit economics, not a charge - nothing in the product
                     bills per handset, and the figure is derived in
                     @aura/shared rather than stored, so raising a plan's
                     price cannot leave a stale per-handset number under it.
                     Shown because it is how a buyer compares us to a
                     per-user product, and omitted on the negotiated tier
                     where dividing a floor price would invent a rate. */
                  ...(p.negotiated ? [] : [["Works out per handset", p.perHandset]]),
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 text-[0.8125rem]">
                    <dt style={{ color: "var(--mk-muted)" }}>{k}</dt>
                    <dd className="text-right font-medium" style={{ color: "var(--mk-ink)" }}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>

              {/* The two gated capabilities, stated as present or absent
                  rather than omitted when absent. A feature list that only
                  ever says yes tells a reader nothing about the tier below. */}
              <ul className="mt-4 space-y-2 text-[0.8125rem]">
                {[
                  ["Transcription, lead extraction, sentiment", p.aiAnalysis],
                  ["Speaker separation and talk-time", p.speakerSeparation],
                ].map(([label, on]) => (
                  <li key={String(label)} className="flex gap-2">
                    {/* ✕ rather than a dash for "not in this tier": the same
                        two glyphs the compatibility matrix uses (Verdict in
                        components/ui/content.tsx), and a distinct SHAPE per
                        state rather than colour alone, which is what keeps it
                        readable for a colour-blind visitor and in print. */}
                    <span
                      aria-hidden="true"
                      style={{ color: on ? "var(--mk-ink)" : "var(--mk-muted)" }}
                    >
                      {on ? "✓" : "✕"}
                    </span>
                    <span style={{ color: on ? "var(--mk-ink)" : "var(--mk-muted)" }}>
                      {label}
                    </span>
                  </li>
                ))}
              </ul>

              {/* A plan that can be bought online gets a buy button carrying
                  its own plan and cadence; one that cannot still books a call.
                  See `signupHref`. */}
              <div className="mt-6">
                <Link
                  href={signupHref(p.key) ?? CTA}
                  className="mk-cta w-full justify-center"
                  style={{ padding: "0.75rem 1.25rem", fontSize: "0.9375rem" }}
                >
                  {p.negotiated ? "Talk to us" : signupHref(p.key) ? "Start now" : "Get set up"}
                </Link>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-6 text-[0.8125rem]" style={{ color: "var(--mk-muted)" }}>
          {GST_NOTE} {HOW_TO_BUY}
        </p>
      </div>
    </section>
  );
}

/* ── Add-ons ──────────────────────────────────────────────────────────────
   Published rather than quoted on request, because the thing a buyer is
   actually afraid of is the bill they cannot predict. Showing that an hour
   pack costs more per hour than the tier above it is also the honest version
   of an upsell: the arithmetic is on the page. */

function Addons() {
  return (
    <section
      id="add-ons"
      className="mk-anchor mx-auto max-w-6xl px-5 py-14 sm:px-6 sm:py-16 lg:py-20"
    >
      <p className="mk-eyebrow mb-4">Add-ons</p>
      <h2 className="mk-display mk-h2 max-w-2xl">When you need more of one thing.</h2>
      <p className="mk-lede mt-5">
        Buy a single meter up without moving tier. Hour packs work out dearer per hour than
        the next plan up, deliberately. If you top up every month then upgrading is
        cheaper, and we would rather you could see that.
      </p>

      <div
        className="mt-8 overflow-hidden rounded-[14px] border sm:mt-10"
        style={{ borderColor: "var(--mk-line)" }}
      >
        <table className="w-full border-collapse text-left text-[0.875rem]">
          <caption className="sr-only">Add-on prices, per month, excluding GST</caption>
          <thead>
            <tr style={{ background: "var(--mk-surface)" }}>
              {["Add-on", "Price", "How it is billed"].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="border-b px-4 py-3 text-[0.6875rem] font-semibold uppercase tracking-[0.1em]"
                  style={{ borderColor: "var(--mk-line)", color: "var(--mk-muted)" }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ADDON_ROWS.map((a) => (
              <tr key={a.name} className="border-b last:border-0" style={{ borderColor: "var(--mk-line)" }}>
                <th scope="row" className="px-4 py-3 font-medium" style={{ color: "var(--mk-ink)" }}>
                  {a.name}
                </th>
                <td className="tabular px-4 py-3" style={{ color: "var(--mk-ink)" }}>
                  {a.price}
                </td>
                <td className="px-4 py-3" style={{ color: "var(--mk-muted)" }}>
                  {a.cadence}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ── What happens at a limit ──────────────────────────────────────────────
   The most reassuring block on the page, and the one almost no vendor
   publishes. The principle behind it - a call is never refused - is a real
   property of the platform, and the table comes from the same shared
   LIMIT_BEHAVIOURS the 402 responses and the console's plan page read. */

function Limits() {
  return (
    <section
      className="border-y py-14 sm:py-16 lg:py-20"
      style={{ borderColor: "var(--mk-line)", background: "var(--mk-surface)" }}
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <p className="mk-eyebrow mb-4">If you go over</p>
        <h2 className="mk-display mk-h2 max-w-2xl">A call is never refused.</h2>
        <p className="mk-lede mt-5">
          A recording we decline is gone for good, so running out of something never costs
          you the call. Only the paid stages are ever skipped, and they can be run later.
        </p>

        <dl className="mt-8 grid gap-4 sm:mt-10 sm:gap-5 lg:grid-cols-2">
          {LIMITS.map((l) => (
            <div key={l.label} className="mk-card p-6">
              <dt className="text-base font-semibold">{l.label}</dt>
              <dd className="mt-2 text-[0.875rem] leading-relaxed" style={{ color: "var(--mk-muted)" }}>
                {l.notice}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* ── Close ────────────────────────────────────────────────────────────────── */

function Close() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-14 sm:px-6 sm:py-16 lg:py-20">
      <div className="max-w-2xl">
        <h2 className="mk-display mk-h2">Not sure which meter you will actually use?</h2>
        <p className="mk-lede mt-5">
          Neither is anyone, before they start. Tell us how many people are on the phone and
          roughly how long they talk, and we will tell you which plan that lands in,
          including when the answer is the cheapest one.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3 sm:gap-4">
          <Link href={CTA} className="mk-cta">
            Book a walkthrough
            <span aria-hidden="true">→</span>
          </Link>
          <Link href="/call-tracking-dashboard" className="mk-cta-ghost">
            See what it does
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function PricingPage() {
  /* Offer entities, one per plan, so a search result can carry the price.
     `priceSpecification` rather than a bare `price`, because these are
     monthly subscriptions and a naked number would be read as a one-off
     charge. `valueAddedTaxIncluded: false` is the machine-readable form of
     the GST line printed under the cards - it must match, or the rich result
     undercuts the page. Enterprise is omitted: its figure is a floor, not a
     price, and marking a floor as an Offer invites a result that misquotes
     us. */
  const offers = PLANS.filter((p) => p.showPrice).map((p) => ({
    "@type": "Offer",
    name: p.name,
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: p.annual.replace(/[^\d]/g, ""),
      priceCurrency: "INR",
      valueAddedTaxIncluded: false,
      referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "MON" },
    },
    availability: "https://schema.org/InStock",
    url: `${SITE_URL}/pricing`,
  }));

  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Product",
          name: BRAND,
          description:
            "Call intelligence for teams that sell on the phone: recording, Tamil and " +
            "English transcription, lead extraction and reporting.",
          brand: { "@type": "Brand", name: BRAND },
          url: `${SITE_URL}/pricing`,
          offers,
          publisher: { "@type": "Organization", name: LEGAL_ENTITY },
        }}
      />

      <div className="mk-page">
        <Hero />
        <Plans />
        <Addons />
        <Limits />
        <Close />
      </div>
    </>
  );
}
