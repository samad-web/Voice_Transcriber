import type { Metadata } from "next";
import { Container, Section, SectionHeading } from "@/components/ui/layout";
import { ComparisonTable, FAQAccordion, Prose, Verdict } from "@/components/ui/content";
import { WhatsAppCta } from "@/components/ui/whatsapp-cta";
import { TextLink } from "@/components/ui/button";
import { JsonLd } from "@/components/json-ld";
import { OEM_MATRIX, STATUS_LABEL } from "@/lib/content/compatibility";
import { pageMetadata } from "@/lib/metadata";
import { SITE_URL, WA_MESSAGES } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Which phones record calls automatically",
  description:
    "A hardware-verified list of which Android handsets Aura can capture calls from: " +
    "Samsung, Xiaomi, Redmi, POCO, Realme, Oppo, Vivo and OnePlus work. Pixel, Motorola " +
    "and Nokia use the Google Dialer and cannot be used. Here is exactly why.",
  path: "/compatibility",
});

/**
 * /compatibility - the highest-value page on the site (doc 10 §9).
 *
 * Two jobs at once. It answers objection #2 for a buyer mid-evaluation, and it
 * is the best organic-search asset this product has: "which phones record calls
 * automatically", "Samsung call recording folder", "does Pixel record calls" are
 * high-intent, low-competition queries, and we have hardware-verified answers
 * nobody else publishes.
 *
 * Both jobs depend on the same thing - the ❌ row being stated as plainly as
 * the ✅ ones. A vendor that names its limits is trusted on everything else,
 * and a page that hedges will not rank for the query that matters most.
 *
 * Facts: Build docs/05_FLEET_ONBOARDING.md §1 and the scan paths in
 * CallRecorderApp/.../capture/CaptureSettings.kt. See lib/content/compatibility.ts.
 */

const PAGE_FAQ = [
  {
    q: "Does a Pixel record phone calls?",
    a: "The Google Dialer on Pixel, Motorola and Nokia handsets can record calls, but it keeps the files in the dialer's own private app storage. Android does not let any other application read that directory, so no third-party tool, Aura included, can ingest those recordings. This is confirmed on hardware and it is not a permission you can grant.",
  },
  {
    q: "Where does Samsung save call recordings?",
    a: "In Recordings/Call/ on internal storage, once 'Auto record calls' is switched on in the Phone app's settings. That folder is readable, which is why Samsung handsets are the most reliable choice for Aura.",
  },
  {
    q: "Do I have to turn anything on?",
    a: "Yes, one setting per handset. Open the Phone app, go to its call-recording settings, and set automatic recording to all calls. Without it the phone never writes a file and there is nothing for Aura to pick up. It takes about a minute.",
  },
  {
    q: "Can Aura record WhatsApp calls?",
    a: "No. During a WhatsApp, Telegram or Signal call, Android gives the messaging app exclusive use of the microphone; every other app receives silence. This is an operating-system restriction, confirmed on hardware. We capture the metadata of those calls, not the audio.",
  },
  {
    q: "My phones are Infinix or Tecno. Will it work?",
    a: "The recording path for those handsets is shipped in the scanner, but we have not confirmed it on a device. Send us the model and we will test it before you commit to anything.",
  },
];

export default function CompatibilityPage() {
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: PAGE_FAQ.map((f) => ({
            "@type": "Question",
            name: f.q,
            acceptedAnswer: { "@type": "Answer", text: f.a },
          })),
        }}
      />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
            {
              "@type": "ListItem",
              position: 2,
              name: "Phone compatibility",
              item: `${SITE_URL}/compatibility`,
            },
          ],
        }}
      />

      <Container className="pt-12 sm:pt-16">
        <div className="max-w-3xl">
          <p className="text-sm font-medium text-accent-text">Compatibility</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">
            Which phones can Aura record calls from?
          </h1>
          <p className="mt-6 text-xl text-text-muted text-pretty">
            Aura does not record calls itself. It reads the recordings your handset&rsquo;s
            own dialer already makes, which means whether it works is decided by the
            phone&rsquo;s manufacturer, not by us. This is the whole list, tested on real
            devices.
          </p>
        </div>
      </Container>

      <Section id="matrix" labelledBy="matrix-heading">
        <SectionHeading id="matrix-heading" as="h2" title="The matrix" />
        <div className="mt-8">
          <ComparisonTable
            caption="Call capture support by handset manufacturer, with the folder each writes to"
            columns={["Handset", "Capture", "Recording folder", "Notes"]}
            rows={OEM_MATRIX.map((row) => ({
              header: row.brand,
              cells: [
                <Verdict key="v" ok={row.status !== "unsupported"}>
                  {STATUS_LABEL[row.status]}
                </Verdict>,
                <code key="p" className="tabular text-sm">
                  {row.path}
                </code>,
                <span key="n" className="text-sm">
                  {row.note ?? "-"}
                </span>,
              ],
            }))}
          />
        </div>
      </Section>

      <Section id="google-dialer" tone="subtle" labelledBy="gd-heading">
        <SectionHeading
          id="gd-heading"
          as="h2"
          title="Why Pixel, Motorola and Nokia will never work"
          lead="This is the limitation we get asked about most, so here is the mechanism rather than an apology."
        />
        <Prose className="mt-6">
          <p>
            Those handsets ship the Google Dialer as the system phone app. When it
            records a call, it writes the audio into its own private application
            directory. Android&rsquo;s storage sandbox prevents every other installed app
            from reading another app&rsquo;s private directory. There is no permission
            that grants it, no setting that opens it, and no version of Aura that gets
            around it. We confirmed this on hardware rather than reading it somewhere.
          </p>
          <p>
            On those phones Aura falls back to recording its own microphone, which
            captures the telecaller&rsquo;s side of the conversation only. You would get a
            transcript, and it would be half a conversation, enough to mislead a
            report and not enough to trust one. We do not recommend it, and we would
            rather lose the sale than have you find this out afterwards.
          </p>
          <p>
            <strong>
              If your team is on Pixel, Motorola or Nokia handsets, Aura is not the
              right product for you today.
            </strong>{" "}
            A Samsung or Xiaomi handset is inexpensive relative to what this changes,
            and it is the only honest workaround we have.
          </p>
        </Prose>
      </Section>

      <Section id="setup" labelledBy="setup-heading">
        <SectionHeading
          id="setup-heading"
          as="h2"
          title="What has to be true on each handset"
          lead="About five minutes per phone, once."
        />
        <Prose className="mt-6">
          <ol>
            <li>
              A supported handset from the table above, running the manufacturer&rsquo;s
              own dialer.
            </li>
            <li>
              The dialer&rsquo;s automatic call recording switched on for all calls: Phone
              app → Settings → Record calls. This is the step everything else depends
              on; without it the phone writes no file.
            </li>
            <li>
              The Aura app installed and enrolled against your workspace, with
              all-files access granted so it can read the dialer&rsquo;s recording folder.
            </li>
            <li>
              A test call, to confirm the recording appears. If it does not, we will
              tell you before you roll it out to the team.
            </li>
          </ol>
          <p>
            No new SIM, no new number, and nothing installed on your customer&rsquo;s
            phone. See{" "}
            <TextLink href="/consent">
              how call-recording consent works in India
            </TextLink>{" "}
            for what you are responsible for telling the other party.
          </p>
        </Prose>
      </Section>

      <Section id="compat-faq" tone="subtle" labelledBy="compat-faq-heading">
        <SectionHeading
          id="compat-faq-heading"
          as="h2"
          title="Questions people search for"
        />
        <div className="mt-8">
          <FAQAccordion items={PAGE_FAQ.map((f) => ({ q: f.q, a: f.a }))} />
        </div>
        <div className="mt-8">
          <WhatsAppCta message={WA_MESSAGES.compatibility} size="lg">
            Send us your handset models
          </WhatsAppCta>
        </div>
      </Section>
    </>
  );
}
