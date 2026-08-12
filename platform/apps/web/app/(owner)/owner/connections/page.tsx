import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { ConnectionsManager, type ConnectionView, type ProviderView } from "./connections-manager";

export const metadata: Metadata = { title: "Connections — Aura" };

/**
 * Connect your own email and calendar (PRD Layer 1).
 *
 * Under the owner console rather than the platform console on purpose: these
 * are one person's accounts, not a tenant-wide setting an operator
 * administers. Every persona sees this page — a telecaller's own mailbox is
 * exactly the thing they would connect.
 */
export default async function ConnectionsPage() {
  const [catalogue, mine] = await Promise.all([
    ownerGet<{ providers: ProviderView[] }>("/v1/connections/providers"),
    ownerGet<{ connections: ConnectionView[] }>("/v1/connections"),
  ]);

  if (!catalogue) {
    return (
      <>
        <PageHeader title="Connections" context="Your account" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

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
      />
    </>
  );
}
