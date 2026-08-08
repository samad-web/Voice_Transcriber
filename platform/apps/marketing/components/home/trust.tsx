import { Section, SectionHeading, Card } from "../ui/layout";
import { ButtonLink } from "../ui/button";

/**
 * Trust block — doc 10 §3 row 7 and §5.4. This answers the single largest
 * conversion blocker ("you're recording my customers' calls and sending them to
 * an AI") on the homepage rather than in a footer link.
 *
 * ─── ONE CORRECTION TO DOC 10 §5.4 ───────────────────────────────────────────
 * Doc 10's draft opens with "Encrypted on the handset before they leave it".
 * That is NOT true of the deployed build and it is not a small overstatement:
 *
 *   CaptureSettings.kt:49-55   `encryptAtRest` (AES-256-GCM) is OFF by default
 *   UploadWorker.kt:103-108    an encrypted file is decrypted to a temp file
 *                              and uploaded as plaintext over the TLS channel
 *
 * So on-device encryption is an optional at-rest setting, not a default, and it
 * is not what protects the upload — TLS is. The wording below says what is
 * true. Flagged in the run report; doc 10 §5.4's own instruction is "Do not add
 * one that isn't [true]", which is precisely why it was checked.
 *
 * Every other claim here was verified against the source:
 *   RLS isolation      0001_init.sql:11-12, :338, :348 — `aura_app` is
 *                      NOBYPASSRLS and every tenant table is FORCE RLS
 *   retention          organizations.retention_days, default 90 (0001_init.sql:27)
 *                      reaped by worker/pipeline/reaper.ts
 *   signed receipt     apps/api/.../tenancy/erasure.controller.ts — cascading
 *                      delete then an HMAC receipt written to the audit log
 *   audit log          audit_log (0001_init.sql:287) — org-scoped, actor,
 *                      action, target, ip. An ACTION log, so it is described
 *                      as one and not as "every access".
 */
const CLAIMS = [
  {
    title: "Encrypted in transit, always",
    body: "Recordings leave the handset over TLS only, the app ships with a network policy that refuses plaintext HTTP outright. Optional AES-256-GCM at-rest encryption on the device itself can be switched on per fleet.",
  },
  {
    title: "Isolated in the database, not in code",
    body: "Every customer's rows are separated by Postgres row-level security, enforced on a database role that has no permission to bypass it. Application code cannot forget to filter, because filtering is not application code's job here.",
  },
  {
    title: "Deleted on your schedule",
    body: "Your organisation sets a retention window, 90 days out of the box. When it expires, a scheduled job deletes the audio, the transcript and everything derived from it.",
  },
  {
    title: "Erasure you can prove",
    body: "Erasing one call removes the recording from storage and cascades through the transcript, the AI output, the extracted fields, the lead and the CRM delivery log, then writes a signed receipt into your audit log.",
  },
  {
    title: "An audit log you can read",
    body: "Every administrative action against your data is recorded with who did it, what they did, to what, and from where. It is scoped to your organisation and it is yours to inspect.",
  },
  {
    title: "No surprise sub-processors",
    body: "The services that touch your data are named, along with where they run, including the parts that are not yet in India.",
  },
];

export function Trust() {
  return (
    <Section id="trust" tone="subtle" labelledBy="trust-heading">
      <SectionHeading
        id="trust-heading"
        eyebrow="Your data"
        title="Your calls are yours"
        lead="You are about to let a piece of software listen to conversations with your customers. Here is exactly what happens to them."
      />

      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {CLAIMS.map((c) => (
          <Card key={c.title}>
            <h3 className="text-lg font-semibold text-text">{c.title}</h3>
            <p className="mt-2 text-base text-text-muted">{c.body}</p>
          </Card>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap gap-3">
        <ButtonLink href="/security" variant="secondary">
          How Aura handles your data
        </ButtonLink>
        <ButtonLink href="/consent" variant="ghost">
          Call recording and consent in India
        </ButtonLink>
      </div>
    </Section>
  );
}
