import type { Metadata } from "next";
import { Container, Section, SectionHeading } from "@/components/ui/layout";
import { Prose } from "@/components/ui/content";
import { TextLink } from "@/components/ui/button";
import { WhatsAppCta } from "@/components/ui/whatsapp-cta";
import { pageMetadata } from "@/lib/metadata";
import { WA_MESSAGES } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Call recording and consent",
  description:
    "What Aura does to make call recording transparent: an audible tone at capture " +
    "start, a persistent notification, and a per-call record of whether the tone " +
    "played, and what remains the recording business's own legal responsibility.",
  path: "/consent",
});

/**
 * /consent - P0 (doc 10 §3): how call-recording consent works in India, what
 * Aura enforces, and what the customer is responsible for.
 *
 * The mechanisms described are real and were read from the source:
 *   audible tone     RecordingService.kt:87-88, :185-193 - a 200 ms beep at
 *                    capture start. CaptureSettings.kt:41-46: ON by default.
 *   server policy    ActivationManager.kt:55 - the consent-tone requirement is
 *                    part of the policy the server pushes to an enrolled device.
 *   per-call record  UploadWorker.kt:140-141 → device-api.ts:67 `consentPlayed`
 *                    is sent with the upload and stored against the call.
 *   notification     a persistent notification is shown while recording
 *                    (strings.xml:14).
 *
 * THIS PAGE IS NOT LEGAL ADVICE AND SAYS SO. Aura is not a law firm, DPDP
 * enforcement detail is still settling, and a marketing page that reads as
 * counsel is a liability. It describes the controls and points at the duty.
 */
export default function ConsentPage() {
  return (
    <>
      <Container className="pt-12 sm:pt-16">
        <div className="max-w-3xl">
          <p className="text-sm font-medium text-accent-text">Consent</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">
            Call recording and consent
          </h1>
          <p className="mt-6 text-xl text-text-muted text-pretty">
            Recording a business call is normal and lawful in India in the ordinary
            case. Doing it without telling the other person is where businesses get
            into trouble. Aura is built to make telling them the default.
          </p>
        </div>
      </Container>

      <Section id="what-aura-does" labelledBy="does-heading">
        <SectionHeading
          id="does-heading"
          as="h2"
          title="What Aura does"
          lead="Transparency controls that are on unless someone deliberately turns them off."
        />
        <Prose className="mt-6">
          <h3>An audible tone when recording starts</h3>
          <p>
            The handset plays a short beep into the call at the moment capture begins.
            It is on by default, and it is the simplest form of notice there is: the
            other party hears it without anyone having to remember a script.
          </p>

          <h3>A per-call record of whether the tone played</h3>
          <p>
            Every uploaded call carries a flag saying whether the announcement tone was
            played for that specific call. It is stored against the call and visible in
            the console, so &ldquo;we always announce it&rdquo; is something you can
            actually check rather than assert.
          </p>

          <h3>A visible notification for the person recording</h3>
          <p>
            A persistent notification is shown on the handset while recording is
            running. Your telecaller always knows the app is active. Capture is never
            hidden from the employee doing it.
          </p>

          <h3>A policy your workspace controls</h3>
          <p>
            The announcement requirement is part of the policy your workspace pushes to
            enrolled devices, so it is set once for the fleet rather than left to each
            handset&rsquo;s local settings.
          </p>
        </Prose>
      </Section>

      <Section id="your-responsibility" tone="subtle" labelledBy="resp-heading">
        <SectionHeading
          id="resp-heading"
          as="h2"
          title="What remains your responsibility"
          lead="Aura gives you the controls. Using them lawfully is yours."
        />
        <Prose className="mt-6">
          <ul>
            <li>
              <strong>Telling the other party.</strong> The tone is notice, and in most
              business contexts it is enough. Where your obligations are higher, or
              where you want it beyond argument, say it in the opening line of the
              call. The tone does not replace a script; it backs one up.
            </li>
            <li>
              <strong>Telling your own employees.</strong> Your telecallers&rsquo; voices
              are personal data too. Recording staff calls should be in their terms of
              employment and it should be something they were told, not something they
              discovered.
            </li>
            <li>
              <strong>Having a lawful purpose and keeping to it.</strong> Recordings
              collected to improve sales quality should be used for that. Repurposing
              them later is a decision with consequences.
            </li>
            <li>
              <strong>Honouring erasure requests.</strong> If a customer asks you to
              delete a recording of them, you can erase that call and get a signed
              receipt. See{" "}
              <TextLink href="/security">how Aura handles your data</TextLink>. Doing so
              when asked is your obligation, not ours.
            </li>
            <li>
              <strong>Not recording what you should not.</strong> Aura captures
              telephone calls made on the enrolled handset. It is not a tool for
              recording people who are not on a call with your business.
            </li>
          </ul>
        </Prose>
      </Section>

      <Section id="cannot" labelledBy="cannot-heading">
        <SectionHeading
          id="cannot-heading"
          as="h2"
          title="What Aura cannot record"
          lead="Stated here so it is never a surprise later."
        />
        <Prose className="mt-6">
          <p>
            WhatsApp, Telegram, Signal and other internet calls cannot be recorded.
            Android gives the messaging app exclusive use of the microphone for the
            duration of the call, so any recorder receives silence. This is an operating
            system restriction, we confirmed it on hardware, and no product can work
            around it. We capture the metadata of those calls, not the audio.
          </p>
          <p>
            Handsets running the Google Dialer (Pixel, Motorola, Nokia) cannot be used
            for capture at all. See{" "}
            <TextLink href="/compatibility">phone compatibility</TextLink>.
          </p>
        </Prose>
      </Section>

      <Section id="not-advice" tone="subtle" labelledBy="advice-heading">
        <SectionHeading id="advice-heading" as="h2" title="This is not legal advice" />
        <Prose className="mt-6">
          <p>
            We build software, not legal opinions. India&rsquo;s Digital Personal Data
            Protection Act and the rules under it are still being operationalised, and
            what applies to you depends on your business, your sector and who you call.
            If call recording is material to how you operate, get advice from someone
            qualified to give it.
          </p>
          <p>
            What we can tell you is exactly what the software does, which is what this
            page is for. If something here is unclear, ask. We would rather answer it
            now.
          </p>
        </Prose>
        <div className="mt-8">
          <WhatsAppCta message={WA_MESSAGES.footer} size="lg">
            Ask about consent and recording
          </WhatsAppCta>
        </div>
      </Section>
    </>
  );
}
