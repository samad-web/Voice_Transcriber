import { Section, SectionHeading } from "../ui/layout";
import { StepFlow } from "../ui/content";

/**
 * How it works — four steps (doc 10 §3 row 4), horizontal on desktop, stacked
 * on mobile.
 *
 * Each step describes what the deployed pipeline actually does:
 *   1  OemRecordingIngestor reads the OEM dialer's own recording folder
 *   2  UploadWorker presigns and uploads over HTTPS
 *   3  ASR then the extraction agent's typed field schema
 *   4  leads.ts projects the lead; crm-dispatch.ts delivers it
 */
const STEPS = [
  {
    title: "The call happens",
    body: "Your telecaller uses the same phone and the same number as always. The handset's own recorder captures both sides, nothing about the call changes.",
  },
  {
    title: "It uploads itself",
    body: "Aura picks the recording up in the background and sends it over an encrypted connection when the phone has signal. Nobody presses anything.",
  },
  {
    title: "It gets transcribed and read",
    body: "The conversation is transcribed with speaker labels, then read against the fields you told Aura matter in your business, not a generic template.",
  },
  {
    title: "It arrives where you work",
    body: "A qualified call becomes a lead with its details already filled in, delivered into your CRM and visible in the console with the transcript behind it.",
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works" labelledBy="how-heading">
      <SectionHeading
        id="how-heading"
        eyebrow="How it works"
        title="Four steps, three of which nobody has to do"
        lead="The only manual step is the call your team was going to make anyway."
      />
      <div className="mt-10">
        <StepFlow steps={STEPS} />
      </div>
    </Section>
  );
}
