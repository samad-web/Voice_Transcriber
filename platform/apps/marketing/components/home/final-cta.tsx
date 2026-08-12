import { Section } from "../ui/layout";
import { CTABanner } from "../ui/cta-banner";
import { WA_MESSAGES, startHref } from "@/lib/site";

/** Final CTA (doc 10 §3 row 13). WhatsApp again — it is the one CTA this
 *  segment actually uses, and repeating it is the point. */
export function FinalCta() {
  return (
    <Section id="talk" labelledBy="talk-heading">
      <h2 id="talk-heading" className="sr-only">
        Talk to us
      </h2>
      <CTABanner
        title="Tell us how your team sells today."
        body="Five minutes on WhatsApp is enough for us to tell you whether Aura fits, whether your phones are compatible, and roughly what it would cost. If it does not fit, we will say so."
        waMessage={WA_MESSAGES.footer}
        secondary={{
          href: startHref("final-cta"),
          // Matches the header and the page CTAs. "Start the 2-minute setup
          // form" described the mechanics of the next screen; this names what
          // the visitor gets out of it, and being the same words as every other
          // funnel button means they read as one action rather than four.
          label: "Book my call",
          requiresFunnel: true,
        }}
      />
    </Section>
  );
}
