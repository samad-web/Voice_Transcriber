import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet, requireFeature } from "@/lib/owner-context";
import { MessagingSetup } from "./messaging-setup-client";
import type { MessagingChannel } from "./actions";

export const metadata: Metadata = { title: "WhatsApp Setup - Aura" };

export default async function MessagingSetupPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/messaging-setup");
  const data = await ownerGet<{ channels: MessagingChannel[] }>("/v1/messaging/channels");

  if (!data) {
    return (
      <>
        <PageHeader title="WhatsApp Setup" context="Settings" />
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
      <PageHeader title="WhatsApp Setup" context="Settings" />
      <p className="max-w-2xl text-sm text-text-muted">
        WhatsApp goes through Wasi - your own WhatsApp Business Solution Provider platform - not
        Meta directly. Connecting a number here needs the Hub API key and client id Wasi already
        issued for this org, plus a one-time paste of the forward secret from Wasi's admin panel.
      </p>
      <MessagingSetup initial={data.channels} />
    </>
  );
}
