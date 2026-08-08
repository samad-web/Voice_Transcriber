import { Section, SectionHeading } from "../ui/layout";
import { LogoGrid } from "../ui/content";
import { CONNECTORS, CONNECTOR_COUNT } from "@/lib/content/connectors";

/**
 * Integrations (doc 10 §3 row 10). Reads as maturity — and it is real: every
 * name below is a spec in packages/shared/src/crm-providers.ts that the worker
 * dispatches against, not a logo scraped off a competitor's page.
 *
 * Two honesty constraints, both binding:
 *
 *   1. Names, not logos. There are no licensed vendor marks in this repo, and a
 *      wall of borrowed logos implies endorsement that none of these companies
 *      have given (doc 10 §15).
 *   2. The four OAuth-pending providers are marked in place. Doc 16 §3.7:
 *      Zoho, Salesforce, monday and Dynamics 365 authenticate today with pasted
 *      access tokens that expire in hours. Zoho is the market leader in India,
 *      so this will be a common answer, and letting the grid imply a turnkey
 *      integration would set up a sales call that ends badly.
 *
 * This section is immediately followed by the custom-CRM fork (doc 16 §4.1) so
 * the two read as one offer with two doors.
 */
export function Integrations() {
  return (
    <Section id="integrations" tone="subtle" labelledBy="integrations-heading">
      <SectionHeading
        id="integrations-heading"
        eyebrow="Integrations"
        title={`${CONNECTOR_COUNT} CRM connectors, mapped to your field names`}
        lead="Aura writes into the system you already use. You choose which of your fields each piece of the call lands in, nothing is forced into someone else's schema."
      />

      <div className="mt-10">
        <LogoGrid
          items={CONNECTORS.map((c) => ({
            name: c.name,
            note: c.oauthPending ? "Manual token setup" : undefined,
          }))}
        />
      </div>

      <p className="mt-6 max-w-3xl text-base text-text-muted">
        Four of these (Zoho, Salesforce, monday and Dynamics 365) currently connect
        with an access token you generate and paste in, and those tokens expire. The
        automatic refresh is still being built, so setting one up today means someone
        rotating a credential. We would rather you knew that before the call than
        after it. Anything not on this list can be reached through Zapier, Make, n8n
        or a plain webhook.
      </p>
    </Section>
  );
}
