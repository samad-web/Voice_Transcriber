import type { Metadata } from "next";
import { BreadcrumbSchema } from "@/components/breadcrumbs";
import { Container, Section, SectionHeading } from "@/components/ui/layout";
import { Prose } from "@/components/ui/content";
import { TextLink } from "@/components/ui/button";
import { pageMetadata } from "@/lib/metadata";

export const metadata: Metadata = pageMetadata({
  title: "Call recording and consent",
  description:
    "Your telecaller asks for consent, in words, on the call. Auratel does not " +
    "collect consent for you and does not pretend to. What we do provide: India " +
    "data residency, per-tenant isolation, a retention window and erasure receipts.",
  path: "/consent",
});

/**
 * /consent - who obtains consent, and the honest answer that it is not us.
 *
 * ── REWRITTEN 2026-10-13, AND WHY ─────────────────────────────────────────
 *
 * The previous version of this page led with "Auratel is built to make telling
 * them the default" and gave four mechanisms under a heading "What Auratel
 * does", the first being an audible tone at capture start. The owner's
 * instruction is that consent is said and collected by the TELECALLER and that
 * we do not do consent from the app. Reading the code, the owner is right and
 * the old page was overselling:
 *
 *   · `playConsentTone()` lives in RecordingService and fires only when the
 *     app itself captures audio through `AudioCapturer` - the MICROPHONE
 *     fallback path. The product's main path reads the file the handset's own
 *     dialer wrote, and on that path RecordingService never starts, so no tone
 *     plays at all. The old page described the tone as though it applied to
 *     every call.
 *   · `consent_policy` in the database accepts 'tone_and_tts', but there is no
 *     TextToSpeech anywhere in the Android source. A spoken announcement is a
 *     column value, not a feature, and must never be described as one.
 *   · A beep is notice, not consent. Even where it plays it does not record
 *     that anyone agreed to anything.
 *
 * So this page now says plainly who does it (your telecaller, out loud) and
 * what we do not do (any of it). The one real mechanism is kept, scoped
 * accurately, and labelled as not being consent.
 *
 * ── THE DPDP SECTION IS MECHANISMS, NOT A BADGE ───────────────────────────
 *
 * Every line in it is checkable: residency from /security (Mumbai, own
 * servers, since 2026-09-24), isolation from 0001_init.sql's NOBYPASSRLS and
 * FORCE RLS, retention from organizations.retention_days, erasure from the
 * tenancy erasure controller, audit from audit_log. The roles come from /dpa.
 *
 * THIS PAGE IS STILL NOT LEGAL ADVICE AND STILL SAYS SO. A compliance claim
 * worded by an engineer is a liability; the mechanisms are ours to state, the
 * conclusion is counsel's to sign.
 */
export default function ConsentPage() {
  return (
    <>
      <BreadcrumbSchema current={{ label: "Call recording and consent", href: "/consent" }} />

      <Container className="pt-12 sm:pt-16">
        <div className="max-w-3xl">
          <p className="text-sm font-medium text-accent-text">Consent</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">
            Your telecaller asks for consent. Auratel does not.
          </h1>
          <p className="mt-6 text-xl text-text-muted text-pretty">
            Recording a business call is normal and lawful in India in the ordinary case,
            provided the other person is told and agrees. That telling happens out loud, on
            the call, in your telecaller&rsquo;s own words. Auratel records what was said
            after that; it does not obtain consent for you, and it would be dishonest of us
            to let you think otherwise.
          </p>
        </div>
      </Container>

      <Section id="who-asks" labelledBy="asks-heading">
        <SectionHeading
          id="asks-heading"
          as="h2"
          title="Who obtains consent, concretely"
          lead="One person, at one moment, in words the customer can answer."
        />
        <Prose className="mt-6">
          <h3>The telecaller says it at the start of the call</h3>
          <p>
            Before the conversation gets going, your telecaller states that the call is
            being recorded, says why, and waits for the customer to agree. In practice that
            is one sentence and a pause. Something like: <em>&ldquo;This call is recorded
            for quality and order accuracy. Is that alright?&rdquo;</em> Then they wait for
            the answer, because a question nobody answered is not consent.
          </p>

          <h3>If the customer says no</h3>
          <p>
            Your telecaller ends the recording arrangement the only way available to them:
            by not making the call on an enrolled handset, or by ending it. Auratel has no
            per-call switch that a telecaller can throw mid-conversation, and we would
            rather state that than imply a control that is not there. If refusals are
            common in your business, tell us before you buy and we will say honestly
            whether this fits.
          </p>

          <h3>Proving it later is your record, not ours</h3>
          <p>
            Under the DPDP Act the business making the call is the Data Fiduciary, which
            means the duty to obtain consent and to be able to evidence it sits with you.
            The recording itself usually carries the asking, because the telecaller said it
            on the call that was recorded. That is a by-product, not a consent ledger, and
            we do not market it as one.
          </p>
        </Prose>
      </Section>

      <Section id="what-we-do-not-do" tone="subtle" labelledBy="notdo-heading">
        <SectionHeading
          id="notdo-heading"
          as="h2"
          title="What Auratel does not do"
          lead="Listed because a gap you discover after paying is worse than one you read about first."
        />
        <Prose className="mt-6">
          <ul>
            <li>
              <strong>It does not read a notice to your customer.</strong> There is no
              spoken announcement, in any language. The platform has a configuration value
              for one; the handset has no code behind it, so it does not exist.
            </li>
            <li>
              <strong>It does not ask for consent, and it does not record the
              customer&rsquo;s answer.</strong> Nothing in Auratel captures the
              customer&rsquo;s yes or no as a field you can filter or report on. There is no
              consent column on a call, and no record that anybody agreed.
            </li>
            <li>
              <strong>It does not refuse a call for want of consent.</strong> Capture is a
              handset setting, not a per-call decision the software makes.
            </li>
            <li>
              <strong>It does not tell your staff for you.</strong> Recording your own
              telecallers&rsquo; voices is also personal data, and that conversation is one
              you have with them.
            </li>
          </ul>

          <h3>Two mechanisms that do exist, and neither of them is consent</h3>
          <p>
            <strong>A courtesy beep on one capture path.</strong> On handsets where Auratel
            has to record through the microphone instead of reading the dialer&rsquo;s own
            file, the app can play a short beep into the call when capture starts. It is a
            handset setting, it is audible notice at best, and it does not run on the main
            capture path at all. Your telecaller still has to say the sentence.
          </p>
          <p>
            <strong>A check on whether your telecaller said it.</strong> The call analysis
            records, per call, whether the recording was disclosed, and the console reports
            it as a percentage for each telecaller alongside the other quality criteria.
            That is there so you can supervise your own floor: it tells you whether your
            people are doing what you told them to do.
          </p>
          <p>
            Read what that is carefully. It is a judgement made by a language model reading
            a transcript, so it is an indicator and not evidence. It describes what your
            telecaller said, never what your customer agreed to. It does not make us a party
            to the consent, it is not a compliance certificate, and it must not be the only
            thing you rely on if a disclosure is ever disputed.
          </p>
        </Prose>
      </Section>

      <Section id="dpdp" labelledBy="dpdp-heading">
        <SectionHeading
          id="dpdp-heading"
          as="h2"
          title="Built for India's DPDP Act"
          lead="The mechanisms, each one checkable, and which of us they belong to."
        />
        <Prose className="mt-6">
          <p>
            Auratel is built to meet the Digital Personal Data Protection Act, 2023, and the
            split of duties it sets out. <strong>You are the Data Fiduciary</strong>: the
            calls are yours, the customers are yours, and the consent is yours to obtain.{" "}
            <strong>Auratel is the Data Processor</strong>: we process those recordings on
            your instructions and for nothing else. That division is written into the{" "}
            <TextLink href="/dpa">data processing agreement</TextLink>, not just described
            here.
          </p>

          <h3>What we provide, as mechanisms</h3>
          <ul>
            <li>
              <strong>Your data stays in India.</strong> The database runs on our own
              servers in Mumbai. It moved off managed infrastructure in Seoul on 24
              September 2026. If you have a residency requirement, this satisfies it.
            </li>
            <li>
              <strong>Isolation enforced by the database.</strong> Every table carrying
              your data is under Postgres row-level security, on a role with no permission
              to bypass it. A bug in a query cannot return another company&rsquo;s rows.
            </li>
            <li>
              <strong>A retention window you set.</strong> Recordings are deleted when your
              workspace&rsquo;s retention period runs out, 90 days by default, by a
              scheduled job rather than by someone remembering.
            </li>
            <li>
              <strong>Erasure on request, with a receipt.</strong> Erasing a call removes
              the audio, the transcript, the extracted fields, the lead and the CRM delivery
              record, and writes you a signed receipt. That is what answering a
              customer&rsquo;s erasure request actually needs.
            </li>
            <li>
              <strong>An access trail.</strong> Reads of your call data are written to an
              audit log you can read.
            </li>
            <li>
              <strong>A named sub-processor list.</strong> Published on{" "}
              <TextLink href="/security">how Auratel handles your data</TextLink>, including
              the one that is not in India.
            </li>
          </ul>

          {/* The owner's instruction, 2026-10-13, stated in the one place a
              buyer will look for it. Worded as a division of duties plus a
              pointer at the terms, which is where it is actually binding -
              a marketing page cannot allocate liability, and one that reads
              as though it does is worse than one that points at the document
              that can. */}
          <h3>We take no part in obtaining consent</h3>
          <p>
            Auratel is not involved in asking your customer, is not a party to the
            conversation in which you ask, and carries no responsibility for whether you
            did. Obtaining consent on the call, and any consequence of not obtaining it,
            rests with the business making the call. That is not a stance we invented for
            this page: it is the position our{" "}
            <TextLink href="/terms">terms of service</TextLink> set out, and the Data
            Fiduciary duty the Act itself assigns to you.
          </p>

          <h3>What stays yours</h3>
          <ul>
            <li>
              Saying it on the call. Consent is spoken, by your telecaller, and agreed to
              by the customer before the conversation proceeds.
            </li>
            <li>Being able to show you did.</li>
            <li>Giving your customers the notice the Act requires, in a language they understand.</li>
            <li>Telling your own employees that their calls are recorded.</li>
            <li>
              Having a lawful purpose and keeping to it. Recordings collected to improve
              sales quality should be used for that.
            </li>
            <li>Passing on an erasure or access request, which we then help you execute.</li>
          </ul>
        </Prose>
      </Section>

      <Section id="cannot" tone="subtle" labelledBy="cannot-heading">
        <SectionHeading
          id="cannot-heading"
          as="h2"
          title="What Auratel cannot record"
          lead="Stated here so it is never a surprise later."
        />
        <Prose className="mt-6">
          <p>
            WhatsApp, Telegram, Signal and other internet calls cannot be recorded. Android
            gives the messaging app exclusive use of the microphone for the duration of the
            call, so any recorder receives silence. This is an operating system restriction,
            we confirmed it on hardware, and no product can work around it. We capture the
            metadata of those calls, not the audio.
          </p>
          <p>
            Handsets running the Google Dialer (Pixel, Motorola, Nokia) cannot be used for
            capture at all. See <TextLink href="/compatibility">phone compatibility</TextLink>.
          </p>
        </Prose>
      </Section>

      <Section id="not-advice" labelledBy="advice-heading">
        <SectionHeading id="advice-heading" as="h2" title="This is not legal advice" />
        <Prose className="mt-6">
          <p>
            We build software, not legal opinions. India&rsquo;s DPDP Act and the rules
            under it are still being operationalised, and what applies to you depends on
            your business, your sector and who you call. If call recording is material to
            how you operate, get advice from someone qualified to give it.
          </p>
          <p>
            What we can tell you is exactly what the software does and does not do, which is
            what this page is for. If something here is unclear, ask. We would rather answer
            it now than have you find out later.
          </p>
        </Prose>
      </Section>
    </>
  );
}
