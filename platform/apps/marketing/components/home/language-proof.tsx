import { Section, SectionHeading, Card } from "../ui/layout";
import { Placeholder } from "../ui/placeholder";

/**
 * Language proof (doc 10 §3 row 6).
 *
 * Doc 10 asks for real transcript excerpts side by side with their English
 * translation. There are none in this repository that are cleared for
 * publication, and writing a plausible-looking Tamil transcript to fill the gap
 * would be fabricating the exact evidence this section exists to provide - on
 * the page selling transcription quality, which is about the worst place to do
 * it. So: the claim is stated plainly, and the proof is a marked placeholder.
 *
 * The languages named are the ones doc 10 §5.3 commits to and the ones the
 * Indic ASR/LLM path is built around. Kannada appears in doc 10 §3 row 6 but
 * not in §5.3's claim, and no verified output was available to check it
 * against, so it is left out rather than asserted.
 */
const CLAIMS = [
  {
    title: "Code-switching, not just translation",
    body: "Real sales calls start in Tamil, quote a price in English and finish in Tamil. Aura transcribes the sentence as it was actually spoken instead of forcing it into one language.",
  },
  {
    title: "Speaker labels that survive the switch",
    body: "Agent and customer stay separated through the whole call, which is what makes “who said they would call back” answerable at all.",
  },
  {
    title: "Extraction in the same language",
    body: "The fields come out filled in your team's language when that is what was said, and translated when you want them in English.",
  },
];

export function LanguageProof() {
  return (
    <Section id="languages" labelledBy="languages-heading">
      <SectionHeading
        id="languages-heading"
        eyebrow="Language"
        title="Tamil, Hindi, Telugu and English, including the half-and-half sentences"
        lead="A transcription product that only works in clean English does not work in an Indian sales office."
      />

      <div className="mt-10 grid gap-6 lg:grid-cols-3">
        {CLAIMS.map((c) => (
          <Card key={c.title}>
            <h3 className="text-lg font-semibold text-text">{c.title}</h3>
            <p className="mt-2 text-base text-text-muted">{c.body}</p>
          </Card>
        ))}
      </div>

      <div className="mt-8">
        <Placeholder
          label="Side-by-side transcript excerpts, Tamil / Hindi original with English translation"
          asset="cleared excerpts from real calls, or excerpts from a scripted call recorded with our own team"
          blockedOn="publication consent (doc 10 §11), a fabricated transcript would undermine this section's only job"
          minHeight="16rem"
        />
      </div>
    </Section>
  );
}
