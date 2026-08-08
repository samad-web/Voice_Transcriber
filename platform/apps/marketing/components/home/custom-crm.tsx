import { Section, SectionHeading, Card } from "../ui/layout";
import { ButtonLink } from "../ui/button";
import { WhatsAppCta } from "../ui/whatsapp-cta";
import { CTABanner } from "../ui/cta-banner";
import { CONNECTOR_COUNT } from "@/lib/content/connectors";
import { WA_MESSAGES, startHref } from "@/lib/site";

/**
 * ═══ THE CUSTOM-CRM SECTION — doc 16 §4.1, in full ═══════════════════════════
 *
 * PLACEMENT IS PART OF THE SPEC. This renders immediately after the connector
 * grid and immediately before pricing, so the two read as one offer with two
 * doors rather than as two products. Do not move it.
 *
 * WHY IT EXISTS. Aura's connector catalogue answers "we push leads into your
 * CRM". It has no answer at all for "I don't have a CRM" — which, for brick,
 * interiors, real-estate and building-materials SMBs in Tamil Nadu, is the
 * majority. Today that visitor reaches pricing, realises the product assumes a
 * system they do not own, and leaves. This section converts that dead end into
 * the larger transaction.
 *
 * THE CREDIBILITY LINE IS TRUE, NOT MARKETING — which is the only reason this
 * offer is credible at an SMB price, and the reason it must be stated plainly
 * rather than inflated:
 *
 *   - the Agent Studio already compiles a tenant's typed field schema into the
 *     provider's responseSchema (packages/shared/src/extraction.ts, the agents
 *     module), so "your fields" is a configuration, not a rebuild;
 *   - the connector catalogue already does per-tenant field mapping
 *     (packages/shared/src/crm-providers.ts), so delivery is solved machinery.
 *
 * A custom CRM here is a configuration of machinery that exists. Say that. Do
 * not say "bespoke", do not say "built from scratch", and do not imply a
 * delivery capacity that has not been decided (doc 16 §4.1's business note).
 * ═══════════════════════════════════════════════════════════════════════════ */
export function CustomCrm() {
  return (
    <Section id="custom-crm" labelledBy="custom-crm-heading">
      <SectionHeading
        id="custom-crm-heading"
        eyebrow="Two doors"
        title="Your leads, wherever they need to go"
        lead="Most businesses we talk to are in one of two situations. Both of them work."
      />

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        {/* ── Door one: already have a CRM ───────────────────────────────── */}
        <Card className="flex flex-col">
          <h3 className="text-2xl font-semibold tracking-tight text-text">
            Already have a CRM
          </h3>
          <p className="mt-4 text-lg text-text-muted">
            Aura pushes every qualified call straight into it — {CONNECTOR_COUNT}{" "}
            connectors, your field names, your pipeline stages.
          </p>
          <p className="mt-4 text-base text-text-muted">
            You map each piece of a call to the field it belongs in. Nothing about how
            your team already works in that system has to change.
          </p>
          <div className="mt-auto pt-6">
            <ButtonLink href="#integrations" variant="secondary">
              See the integrations
            </ButtonLink>
          </div>
        </Card>

        {/* ── Door two: don't have one yet ───────────────────────────────── */}
        <Card className="flex flex-col border-accent">
          <h3 className="text-2xl font-semibold tracking-tight text-text">
            Don&rsquo;t have one yet
          </h3>
          <p className="mt-4 text-lg text-text-muted">
            We&rsquo;ll build you one, shaped around how you actually sell. Your
            stages, your fields, your language.
          </p>

          <p className="mt-6 text-lg font-medium text-text">
            A CRM built around your business, not around a template.
          </p>
          <p className="mt-3 text-base text-text-muted">
            Most CRMs make you describe your business in someone else&rsquo;s words —
            deals, opportunities, sales cycles. We build yours around what you
            actually track: brick type and quantity, site location, quotation status,
            follow-up date. Whatever your calls are already about.
          </p>
          <p className="mt-3 text-base text-text-muted">
            Aura feeds it automatically. Every qualified call becomes a record, with
            the details already filled in, in Tamil or English. Nobody types anything.
          </p>

          {/* The differentiator, and the honest version of it. */}
          <p className="mt-5 rounded-md border border-border bg-bg-subtle px-4 py-3 text-sm text-text-muted">
            Built on the same extraction engine your calls already run through · Your
            fields · Your stages · Your team&rsquo;s language
          </p>

          {/* "CTA to talk" (doc 16 §4.1). WhatsApp is that conversation's
              channel for this buyer (doc 10 §2), and the pre-filled opener
              carries the section as context so the reply can start from
              "how do you sell today" rather than "how can I help". */}
          <div className="mt-auto pt-6">
            <WhatsAppCta message={WA_MESSAGES.customCrm}>
              Talk to us about a custom CRM
            </WhatsAppCta>
          </div>
        </Card>
      </div>

      {/* ── The CTA banner, directly below the fork (doc 16 §4.1) ────────────
          Primary is WhatsApp: a wa.me deep link, no backend, which is what
          makes it deployable today.

          Secondary deep-links /start with a UTM naming THIS section as the
          source, so §3.7's CRM answers can be attributed back to the section
          that prompted them — that attribution is how anyone finds out whether
          this section earns its place. `/start` is slice 5, so the link is
          gated on FUNNEL_LIVE and the banner renders WhatsApp-only until then
          rather than shipping a 404. */}
      <div id="custom-crm-cta" className="mt-10 scroll-mt-20">
        <CTABanner
          title="Not sure which you need?"
          body="Tell us how you sell today and we'll tell you honestly whether you need a new system or just a connector."
          waMessage={WA_MESSAGES.customCrm}
          secondary={{
            href: startHref("custom-crm-section", "custom-crm"),
            label: "Start the 2-minute setup form",
            requiresFunnel: true,
          }}
        />
      </div>
    </Section>
  );
}
