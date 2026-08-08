import { Section, SectionHeading } from "../ui/layout";
import { FAQAccordion } from "../ui/content";
import { FAQ } from "@/lib/content/faq";

/** FAQ (doc 10 §3 row 12). The FAQPage JSON-LD is emitted from the page, from
 *  the same array this renders, so the markup can never describe questions the
 *  visitor cannot see. */
export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-heading">
      <SectionHeading
        id="faq-heading"
        eyebrow="Questions"
        title="The things people ask before they buy"
      />
      <div className="mt-10">
        <FAQAccordion items={FAQ.map((f) => ({ q: f.q, a: f.a }))} />
      </div>
    </Section>
  );
}
