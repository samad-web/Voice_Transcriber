import { Container } from "../ui/layout";
import { ButtonLink } from "../ui/button";
import { WhatsAppCta } from "../ui/whatsapp-cta";
import { BRAND_LINE, WA_MESSAGES } from "@/lib/site";

/**
 * Hero — copy from doc 10 §5.1, near-verbatim, because it was written against
 * this buyer and is better than a rewrite.
 *
 * The LCP element is the `<h1>`: text, above the fold, in a self-hosted font
 * with `font-display: swap`. There is no hero image, no gradient mesh and no
 * animation on the critical path, which is how the sub-1.5s budget on a
 * mid-range Android over 4G (doc 10 §9) is met rather than aspired to.
 */
export function Hero() {
  return (
    <section className="border-b border-border py-16 sm:py-20 lg:py-28">
      <Container>
        <div className="max-w-3xl">
          <h1 className="text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">
            {BRAND_LINE}
          </h1>

          <p className="mt-6 text-xl text-text-muted text-pretty">
            Aura records your telecallers&rsquo; calls, transcribes them in Tamil, Hindi
            and English, and turns every conversation into a qualified lead, in your
            CRM, without anyone typing a note.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <WhatsAppCta message={WA_MESSAGES.hero} size="lg" />
            <ButtonLink href="#demo" variant="secondary" size="lg">
              See it work
            </ButtonLink>
          </div>

          {/* Pre-empts the first three questions every buyer in this segment
              asks, before they have to ask them. Each clause is verifiable:
              the OEM list is 05_FLEET_ONBOARDING §1; there is no telephony
              layer, so no number is issued; nothing is installed customer-side. */}
          {/* text-text-muted, NOT text-text-subtle: this is body-size prose a
              visitor is meant to read, so it needs the 4.5:1 token (5.33:1),
              not the 3.23:1 one. */}
          <p className="mt-8 text-base text-text-muted">
            Works on Samsung, Xiaomi, Realme, Oppo &amp; Vivo handsets · No new phone
            number · No app for your customers
          </p>
        </div>
      </Container>
    </section>
  );
}
