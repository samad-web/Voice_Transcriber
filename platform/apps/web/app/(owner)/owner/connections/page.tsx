import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet, ownerTry, requireFeature } from "@/lib/owner-context";
import type { OAuthAppsView } from "./actions";
import { ConnectionsManager, type ConnectionView, type ProviderView } from "./connections-manager";
import { OAuthAppsPanel } from "./oauth-apps-panel";

export const metadata: Metadata = { title: "Connections" };

/**
 * Connect your own email and calendar (PRD Layer 1).
 *
 * Under the owner console rather than the platform console on purpose: these
 * are one person's accounts, not a tenant-wide setting an operator
 * administers. Every persona sees this page - a telecaller's own mailbox is
 * exactly the thing they would connect.
 */
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/connections");
  const { connected, error } = await searchParams;
  const owner = await getOwner();
  const [result, mine, oauthApps] = await Promise.all([
    ownerTry<{ providers: ProviderView[] }>("/v1/connections/providers"),
    ownerGet<{ connections: ConnectionView[] }>("/v1/connections"),
    // Owner-only on the API, which is the gate. Asked only for an owner so a
    // manager's every visit is not a logged 403; null (not asked, or refused)
    // means the panel is not rendered.
    owner?.membership.ownerRole === "owner"
      ? ownerGet<OAuthAppsView>("/v1/connections/oauth-apps")
      : Promise.resolve(null),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Connections" context="Your account" />
        <LoadFailure what="your connections" failure={result} />
      </>
    );
  }
  const catalogue = result.data;

  return (
    <>
      <PageHeader title="Connections" context="Your account" />
      <p className="max-w-2xl text-sm text-text-muted">
        Connect the mailbox and calendar you already use. Google and Microsoft sign in directly;
        anything else that speaks IMAP or CalDAV works too, so you are not tied to one provider.
        Credentials are encrypted and belong to you alone.
      </p>
      <ConnectionsManager
        providers={catalogue.providers}
        connections={mine?.connections ?? []}
        initialConnected={connected ?? null}
        initialError={error ?? null}
      />
      {oauthApps ? <OAuthAppsPanel data={oauthApps} /> : null}
    </>
  );
}
