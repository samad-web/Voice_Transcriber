import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Candid, LegalDocument } from "@/components/legal/document";
import { pageMetadata } from "@/lib/metadata";
import { TERMS_READY, required } from "@/lib/legal";
import { CONSOLE_URL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Terms of service",
  description:
    "The agreement between Aura and the businesses that use it: who carries the " +
    "legal responsibility for recording a call, what the service does and does not " +
    "promise, and who owns the data.",
  path: "/terms",
});

/**
 * /terms - the commercial and usage contract.
 *
 * 404s until `TERMS_READY`, which needs three clauses no engineer should write:
 * the liability cap, the indemnity, and the fee terms. See lib/legal.ts.
 *
 * ── TWO THINGS THIS DOCUMENT REFUSES TO DO ────────────────────────────────
 *
 * It does NOT claim an uptime figure. There is no monitoring that could prove a
 * 99.9% and no credit regime that could pay for breaching it, and an uptime
 * promise you cannot measure is a breach of contract waiting to be found.
 *
 * It does NOT soften §5. Aura's output comes from speech recognition and
 * language models, which are wrong sometimes and confidently wrong
 * occasionally. A terms page that buries that in a warranty disclaimer, while
 * the marketing page implies the extraction is reliable, is the gap that turns
 * one bad extraction into a dispute. So it is stated plainly, in the customer's
 * own interest and ours.
 */
export default function TermsPage() {
  if (!TERMS_READY) notFound();

  const name = required("registeredName");
  const securityEmail = required("securityEmail");
  const contactEmail = required("contactEmail");

  return (
    <LegalDocument
      eyebrow="Legal"
      title="Terms of service"
      lead="The agreement between us. The part that matters most is §2, and it is short."
      effectiveDate={required("effectiveDate")}
    >
      <h2 id="parties">1. Who this agreement is between</h2>
      <p>
        These terms are between {name} (&ldquo;<strong>Aura</strong>&rdquo;, &ldquo;we&rdquo;,
        &ldquo;us&rdquo;) and the business that subscribes to the service (&ldquo;you&rdquo;,
        &ldquo;<strong>Customer</strong>&rdquo;).
      </p>
      <p>
        If you are accepting these terms on behalf of a company, you confirm you have the
        authority to bind it. If you do not, do not accept them.
      </p>
      <p>
        These terms cover the Aura call intelligence service: the Android capture application,
        the upload and processing pipeline, the web console at{" "}
        <a href={CONSOLE_URL}>{CONSOLE_URL.replace(/^https?:\/\//, "")}</a>, and the APIs
        (together, the &ldquo;<strong>Service</strong>&rdquo;).
      </p>

      <h2 id="recording-responsibility">2. The single most important thing in this document</h2>

      <Candid title="Aura records telephone calls. The legal responsibility for that recording is yours, not ours.">
        <p>You are responsible for:</p>
      </Candid>

      <ul>
        <li>
          notifying every party to a call that it is being recorded, in the manner the law
          requires;
        </li>
        <li>obtaining any consent that applies;</li>
        <li>having a lawful basis for making, storing and analysing the recording;</li>
        <li>
          complying with the Indian Telegraph Act, the Information Technology Act 2000, the
          Digital Personal Data Protection Act 2023 and any sector rules that apply to your
          business;
        </li>
        <li>responding to requests from the individuals recorded.</li>
      </ul>
      <p>
        We provide the tooling, controls and guidance to help you do this, including
        per-organisation retention, cascading erasure and an audit log. We do not and cannot do it
        for you, and we do not verify that you have done it.
      </p>
      <p>
        <strong>If you have not addressed call recording consent, do not enrol a handset.</strong>{" "}
        Our guidance is at <a href="/consent">/consent</a>.
      </p>

      <h2 id="account">3. Your account</h2>
      <p>
        You must give accurate registration details and keep them current. You are responsible for
        everything done under your account and for keeping credentials secure. Tell us promptly at{" "}
        <a href={`mailto:${securityEmail}`}>{securityEmail}</a> if you believe an account has been
        compromised.
      </p>
      <p>
        Access to the console is controlled by your organisation. You decide who in your business
        gets an account and what they can see.
      </p>

      <h2 id="what-we-do">4. What we will do</h2>
      <p>
        We will provide the Service with reasonable skill and care, and in accordance with the
        security measures described in our <a href="/privacy">privacy policy</a> and at{" "}
        <a href="/security">/security</a>.
      </p>
      <p>
        <strong>We do not currently offer a contractual uptime commitment.</strong> We are saying
        that rather than publishing a number we cannot yet stand behind. If you need a service
        level agreement, ask us and we will negotiate one as part of your order.
      </p>

      <h2 id="no-promises">5. What the Service does not promise</h2>
      <p>
        Aura transcribes speech and extracts structured information using automated systems,
        including third-party speech recognition and language models.
      </p>

      <Candid title="These systems make mistakes.">
        <p>
          Transcripts will contain errors. Extracted fields, quantities, prices, dates,
          commitments, will sometimes be wrong, and the system will occasionally state something
          confidently that the call did not contain. Accuracy varies with audio quality,
          background noise, accent, code-switching and line quality.
        </p>
      </Candid>

      <ul>
        <li>
          <strong>
            Do not use Aura&rsquo;s output as the sole basis for a decision that matters
          </strong>{" "}
          without checking it against the recording. It is a tool for finding things in your
          calls, not a system of record for what was legally agreed.
        </li>
        <li>
          We do not warrant that transcripts or extracted data are accurate, complete or fit for
          any particular purpose.
        </li>
        <li>We do not warrant that the Service will be uninterrupted or error-free.</li>
      </ul>
      <p>
        Except as expressly stated in these terms, the Service is provided &ldquo;as is&rdquo; and
        we disclaim all other warranties to the fullest extent the law allows.
      </p>

      <h2 id="your-data">6. Your data stays yours</h2>
      <p>
        You own your call recordings, transcripts, extracted data and everything else you put into
        the Service (&ldquo;<strong>Customer Data</strong>&rdquo;). We claim no ownership of it.
      </p>
      <p>
        You grant us only the licence we need to run the Service for you: to store, process,
        transmit and display Customer Data for the purpose of providing the Service to you, and
        for no other purpose.
      </p>
      <p>
        <strong>
          We will not use Customer Data to train, fine-tune or evaluate machine learning models
        </strong>
        , ours or anyone else&rsquo;s. We will not use it to build features for other customers,
        and we will not analyse it in aggregate across customers.
      </p>
      <p>
        Our handling of Customer Data is governed by the{" "}
        <a href="/dpa">data processing agreement</a>, which forms part of these terms.
      </p>

      <h2 id="acceptable-use">7. What you must not do</h2>
      <p>You must not, and must not permit anyone else to:</p>
      <ul>
        <li>use the Service to record a call you have no lawful right to record;</li>
        <li>
          use it to conduct surveillance of employees in a manner your local law forbids;
        </li>
        <li>
          reverse engineer, decompile or attempt to derive the source code of any part of the
          Service, except to the extent the law expressly permits despite this clause;
        </li>
        <li>
          resell, sublicense or provide the Service to a third party as a service of your own,
          unless we have agreed that in writing;
        </li>
        <li>
          probe, scan or test the vulnerability of our systems without our prior written
          permission, or breach any security or authentication measure;
        </li>
        <li>
          interfere with the integrity or performance of the Service, or use it to transmit
          malware;
        </li>
        <li>use the Service in breach of any applicable law.</li>
      </ul>
      <p>
        If you find a security vulnerability, we would rather hear from you than not. Report it to{" "}
        <a href={`mailto:${securityEmail}`}>{securityEmail}</a> and we will not pursue you for a
        good faith, non-destructive report.
      </p>

      <h2 id="fees">8. Fees</h2>
      <p>{required("commercialTerms")}</p>

      <h2 id="term">9. Term, suspension and termination</h2>
      <p>
        <strong>You may terminate</strong> on {required("terminationNoticeDays")} days&rsquo;
        written notice to <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>
      <p>
        <strong>We may suspend</strong> your access immediately if your use poses a security risk
        to the Service or to others, or if we are required to by law. We will tell you why, and
        restore access once the cause is resolved.
      </p>
      <p>
        <strong>We may terminate</strong> for material breach that you do not cure within 30 days
        of written notice.
      </p>
      <p>
        <strong>On termination:</strong>
      </p>
      <ul>
        <li>
          You may export your Customer Data for {required("exportWindowDays")} days.
        </li>
        <li>
          After that window we will delete Customer Data in accordance with the{" "}
          <a href="/dpa">data processing agreement</a>.
        </li>
        <li>
          <strong>Deletion is real and it cascades.</strong> Once it has run, we cannot bring your
          data back. Export before the window closes.
        </li>
      </ul>

      <h2 id="confidentiality">10. Confidentiality</h2>
      <p>
        Each of us may learn confidential information about the other. Each of us will protect the
        other&rsquo;s confidential information with at least the care we use for our own, use it
        only for the purposes of this agreement, and not disclose it except to people who need it
        and are bound to keep it confidential.
      </p>
      <p>
        This does not apply to information that is public through no fault of the recipient, was
        already known, is independently developed, or must be disclosed by law, and where the law
        compels disclosure, the recipient will give notice first if permitted.
      </p>

      <h2 id="liability">11. Liability</h2>
      <p>{required("liabilityClause")}</p>

      <h2 id="indemnity">12. Indemnity</h2>
      <p>{required("indemnityClause")}</p>

      <h2 id="changes">13. Changes to these terms</h2>
      <p>
        We may update these terms. If a change materially affects you we will give you 30
        days&rsquo; notice by email before it takes effect, and if you do not accept it you may
        terminate before it does without penalty.
      </p>
      <p>We will not change these terms retroactively.</p>

      <h2 id="general">14. General</h2>
      <p>
        <strong>Governing law.</strong> These terms are governed by the laws of India.
      </p>
      <p>
        <strong>Jurisdiction.</strong> The courts of {required("city")} have exclusive
        jurisdiction.
      </p>
      <p>
        <strong>Entire agreement.</strong> These terms, the{" "}
        <a href="/privacy">privacy policy</a>, the <a href="/dpa">data processing agreement</a>{" "}
        and any order form make up the whole agreement between us, and replace anything said or
        written before.
      </p>
      <p>
        <strong>Order of precedence.</strong> If they conflict: the order form, then the data
        processing agreement, then these terms.
      </p>
      <p>
        <strong>Severability.</strong> If any provision is unenforceable, the rest stands.
      </p>
      <p>
        <strong>No waiver.</strong> If we do not enforce something immediately, we have not given
        up the right to enforce it later.
      </p>
      <p>
        <strong>Assignment.</strong> You may not assign this agreement without our written
        consent. We may assign it to a successor in a merger or sale of substantially all our
        assets.
      </p>
      <p>
        <strong>Force majeure.</strong> Neither of us is liable for a failure caused by something
        genuinely outside our reasonable control. This does not excuse paying money that is owed.
      </p>

      <h2 id="contact">15. Contact</h2>
      <ul>
        <li>{name}</li>
        <li>{required("registeredAddress")}</li>
        <li>
          <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
        </li>
      </ul>
    </LegalDocument>
  );
}
