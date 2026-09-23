import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { IntegrationStatus } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry, requireFeature } from "@/lib/owner-context";
import { supportHref, supportLabel } from "@/lib/support-contact";
import { StoreBrowser } from "./store-browser";

export const metadata: Metadata = { title: "Integrations" };

/**
 * The Integrations store (doc 28 Part B): one place to browse, connect, see
 * the state of and manage every app Aura joins to.
 *
 * ── WHY THIS IS NOW A PLACE TO CONNECT, NOT JUST A BOARD ────────────────────
 *
 * The page used to be read-only, "because a second place to set up a WhatsApp
 * channel is a second place for the two to disagree". That concern was right,
 * and the store keeps it by MOVING each app's connect UI into one route
 * (`/owner/integrations/<id>/connect`) rather than copying it. The pages that
 * used to own a Connect button - Messaging setup, Lead sources, Meta ads,
 * Superfone, Invoices - keep their day-to-day work and link into that route.
 * One implementation, many doors.
 *
 * ── THREE KINDS OF "NO" ─────────────────────────────────────────────────────
 *
 * Not connected is a button. Not available means the OPERATOR has not
 * configured the deployment, and no button the customer presses will help.
 * Not on your plan is a sales conversation. Each reads differently because
 * each is answered by a different person.
 *
 * Every persona opens it (Q7); the API decides what each one sees.
 */
export default async function IntegrationsPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/integrations");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const result = await ownerTry<{ integrations: IntegrationStatus[] }>("/v1/owner/integrations");
  const href = supportHref();
  const support = href ? { href, label: supportLabel(href) } : null;

  return (
    <>
      <PageHeader
        title="Integrations"
        context="Workspace"
        description="Connect the apps your team already uses. Nothing here sends on its own."
      />
      {result.ok ? (
        <>
          <Summary statuses={result.data.integrations} />
          <StoreBrowser
            statuses={result.data.integrations}
            role={owner.membership.ownerRole}
            support={support}
          />
        </>
      ) : (
        <LoadFailure what="your integrations" failure={result} />
      )}
    </>
  );
}

function Summary({ statuses }: { statuses: IntegrationStatus[] }) {
  const connected = statuses.filter((s) => s.total > 0).length;
  const attention = statuses.filter((s) => s.state === "attention").length;
  return (
    <p className="-mt-2 text-sm text-text-muted">
      {connected === 0 ? "Nothing connected yet" : `${connected} connected`}
      {attention > 0 ? ` · ${attention} ${attention === 1 ? "needs" : "need"} attention` : ""}
    </p>
  );
}
