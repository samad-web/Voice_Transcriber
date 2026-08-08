import { Section, SectionHeading } from "../ui/layout";
import { FeatureCard } from "../ui/content";

/**
 * What you get — six outcome cards, taken from doc 10 §5.3's left/right table.
 * The rule there is the whole point: the card title is the outcome the owner
 * cares about, never the feature name. "Know why you lose", not "objection
 * extraction".
 */
const OUTCOMES = [
  {
    title: "Know why you lose",
    body: "The objection behind every dead deal, counted, so you can tell the difference between a price problem and a follow-up problem.",
  },
  {
    title: "Your fields, not ours",
    body: "Tell Aura what matters in your business (brick type, site location, quotation status) and it pulls exactly that from every call.",
  },
  {
    title: "No more manual entry",
    body: "Every qualified call becomes a lead in your CRM by itself, with the details already filled in.",
  },
  {
    title: "See who's actually selling",
    body: "Not who logged the most calls, who moved the most pipeline, and why.",
  },
  {
    title: "Nothing gets dropped",
    body: "Every “I'll call you Monday” is captured from the conversation and tracked until it happens.",
  },
  {
    title: "Built for how India actually sells",
    body: "Tamil, Hindi, Telugu and English, including the half-and-half sentences your team really speaks.",
  },
];

export function Outcomes() {
  return (
    <Section id="outcomes" tone="subtle" labelledBy="outcomes-heading">
      <SectionHeading
        id="outcomes-heading"
        eyebrow="What you get"
        title="Six things you couldn't know before"
        lead="Not a dashboard nobody opens. Answers to questions you already ask out loud."
      />
      <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {OUTCOMES.map((o) => (
          <FeatureCard key={o.title} title={o.title}>
            {o.body}
          </FeatureCard>
        ))}
      </ul>
    </Section>
  );
}
