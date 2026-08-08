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
          label: "Start the 2-minute setup form",
          requiresFunnel: true,
        }}
      />
    </Section>
  );
}
