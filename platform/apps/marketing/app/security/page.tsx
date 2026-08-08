import type { Metadata } from "next";
import { Container, Section, SectionHeading } from "@/components/ui/layout";
import { ComparisonTable, Prose } from "@/components/ui/content";
import { TextLink } from "@/components/ui/button";
import { WhatsAppCta } from "@/components/ui/whatsapp-cta";
import { pageMetadata } from "@/lib/metadata";
import { WA_MESSAGES } from "@/lib/site";

export const metadata: Metadata = pageMetadata({
  title: "How Aura handles your data",
  description:
    "Tenant isolation enforced by Postgres row-level security, per-organisation " +
    "retention, cascading erasure with a signed receipt, an org-scoped audit log, " +
    "and a named sub-processor list including where each one runs.",
  path: "/security",
});

/**
 * /security — P0 (doc 10 §3), the page that answers objection #1.
 *
 * EVERY CLAIM ON THIS PAGE WAS CHECKED AGAINST THE SOURCE. Doc 10 §15: no
 * "SOC 2", no "99.9% uptime", no "enterprise-grade security" as a bare phrase —
 * none of which exist, and none of which this page says. The mechanisms that DO
 * exist are strong enough on their own, and they are what is written here:
 *
 *   RLS isolation   packages/db/migrations/0001_init.sql — `aura_app` is created
 *                   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS (:11-12) and
 *                   every tenant table gets FORCE ROW LEVEL SECURITY (:338, :348).
 *                   packages/db/verify-rls.js asserts the invariant across every
 *                   org_id table, so it cannot silently regress.
 *   retention       organizations.retention_days, default 90 (0001_init.sql:27);
 *                   apps/worker/src/pipeline/reaper.ts deletes on that clock.
 *   erasure         apps/api/src/modules/tenancy/erasure.controller.ts — S3 object
 *                   → lead → transcript → ai_outputs → call_facts → crm_sync_log →
 *                   call row, then an HMAC-signed receipt in the audit log.
 *   audit log       audit_log (0001_init.sql:287): org_id, actor_type, actor_id,
 *                   action, target, ip, meta, created_at.
 *
 * TWO THINGS THIS PAGE DELIBERATELY VOLUNTEERS, because being caught is worse
 * than being upfront (doc 10 §11):
 *   - Postgres runs in ap-northeast-2 (Seoul), not India.
 *   - On-device encryption is an optional at-rest setting, OFF by default, and
 *     the upload itself is protected by TLS, not by that setting
 *     (CaptureSettings.kt:49-55, UploadWorker.kt:103-108).
 */

/**
 * CORRECTED 2026-08-09. This table used to name **Backblaze B2** as holding call
 * recording audio. It does not and never has: object storage is MinIO, running
 * as a container on the same Hostinger server as the application
 * (`S3_ENDPOINT=https://minio:9000`, an internal compose address, published at
 * `storage.aura.sirahagents.com`). Naming a sub-processor that holds none of
 * the data is a false disclosure on the one page whose whole job is accurate
 * disclosure, and it would have gone into the DPA as a contractual term.
 *
 * Note for whoever reads `S3_REGION=ap-northeast-2` in the environment and
 * assumes it means Seoul: it does not. MinIO takes a region string to satisfy
 * SigV4 request signing; it names no datacentre. The bytes are wherever the
 * Hostinger VPS physically is, which is why that row says to confirm it rather
 * than guessing from a config value.
 */
const SUBPROCESSORS = [
  {
    name: "Supabase (Postgres)",
    purpose: "Your calls, transcripts, extracted fields, leads and audit log",
    region: "ap-northeast-2 (Seoul), not India",
  },
  {
    name: "Sarvam AI",
    purpose: "Indic speech recognition and call analysis",
    region: "India",
  },
  {
    name: "Google (Gemini)",
    purpose: "Call analysis where Sarvam is not the configured provider",
    region: "Google's infrastructure for the Gemini API",
  },
  {
    name: "Hostinger",
    purpose:
      "The application and worker servers, and the object storage holding call recording audio",
    region: "See your contract; region is set per deployment",
  },
];

export default function SecurityPage() {
  return (
    <>
      <Container className="pt-12 sm:pt-16">
        <div className="max-w-3xl">
          <p className="text-sm font-medium text-accent-text">Your data</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text text-balance sm:text-5xl">
            How Aura handles your data
          </h1>
          <p className="mt-6 text-xl text-text-muted text-pretty">
            You are considering letting software listen to conversations with your
            customers. That deserves specifics, not adjectives. This page says what the
            system actually does, including the parts that are not finished.
          </p>
        </div>
      </Container>

      <Section id="isolation" labelledBy="isolation-heading">
        <SectionHeading
          id="isolation-heading"
          as="h2"
          title="Isolation is enforced by the database, not by our code"
        />
        <Prose className="mt-6">
          <p>
            Most multi-customer software keeps tenants apart by adding a filter to
            every query. That works until one query forgets, and the failure is silent
            until it is a headline.
          </p>
          <p>
            Aura does it a level lower. Every table that holds your data carries a
            Postgres row-level security policy keyed to your organisation, and the
            policies are set to <strong>force</strong>, meaning they apply even to the
            table&rsquo;s owner. The application connects as a database role created
            specifically without the privilege to bypass row-level security. It is not
            that our code always remembers to filter; it is that the database will not
            return your neighbour&rsquo;s rows to a query that asks for them.
          </p>
          <p>
            A check runs over the schema and fails the build if any table carrying an
            organisation id is missing that protection, so the guarantee cannot quietly
            erode as the product grows.
          </p>
        </Prose>
      </Section>

      <Section id="in-transit" tone="subtle" labelledBy="transit-heading">
        <SectionHeading
          id="transit-heading"
          as="h2"
          title="Getting the recording off the phone"
        />
        <Prose className="mt-6">
          <p>
            The Aura app uploads over TLS and nothing else. The release build ships a
            network policy that refuses plaintext HTTP outright, so a
            misconfigured network cannot downgrade it. Uploads go to storage through a
            short-lived signed URL issued for that one file.
          </p>
          <p>
            The app can also encrypt recordings at rest on the handset itself
            (AES-256-GCM), which protects the file while it is sitting on the device
            waiting for signal. <strong>That setting is off by default</strong> and it
            is separate from the upload protection. We would rather tell you exactly
            which control does what than describe both as &ldquo;end-to-end
            encryption&rdquo;, which this is not.
          </p>
        </Prose>
      </Section>

      <Section id="retention" labelledBy="retention-heading">
        <SectionHeading
          id="retention-heading"
          as="h2"
          title="Retention and erasure"
        />
        <Prose className="mt-6">
          <p>
            Your organisation has a retention window. It is 90 days out of the box and
            it is yours to set. A scheduled job deletes calls past that window:
            recording, transcript and everything derived from them, without anyone
            having to remember.
          </p>
          <p>
            You can also erase a single call on request. That removes the audio from
            object storage and cascades through the transcript, the AI output, the
            extracted fields, the projected lead and the CRM delivery log, then writes a
            cryptographically signed receipt into your audit log. The receipt is the
            evidence. It is what you show when someone asks you to prove a deletion
            happened.
          </p>
          <p>
            One limit worth stating: if a lead was already delivered into your own CRM,
            that copy lives in your CRM and is yours to delete there. We log the
            delivery so you know where to look.
          </p>
        </Prose>
      </Section>

      <Section id="audit" tone="subtle" labelledBy="audit-heading">
        <SectionHeading id="audit-heading" as="h2" title="The audit log" />
        <Prose className="mt-6">
          <p>
            Administrative actions against your data are recorded with who did it, what
            they did, what they did it to, when, and from which address. The log is
            scoped to your organisation by the same row-level security as everything
            else, so it is yours and only yours.
          </p>
        </Prose>
      </Section>

      <Section id="subprocessors" labelledBy="sub-heading">
        <SectionHeading
          id="sub-heading"
          as="h2"
          title="Who else touches your data, and where they run"
          lead="Named, with regions, including the one that is not in India."
        />
        <div className="mt-8">
          <ComparisonTable
            caption="Sub-processors, their purpose and the region they operate in"
            columns={["Sub-processor", "What it does", "Where it runs"]}
            rows={SUBPROCESSORS.map((s) => ({
              header: s.name,
              cells: [s.purpose, s.region],
            }))}
          />
        </div>
        <Prose className="mt-6">
          <p>
            <strong>Our Postgres database currently runs in Seoul, not in India.</strong>{" "}
            If your organisation has a data-residency requirement, that matters and you
            should raise it before you sign anything. We are telling you here rather
            than waiting to be asked.
          </p>
        </Prose>
      </Section>

      <Section id="not-yet" tone="subtle" labelledBy="notyet-heading">
        <SectionHeading
          id="notyet-heading"
          as="h2"
          title="What we do not have"
          lead="A security page that only lists strengths is not a security page."
        />
        <Prose className="mt-6">
          <ul>
            <li>
              <strong>No SOC 2 or ISO 27001.</strong> We have not been audited against
              either, and we are not going to imply otherwise.
            </li>
            <li>
              <strong>No published uptime SLA.</strong> We do not yet measure
              availability well enough to promise a number, so we do not promise one.
            </li>
            <li>
              <strong>No single sign-on or SAML.</strong> Access is by email login with
              role-based permissions.
            </li>
            <li>
              <strong>The privacy policy and data processing agreement are in legal
              review</strong> and are not published yet. If you need a DPA before you
              start, tell us and we will tell you the honest timeline.
            </li>
            <li>
              <strong>Data residency in India is not available today</strong>. See the
              sub-processor table above.
            </li>
          </ul>
          <p>
            If any of these is a blocker for your business, say so early. It is a
            better conversation than discovering it during procurement.
          </p>
        </Prose>
        <div className="mt-8">
          <WhatsAppCta message={WA_MESSAGES.footer} size="lg">
            Ask us a security question
          </WhatsAppCta>
        </div>
      </Section>

      {/* The pixel disclosure lives HERE, not only in the privacy policy.
          /privacy is gated behind lib/legal.ts until the company facts exist,
          so it currently 404s — and the pixel is live. Putting the disclosure
          only there would mean the site tracks visitors and tells them nothing
          until an unrelated blocker clears. This page is published today.
          The consent banner links to #advertising below. */}
      <Section id="advertising" tone="subtle" labelledBy="adv-heading">
        <SectionHeading
          id="adv-heading"
          as="h2"
          title="Advertising and tracking"
          lead="One third-party tracker, and it does not load unless you say yes."
        />
        <Prose className="mt-6">
          <p>
            We use the <strong>Meta (Facebook) advertising pixel</strong> to measure which of our
            advertisements bring people to this site, and to show advertisements to people who
            have visited. It tells Meta that a browser visited a page here, and separately when
            someone books a call.
          </p>
          <p>
            <strong>It does not load until you accept it.</strong> Until then no script runs and
            no request reaches Meta at all. If you decline, we remember that and do not ask
            again. Nothing on this site needs it, so declining changes nothing about how it
            works.
          </p>
          <p>
            When it is on, Meta receives your IP address and a cookie identifier, and may link
            those to a Facebook or Instagram account it already holds. We do not send it your
            name, email address or phone number. You can change your mind at any time by clearing
            this site&rsquo;s storage in your browser, and Meta&rsquo;s own controls are at{" "}
            <TextLink href="https://www.facebook.com/adpreferences">
              facebook.com/adpreferences
            </TextLink>
            .
          </p>
          <p>
            Beyond that, there is no analytics package, no session recorder, no embedded video
            and no chat widget on this site, and our fonts are served from our own servers rather
            than Google&rsquo;s. The one cookie we set ourselves carries step 1 of the enquiry
            form into step 2, lasts two hours, and is not used to track you.
          </p>
        </Prose>
      </Section>

      <Section id="consent-pointer" labelledBy="cp-heading">
        <h2 id="cp-heading" className="sr-only">
          Related
        </h2>
        <Prose>
          <p>
            Recording a call is also a legal question, not only a technical one. See{" "}
            <TextLink href="/consent">
              how call-recording consent works in India
            </TextLink>{" "}
            for what Aura enforces and what remains your responsibility.
          </p>
        </Prose>
      </Section>
    </>
  );
}
