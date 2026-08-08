import { Section, SectionHeading } from "../ui/layout";
import { Placeholder } from "../ui/placeholder";

/**
 * The interactive demo (doc 10 §4) is out of scope for this run: it needs a
 * real, anonymised, consented call fixture put through the real pipeline and
 * then frozen, and fabricating a transcript to fill the space would be exactly
 * the thing doc 10 §15 forbids on the page that sells transcription accuracy.
 *
 * The placeholder is sized at the finished element's height on purpose. The
 * page's vertical rhythm, the position of every section below it and the
 * scroll-depth numbers this section will be judged on are all real now, so the
 * demo drops in without moving anything.
 */
export function DemoPlaceholder() {
  return (
    <Section id="demo" labelledBy="demo-heading">
      <SectionHeading
        id="demo-heading"
        eyebrow="See it work"
        title="A real Tamil sales call, becoming a lead"
        lead="Forty seconds, no signup: the audio, the diarized transcript with its English translation, and the typed fields filling in one by one."
      />
      <div className="mt-10">
        <Placeholder
          label="Interactive pipeline demo — audio, transcript, extraction"
          asset="an anonymised, consented call recording run through the real pipeline and frozen as a JSON fixture"
          blockedOn="consent from both parties, or a scripted re-record with our own team (doc 10 §11)"
          minHeight="34rem"
        />
      </div>
    </Section>
  );
}
