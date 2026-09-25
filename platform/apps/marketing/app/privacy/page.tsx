import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Candid, LegalDocument, LegalTable } from "@/components/legal/document";
import { pageMetadata } from "@/lib/metadata";
import { PRIVACY_READY, required } from "@/lib/legal";
import { CONSOLE_URL, SITE_URL } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "Privacy policy",
  description:
    "How Aura handles personal data: what the enquiry form collects, the single " +
    "cookie the site sets, where customer call recordings are stored, and the " +
    "rights you have under India's DPDP Act.",
  path: "/privacy",
});

/**
 * /privacy - the document India's DPDP Act 2023 §5 actually requires.
 *
 * ── IT 404s UNTIL THE FACTS ARE REAL ───────────────────────────────────────
 *
 * `PRIVACY_READY` is false while any required value in lib/legal.ts is unset,
 * and this returns `notFound()` rather than rendering the page with holes in
 * it. §11 names a grievance officer; publishing that section with a placeholder
 * would be a false statutory disclosure, and every other gap here is a fact
 * only the business can supply. The footer reads the same flag, so an
 * unpublished policy is never linked.
 *
 * ── EVERY TECHNICAL CLAIM BELOW WAS READ FROM THE SOURCE ───────────────────
 *
 *   one cookie, signed/httpOnly/Lax/2h    lib/funnel/session.ts
 *   salted IP hash, never the raw address lib/funnel/signing.ts:107-119
 *   the enquiry fields                    0020_funnel_submissions.sql:75-113
 *   consent text + timestamp stored       same migration
 *   marketing role reaches only its schema 0020:66-67, 245-255
 *   RLS forced, app role cannot bypass    0001_init.sql:11-12, 338, 348
 *   the isolation check                   packages/db/verify-rls.js
 *   erasure cascades + signed receipt     erasure.controller.ts
 *   audit fields                          audit_log, 0001_init.sql:287
 *   handset encryption off by default     CaptureSettings.kt:49-55
 *   uploads over TLS                      UploadWorker.kt:103-108
 *   no analytics, self-hosted fonts       app/layout.tsx (next/font), next.config.ts
 *
 * Anything that could not be verified is a value in lib/legal.ts, not a
 * sentence written here - which is why this page cannot be published with a
 * plausible-sounding guess in it.
 */
export default function PrivacyPage() {
  if (!PRIVACY_READY) notFound();

  const name = required("registeredName");
  const privacyEmail = required("privacyEmail");
  const contactEmail = required("contactEmail");
  const securityEmail = required("securityEmail");

  return (
    <LegalDocument
      eyebrow="Legal"
      title="Privacy policy"
      lead="What we collect, why, who it goes to, and what you can make us do about it."
      effectiveDate={required("effectiveDate")}
    >
      <h2 id="two-relationships">1. There are two different relationships here</h2>
      <p>
        This matters more than anything else in the document, so it is first.
      </p>
      <p>
        <strong>If you are visiting this website or filling in our enquiry form</strong>, we
        decide why and how your personal data is used. Under India&rsquo;s Digital Personal Data
        Protection Act, 2023 (the &ldquo;DPDP Act&rdquo;) we are the Data Fiduciary. Part A
        applies to you.
      </p>
      <p>
        <strong>If your employer uses Aura</strong>, and Aura is processing recordings of calls
        between your company and its customers, then your company decides why and how that data
        is used. Your company is the Data Fiduciary; we act only on its instructions and are the
        Data Processor. Part B applies, and it is deliberately narrow: we do not decide what
        happens to your call data, and we cannot grant requests about it that your company has
        not authorised.
      </p>
      <p>
        If you are an individual who was recorded on a call with a business that uses Aura, your
        rights are against that business, not against us. We will tell you who they are and
        forward your request to them. See §10.
      </p>

      <h2 id="who-we-are">2. Who we are</h2>
      <p>
        {name}, operating as <strong>Aura</strong>.
      </p>
      <ul>
        <li>
          <strong>Registered office:</strong> {required("registeredAddress")}
        </li>
        <li>
          <strong>CIN / registration number:</strong> {required("registrationNumber")}
        </li>
        <li>
          <strong>Website:</strong> <a href={SITE_URL}>{SITE_URL.replace(/^https?:\/\//, "")}</a>
        </li>
        <li>
          <strong>Customer console:</strong>{" "}
          <a href={CONSOLE_URL}>{CONSOLE_URL.replace(/^https?:\/\//, "")}</a>
        </li>
        <li>
          <strong>Privacy contact:</strong> <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>
        </li>
      </ul>

      <h2 id="part-a">Part A: if you visit this site or contact us</h2>

      <h3 id="what-we-collect">3. What we collect, and why</h3>
      <p>
        There is no chat widget on this site, and our fonts are served from our own servers
        rather than Google&rsquo;s.
      </p>
      <p>
        <strong>
          We use the Meta (Facebook) advertising pixel, Google Tag Manager and Microsoft Clarity,
          and none of them wait for your consent.
        </strong>{" "}
        They load on every page view, for every visitor, as soon as the page is interactive. We
        do not ask first, and there is no control on this site to opt out.
      </p>
      <p>
        <strong>Lawful basis:</strong> legitimate interest, as the site owner, in measuring
        advertising performance and understanding how the site is used. We are not relying on
        your consent for these three.
      </p>
      <p>
        The Meta pixel and Google Tag Manager tell Meta and Google that a browser visited a page
        here, and separately when someone books a call. They receive your IP address and a cookie
        identifier, and Meta may link those to a Facebook or Instagram account it already holds.
        Microsoft Clarity records how visitors use this site - page views, clicks and scrolling -
        as session recordings and heatmaps, and receives your IP address, browser and device
        details. Clarity masks form input by default; we do not configure it to record what you
        type into the enquiry form. We do not send any of the three your name, email address or
        phone number. Their own controls are at{" "}
        <a href="https://www.facebook.com/adpreferences" rel="nofollow noreferrer">
          facebook.com/adpreferences
        </a>{" "}
        and{" "}
        <a href="https://clarity.microsoft.com/" rel="nofollow noreferrer">
          clarity.microsoft.com
        </a>
        .
      </p>
      <p>Beyond that, we collect personal data only when you give it to us.</p>

      <h3 id="enquiry-form">3.1 When you fill in our enquiry form</h3>
      <LegalTable>
        <thead>
          <tr>
            <th>What</th>
            <th>Why we need it</th>
          </tr>
        </thead>
        <tbody>
          {[
            ["Your name", "To address you correctly when we reply"],
            ["Your email address", "To reply to your enquiry"],
            [
              "Your phone number",
              "To call you back, because most of our enquirers prefer a call",
            ],
            ["Your WhatsApp number, if different", "To reply on the channel you chose"],
            ["Your country", "To interpret your phone number correctly"],
            ["The type of business you run", "To judge whether Aura actually suits you"],
            ["How many people make calls", "The same"],
            ["Your monthly budget range", "To tell you honestly and early if we are not a fit"],
            ["Where you are in your decision", "To pitch the conversation at the right level"],
            [
              "Whether you use a CRM, and which one",
              "To tell you whether we already connect to it",
            ],
            ["Whether you want a CRM built for you", "To route you to the right person"],
            [
              "The exact consent wording you agreed to, and when",
              "To prove what you agreed to, if it is ever questioned",
            ],
            [
              "Campaign parameters in the link you arrived through",
              "To know which of our efforts brought you here",
            ],
          ].map(([what, why]) => (
            <tr key={what}>
              <td>{what}</td>
              <td>{why}</td>
            </tr>
          ))}
        </tbody>
      </LegalTable>
      <p>
        <strong>Lawful basis (DPDP Act §6):</strong> your consent, given by ticking the unticked
        consent box on the form. We do not pre-tick it. If you do not tick it, the form does not
        submit.
      </p>
      <p>
        We record the exact text of the consent you agreed to and the timestamp, so that if you
        ever ask us what you agreed to we can show you the actual sentence rather than our
        current wording.
      </p>

      <h3 id="abuse">3.2 To stop the form being abused</h3>
      <p>
        We limit how many times the same person or connection can submit the form. To do that we
        store a <strong>salted, one-way cryptographic hash</strong> of your IP address, and never
        the address itself. The hash cannot be reversed to recover your IP, and we do not retain
        the IP anywhere else in this system.
      </p>

      <h3 id="what-we-dont">3.3 What we do not collect on this website</h3>
      <ul>
        <li>We do not buy contact data about you from anyone.</li>
        <li>
          We do not sell, rent, or share your details with any third party for their own
          marketing. Not now, and this is not a policy we intend to change quietly. If it ever
          changed we would have to ask you again.
        </li>
      </ul>

      <h3 id="cookies">4. Cookies</h3>
      <p>One cookie of our own.</p>
      <LegalTable>
        <thead>
          <tr>
            <th>Name</th>
            <th>Purpose</th>
            <th>Lifetime</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>aura_funnel_sid</code>
            </td>
            <td>
              Remembers, between step 1 and step 2 of the enquiry form, which submission is yours
            </td>
            <td>2 hours</td>
          </tr>
        </tbody>
      </LegalTable>
      <p>
        It is cryptographically signed so it cannot be forged, marked <code>httpOnly</code> so no
        JavaScript on the page can read it, and marked <code>SameSite=Lax</code> so another
        website cannot use it. It contains an internal reference number and a timestamp. It
        contains no personal data and is not used to track you.
      </p>
      <p>
        We do not use it for analytics or advertising. It is strictly necessary for the form to
        work, which is why you are not asked to consent to it separately. The Meta pixel, Google
        Tag Manager and Microsoft Clarity described in §3 set their own cookies, which are not
        ours and are not covered by that exemption.
      </p>
      <p>
        This is the cookie count for this marketing website. If you are a signed-in user of the
        console, see §9, which covers the cookies the console itself sets.
      </p>

      <h3 id="retention">5. How long we keep your enquiry</h3>
      <p>
        We keep what you send through the enquiry form for{" "}
        <strong>{required("enquiryRetentionDays")} days</strong>, after which it is deleted. If
        you become a customer, your enquiry becomes part of the contractual record and is kept
        for as long as the account, plus the period in §13.
      </p>
      <p>
        You can ask us to delete your enquiry at any time before then. See §10.
      </p>

      <h2 id="part-b">Part B: if your company uses Aura</h2>

      <h3 id="our-role">6. Our role, stated narrowly</h3>
      <p>
        When your company uses Aura, we process the following on its instructions and for no
        other purpose:
      </p>
      <ul>
        <li>
          audio recordings of calls made or received on enrolled handsets, and the transcripts
          generated from them;
        </li>
        <li>
          the fields extracted from those transcripts: quantities, prices, locations,
          commitments, and whatever other fields your company has configured;
        </li>
        <li>
          leads and contacts, and the records your team creates about them in the CRM: notes,
          tasks, stage and pipeline data;
        </li>
        <li>
          conversations from messaging channels your organisation connects, such as WhatsApp,
          including message content and the phone numbers involved;
        </li>
        <li>
          mail, calendar and spreadsheet data from any mailbox, calendar or Google Sheet a member
          of your team chooses to connect, limited to the access they grant when connecting it;
        </li>
        <li>the phone numbers and names of the people on your calls, conversations and leads;</li>
        <li>records of which of your staff handled which call, conversation or lead.</li>
      </ul>
      <p>
        <strong>We do not use any of it for our own purposes.</strong> Specifically: we do not
        use your call recordings, transcripts, messages, connected mailbox data or any other
        Customer Data to train, fine-tune or evaluate any machine learning model of ours, we do
        not use it to build any product feature for another customer, and we do not analyse it in
        aggregate across customers.
      </p>
      <p>
        Your company decides what is recorded and connected, who may access it, how long it is
        kept, and when it is deleted. We give them the controls; they make the decisions.
      </p>
      <p>
        Where you connect an email, calendar or spreadsheet account, or a messaging channel such
        as WhatsApp, that connection runs on your own account with that provider. If your
        organisation has not registered its own app with Google or Microsoft, the connection uses
        Aura&rsquo;s own registered app to complete the sign-in; either way, it is your
        organisation&rsquo;s account, and only the access it grants, that gets used - not ours.
        Messages sent or received over WhatsApp necessarily also pass through WhatsApp&rsquo;s own
        network, operated by Meta, the same as they would if you used WhatsApp directly; if your
        organisation routes its WhatsApp connection through a WhatsApp Business Solution Provider
        of its own choosing, that provider processes the same traffic under its own agreement with
        your organisation, not with us.
      </p>

      <h3 id="customer-obligations">7. Your company&rsquo;s obligations, not ours</h3>
      <p>
        Recording a phone call engages the law. The business operating the handset is responsible
        for telling the people on the call that it is being recorded and obtaining whatever
        consent applies, for having a lawful basis for the recording, and for responding to
        requests from the individuals recorded.
      </p>
      <p>
        We publish guidance on this at <a href="/consent">/consent</a>, but guidance is not
        advice and we are not your lawyer. If you are a customer and you have not addressed this,
        address it before you enrol a handset.
      </p>

      <h3 id="sub-processors">8. Sub-processors</h3>
      <p>
        We use the following providers to run the service. Each one is bound by contract to
        process data only on our instructions.
      </p>
      <LegalTable>
        <thead>
          <tr>
            <th>Sub-processor</th>
            <th>What it does</th>
            <th>Where it runs</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Supabase (managed Postgres)</td>
            <td>Calls, transcripts, extracted fields, leads and the audit log</td>
            <td>
              <strong>ap-northeast-2 (Seoul, South Korea), not India</strong>
            </td>
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
          <tr>
            <td>Hostinger</td>
            <td>
              The application and worker servers, and the object storage holding call recording
              audio
            </td>
            <td>Region set per deployment, stated in your contract</td>
          </tr>
        </tbody>
      </LegalTable>

      <Candid title="We want to be direct about the first row.">
        <p>
          Your customers&rsquo; call recordings are stored on infrastructure in South Korea, not
          in India. The DPDP Act permits transfer outside India except to countries the Central
          Government restricts, and South Korea is not currently restricted.
        </p>
        <p>
          We are telling you this on the page rather than in an appendix because you should find
          it out from us, and not from your own IT team after you have signed.
        </p>
      </Candid>

      <p>
        We will give <strong>30 days&rsquo;</strong> notice before adding or replacing a
        sub-processor, so that you have the opportunity to object.
      </p>

      <h3 id="protection">9. How the data is protected</h3>
      <p>
        These are mechanisms, not adjectives. We have deliberately not used the phrases
        &ldquo;bank-grade&rdquo;, &ldquo;military-grade&rdquo; or &ldquo;enterprise-grade&rdquo;
        anywhere, and we hold no certification we have not named.
      </p>
      <ul>
        <li>
          <strong>Separation between customers is enforced by the database, not by our code.</strong>{" "}
          Every table holding customer data carries a Postgres row-level security policy keyed to
          the organisation, set to <em>force</em>, so it applies even to the table&rsquo;s owner.
          The application connects using a database role created explicitly without the privilege
          to bypass it. An automated check runs over the schema and fails if any table carrying an
          organisation identifier is missing that protection.
        </li>
        <li>
          <strong>In transit</strong>, recordings are uploaded over TLS.
        </li>
        <li>
          <strong>Deletion cascades.</strong> When a call is erased, the stored audio object, the
          lead, the transcript, the model outputs, the extracted facts, the CRM dispatch log and
          the call record itself are all removed, and a cryptographically signed receipt is
          written to the audit log.
        </li>
        <li>
          <strong>Every privileged action is logged</strong> with the organisation, who did it,
          what they did, what they did it to, the originating IP and the time.
        </li>
        <li>
          <strong>The marketing database is separate.</strong> The enquiry form connects using a
          database role that has access to the marketing schema and to nothing else. It cannot
          reach any customer&rsquo;s call data, by construction and not by convention.
        </li>
        <li>
          <strong>The console sets its own cookies once you sign in</strong>, separate from the
          one described in §4: to keep you signed in, to remember which organisation you are
          currently working in, and to remember interface preferences such as your theme. These
          are strictly necessary for the console to work and are not used for analytics or
          advertising.
        </li>
      </ul>

      <Candid title="On-device encryption is off by default.">
        <p>
          Encrypting a recording on the handset before it is uploaded is an available setting, and
          it is <strong>not enabled unless the customer enables it</strong>. We state it here
          because a customer should not discover a default like that from us later.
        </p>
      </Candid>

      <p>
        No system is perfectly secure, and anyone who tells you otherwise is selling something. If
        we suffer a personal data breach we will notify the Data Protection Board of India and
        affected Data Principals as required by the DPDP Act, and affected customers without undue
        delay and in any event within 72 hours of becoming aware. Security issues can be reported
        to <a href={`mailto:${securityEmail}`}>{securityEmail}</a>.
      </p>

      <h2 id="part-c">Part C: applies to everyone</h2>

      <h3 id="your-rights">10. Your rights</h3>
      <p>Under the DPDP Act you may:</p>
      <ul>
        <li>
          <strong>ask what we hold about you</strong>, and why;
        </li>
        <li>
          <strong>have it corrected</strong> if it is wrong, incomplete or out of date;
        </li>
        <li>
          <strong>have it erased</strong>, where we no longer need it for the purpose you gave it
          for;
        </li>
        <li>
          <strong>withdraw your consent</strong> at any time, as easily as you gave it;
        </li>
        <li>
          <strong>nominate someone</strong> to exercise these rights on your behalf if you die or
          become incapacitated;
        </li>
        <li>
          <strong>complain</strong> to us first, and then to the Data Protection Board of India.
        </li>
      </ul>
      <p>
        To exercise any of these, write to <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>.
        We will respond within {required("rightsResponseDays")} days.
      </p>
      <p>
        <strong>If your request is about a call recording</strong>, we will almost certainly have
        to refer you to the business that made the recording, because the data is theirs and not
        ours. We will tell you who they are and pass your request on within 7 days.
      </p>
      <p>
        Withdrawing consent does not undo anything we lawfully did before you withdrew it.
      </p>

      <h3 id="grievance">11. Grievance officer</h3>
      <p>
        The DPDP Act and the IT Rules require us to name a person you can escalate to. That person
        is:
      </p>
      <ul>
        <li>
          <strong>Name:</strong> {required("grievanceOfficerName")}
        </li>
        <li>
          <strong>Designation:</strong> {required("grievanceOfficerTitle")}
        </li>
        <li>
          <strong>Email:</strong>{" "}
          <a href={`mailto:${required("grievanceOfficerEmail")}`}>
            {required("grievanceOfficerEmail")}
          </a>
        </li>
        <li>
          <strong>Postal address:</strong> {required("grievanceAddress")}
        </li>
        <li>
          <strong>Telephone:</strong> {required("telephone")}
        </li>
      </ul>
      <p>
        If we do not resolve your complaint to your satisfaction, you may escalate to the Data
        Protection Board of India.
      </p>

      <h3 id="children">12. Children</h3>
      <p>
        Aura is a business product, sold to businesses, and is not directed at children. We do not
        knowingly collect personal data from anyone under 18. If you believe a child&rsquo;s data
        has reached us, write to <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a> and we will
        delete it.
      </p>

      <h3 id="changes">13. Changes to this policy</h3>
      <p>
        If we change this policy in a way that materially affects you, we will post the change here
        and update the date at the top, and if you are a customer we will email you 30 days before
        it takes effect. We will not quietly broaden what we do with data you have already given
        us; that would require asking you again.
      </p>

      <h3 id="contact">14. Contact</h3>
      <ul>
        <li>
          <strong>Privacy questions:</strong>{" "}
          <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>
        </li>
        <li>
          <strong>Everything else:</strong>{" "}
          <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
        </li>
        <li>
          <strong>Post:</strong> {required("registeredAddress")}
        </li>
      </ul>
    </LegalDocument>
  );
}
