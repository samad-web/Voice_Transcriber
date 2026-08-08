import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Candid, LegalDocument, LegalTable } from "@/components/legal/document";
import { pageMetadata } from "@/lib/metadata";
import { DPA_READY, required } from "@/lib/legal";

export const metadata: Metadata = pageMetadata({
  title: "Data processing agreement",
  description:
    "Aura's obligations when processing your customers' call data: roles under " +
    "India's DPDP Act, the sub-processors, where the data is held, and how " +
    "deletion works.",
  path: "/dpa",
});

/**
 * /dpa — Aura's processor obligations. Forms part of the terms.
 *
 * 404s until `DPA_READY`. See lib/legal.ts.
 *
 * ── TWO DELIBERATE DEPARTURES FROM THE DRAFT ──────────────────────────────
 *
 * 1. **Backblaze B2 is gone from Annex A.** The draft listed it as holding call
 *    recording audio. It holds none: object storage is MinIO running on the
 *    same Hostinger server as the application. A DPA annex is a contractual
 *    statement of who touches the data, and naming a company that touches none
 *    of it is not a harmless copy-paste — it is the term a customer's auditor
 *    checks first. `/security` carried the same error and has been corrected.
 *
 * 2. **Annex C (GDPR) is omitted, not stubbed.** The cover note's own
 *    recommendation: an incomplete Article 28 annex reads as a commitment that
 *    has not been made. There are no EU customers today. When a deal needs it,
 *    it wants the Article 28(3) terms in full, the current Standard Contractual
 *    Clauses with modules and annexes completed, a UK IDTA if UK data is in
 *    scope, and a transfer impact assessment covering the Seoul hosting. That
 *    is a lawyer's work, not a placeholder.
 */
export default function DpaPage() {
  if (!DPA_READY) notFound();

  const name = required("registeredName");
  const privacyEmail = required("privacyEmail");

  return (
    <LegalDocument
      eyebrow="Legal"
      title="Data processing agreement"
      lead="What we may do with your customers' call data, who else touches it, where it sits, and how it is deleted."
      effectiveDate={required("effectiveDate")}
    >
      <p>
        This Data Processing Agreement (&ldquo;<strong>DPA</strong>&rdquo;) forms part of the{" "}
        <a href="/terms">terms of service</a> between {name} (&ldquo;<strong>Aura</strong>&rdquo;,
        &ldquo;<strong>Processor</strong>&rdquo;) and the Customer (&ldquo;you&rdquo;, &ldquo;
        <strong>Data Fiduciary</strong>&rdquo;).
      </p>
      <p>
        Where this DPA and the terms of service conflict on the handling of personal data, this
        DPA wins.
      </p>

      <h2 id="which-law">1. Which law this is written for</h2>
      <p>
        This DPA is drafted for the <strong>Digital Personal Data Protection Act, 2023
        (India)</strong>, under which you are the Data Fiduciary and Aura is a Data Processor
        processing personal data on your behalf under §8(2).
      </p>
      <p>
        If the EU or UK GDPR applies to your use of the Service, tell us before you sign. We will
        agree the Article 28 terms and transfer mechanism with you as part of your order rather
        than publishing a partial annex here.
      </p>

      <h2 id="roles">2. Roles, stated plainly</h2>
      <p>
        <strong>You decide</strong> what calls are recorded, whose calls they are, what fields are
        extracted, who in your organisation may see them, how long they are kept and when they are
        erased.
      </p>
      <p>
        <strong>We do what you have configured and instructed, and nothing else.</strong> We will
        process personal data only:
      </p>
      <ul>
        <li>to provide, maintain and support the Service as described in the terms;</li>
        <li>
          on your documented instructions, which include your configuration of the Service through
          the console and the API; and
        </li>
        <li>
          where the law requires us to do something else, in which case we will tell you before we
          do it, unless the law forbids us from telling you.
        </li>
      </ul>
      <p>
        If we believe an instruction of yours breaks the law, we will tell you and may decline to
        carry it out.
      </p>

      <h2 id="subject-matter">3. Subject matter of the processing</h2>
      <LegalTable>
        <tbody>
          <tr>
            <td>
              <strong>Subject matter</strong>
            </td>
            <td>Provision of the Aura call intelligence service</td>
          </tr>
          <tr>
            <td>
              <strong>Duration</strong>
            </td>
            <td>The term of your subscription, plus the deletion window in §9</td>
          </tr>
          <tr>
            <td>
              <strong>Nature</strong>
            </td>
            <td>
              Recording, upload, storage, transcoding, speech recognition, automated analysis and
              extraction, projection into lead records, dispatch to your configured CRM, deletion
            </td>
          </tr>
          <tr>
            <td>
              <strong>Purpose</strong>
            </td>
            <td>
              Enabling you to capture, search, analyse and act on your own business&rsquo;s
              telephone calls
            </td>
          </tr>
        </tbody>
      </LegalTable>

      <h3 id="data-principals">Categories of Data Principal</h3>
      <ul>
        <li>
          Your customers and prospective customers, and anyone else who is party to a call on an
          enrolled handset
        </li>
        <li>Your employees and contractors who make and receive those calls</li>
        <li>Your staff who hold console accounts</li>
      </ul>

      <h3 id="data-categories">Categories of personal data</h3>
      <ul>
        <li>
          <strong>Audio recordings of telephone calls</strong>, and everything spoken within them
        </li>
        <li>
          <strong>Transcripts</strong> of those recordings
        </li>
        <li>
          <strong>Structured fields extracted</strong> from those transcripts, which will include
          whatever your business discusses: quantities, prices, delivery locations, timelines,
          commitments and objections
        </li>
        <li>
          <strong>Telephone numbers</strong> of both parties, and names where spoken or supplied
        </li>
        <li>
          <strong>Call metadata:</strong> direction, time, duration, the handset and the staff
          member
        </li>
        <li>
          <strong>Console account data:</strong> name, email, role
        </li>
        <li>
          <strong>Audit records:</strong> who did what, to what, from which IP, and when
        </li>
      </ul>

      <Candid title="A call recording is an open-ended category, and neither of us fully controls it.">
        <p>
          It captures whatever the two people said, which may include health information,
          financial details or other sensitive personal data that neither you nor we chose to
          collect. We do not require, request or intentionally process special-category data; if
          it occurs in a recording, it occurs because it was spoken on the call.
        </p>
        <p>
          You should assess this before you enrol a handset, and configure retention accordingly.
        </p>
      </Candid>

      <h2 id="our-obligations">4. Our obligations</h2>
      <p>We will:</p>
      <ol>
        <li>process personal data only as set out in §2;</li>
        <li>
          keep the security measures in Annex B in place, and not materially weaken them during
          the term;
        </li>
        <li>
          ensure the people we allow to access personal data are bound by an appropriate duty of
          confidentiality;
        </li>
        <li>not engage a sub-processor except under §5;</li>
        <li>
          assist you, so far as we reasonably can, with responding to Data Principal requests,
          given the nature of the processing and the information available to us;
        </li>
        <li>
          assist you with your obligations on security, breach notification and any impact
          assessment, taking into account what we know and what we do;
        </li>
        <li>
          tell you without undue delay, and in any event within 72 hours of becoming aware, if
          there is a personal data breach affecting your data, with what we know at the time and
          updates as we learn more;
        </li>
        <li>delete or return personal data as set out in §9;</li>
        <li>
          make available the information reasonably needed to demonstrate compliance with this
          DPA, and allow audits as set out in §10.
        </li>
      </ol>

      <h2 id="sub-processors">5. Sub-processors</h2>
      <p>You give general authorisation for the sub-processors listed in Annex A.</p>
      <p>
        We will give you 30 days&rsquo; written notice before adding or replacing a sub-processor.
        If you reasonably object on data protection grounds within that period, we will work with
        you in good faith to find an alternative, and if we cannot, you may terminate the affected
        part of the Service without penalty for the unexpired term.
      </p>
      <p>
        We will impose data protection obligations on each sub-processor that are no less
        protective than those in this DPA, and we remain fully liable to you for their
        performance.
      </p>

      <h2 id="where">6. Where data is processed</h2>
      <p>
        Personal data is processed in the locations set out in Annex A.{" "}
        <strong>This includes processing outside India.</strong> Specifically, the primary
        database is hosted in <strong>ap-northeast-2 (Seoul, South Korea)</strong>.
      </p>
      <p>
        Under §16 of the DPDP Act, personal data may be transferred outside India except to a
        country the Central Government restricts by notification. South Korea is not currently
        restricted. If that changes, we will tell you and agree a plan to migrate.
      </p>
      <p>
        We are stating the hosting region in the body of this DPA rather than burying it in an
        annex, because it is the fact most likely to matter to your assessment.
      </p>

      <h2 id="requests">7. Data Principal requests</h2>
      <p>
        If a Data Principal contacts us directly about data we process for you, we will not
        respond substantively. We will tell them to contact you, and pass their request to you
        within {required("requestForwardingDays")} business days.
      </p>
      <p>
        The Service gives you the tools to answer these yourself: search across your calls, export,
        and erasure that cascades through audio, transcript, model outputs, extracted facts, lead,
        CRM dispatch log and the call record, ending in a cryptographically signed deletion receipt
        in your audit log.
      </p>
      <p>
        Where you cannot achieve it with those tools, we will assist. Write to{" "}
        <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>.
      </p>

      <h2 id="retention">8. Retention</h2>
      <p>
        Each organisation has its own retention period, which you set.{" "}
        <strong>The default is 90 days</strong>, and deletion runs automatically on that clock.
      </p>
      <p>
        You are responsible for choosing a period appropriate to your legal obligations and your
        purpose. We will not silently keep data beyond the period you set.
      </p>

      <h2 id="deletion">9. Deletion and return</h2>
      <p>
        On termination or expiry, you may export your data for {required("exportWindowDays")}{" "}
        days. After that window we will delete personal data processed on your behalf within{" "}
        {required("deletionWindowDays")} days, except where the law requires us to keep it, in
        which case we will tell you what we are keeping and why.
      </p>
      <p>
        Deletion cascades across audio storage, transcripts, model outputs, extracted facts,
        leads, CRM dispatch logs and call records. <strong>It is not reversible.</strong>
      </p>

      <h2 id="audits">10. Audits</h2>
      <p>
        We will provide, on reasonable request and no more than once a year unless a breach or a
        regulator requires otherwise, the information reasonably necessary to demonstrate
        compliance with this DPA.
      </p>
      <p>
        Where that is not sufficient for your obligations, you may audit on reasonable notice,
        during business hours, at your cost, under confidentiality, without disrupting the
        Service, and by an auditor who is not a competitor of ours.
      </p>

      <h2 id="liability">11. Liability</h2>
      <p>
        Liability under this DPA is subject to the limitations in the{" "}
        <a href="/terms">terms of service</a>, except where the law does not permit those
        limitations to apply.
      </p>

      <h2 id="annex-a">Annex A: sub-processors</h2>
      <LegalTable>
        <thead>
          <tr>
            <th>Sub-processor</th>
            <th>Purpose</th>
            <th>Location</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Supabase (managed Postgres)</td>
            <td>Calls, transcripts, extracted fields, leads, audit log</td>
            <td>ap-northeast-2 (Seoul, South Korea)</td>
          </tr>
          <tr>
            <td>Hostinger</td>
            <td>
              Application and worker servers, and the object storage holding call recording audio
            </td>
            <td>Stated in your order form</td>
          </tr>
          <tr>
            <td>Sarvam AI</td>
            <td>Indic speech recognition and call analysis</td>
            <td>India</td>
          </tr>
          <tr>
            <td>Google (Gemini)</td>
            <td>Call analysis where Sarvam is not the configured provider</td>
            <td>Google&rsquo;s infrastructure for the Gemini API</td>
          </tr>
        </tbody>
      </LegalTable>
      <p>
        Call recording audio is held in object storage we operate ourselves on the Hostinger
        servers above. It is not with a third-party storage provider.
      </p>

      <h2 id="annex-b">Annex B: technical and organisational measures</h2>
      <p>
        Stated as mechanisms rather than adjectives. Aura holds{" "}
        <strong>no security certification</strong>, no SOC 2, no ISO 27001, and does not claim
        one.
      </p>

      <h3>Separation between customers</h3>
      <ul>
        <li>
          Every table holding customer data carries a Postgres row-level security policy keyed to
          the organisation, set to <code>FORCE</code>, so it applies even to the table owner.
        </li>
        <li>
          The application database role is created{" "}
          <code>NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS</code>. It is not privileged to
          bypass the policy.
        </li>
        <li>
          An automated check runs over the schema and fails if any table carrying an organisation
          identifier lacks that protection, so the guarantee cannot silently erode.
        </li>
        <li>
          The marketing enquiry database connects as a separate role scoped to the marketing
          schema, with no access to any customer data.
        </li>
      </ul>

      <h3>In transit</h3>
      <ul>
        <li>Recordings are uploaded from the handset over TLS.</li>
      </ul>

      <h3>At rest</h3>
      <ul>
        <li>
          On-device encryption before upload is an available setting and is{" "}
          <strong>off by default</strong>. Enabling it is the Customer&rsquo;s decision.
        </li>
        <li>Storage-layer encryption at rest is as provided by the providers in Annex A.</li>
      </ul>

      <h3>Access control</h3>
      <ul>
        <li>Console access is authenticated per user and scoped to one organisation.</li>
        <li>
          Platform-operator access is restricted to an explicit allowlist and fails closed: an
          account not on the list has no console access.
        </li>
      </ul>

      <h3>Auditability</h3>
      <ul>
        <li>
          Privileged actions are recorded with organisation, actor type, actor identity, action,
          target, originating IP address and timestamp.
        </li>
        <li>Erasure produces a cryptographically signed receipt in that log.</li>
      </ul>

      <h3>Deletion</h3>
      <ul>
        <li>Per-organisation retention, defaulting to 90 days, enforced by a scheduled job.</li>
        <li>Erasure cascades across every artefact derived from a call.</li>
      </ul>
    </LegalDocument>
  );
}
