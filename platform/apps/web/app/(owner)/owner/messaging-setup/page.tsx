import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { MessagingSetup } from "./messaging-setup-client";
// Same name as nav.ts's channel type and a different thing entirely - this one
// is a connected WhatsApp number. Only the local one is referenced here.
import type { MessagingChannel } from "./actions";

export const metadata: Metadata = { title: "WhatsApp number" };

export default async function MessagingSetupPage() {
  // Feature gate (migration 0101). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("messaging_setup");

  const result = await ownerTry<{ channels: MessagingChannel[] }>("/v1/messaging/channels");

  if (!result.ok) {
    return (
      <>
        <PageHeader title="WhatsApp number" context="Settings" />
        <LoadFailure what="your WhatsApp setup" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="WhatsApp number" context="Settings" />
      {/* This said WhatsApp goes "through Wasi … rather than Meta directly"
          while the card below offered "Connect through Meta" (doc 28 §16, 6d).
          Both routes are real; the sentence now says so. */}
      <p className="max-w-2xl text-sm text-text-muted">
        Your business numbers and Meta accounts, and what state each one is in. A number connects
        directly through Meta or through Wasi, a WhatsApp Business Solution Provider - both are a
        real WhatsApp Business Account.
      </p>

      {/*
        The day-to-day half only (doc 28 §15): the channels, their checks, the
        forward secret, switching one off. CONNECTING moved into the
        Integrations store's connect flow - including the "how do you use this
        number today?" question this page used to ask - and the card below
        links there. One connect implementation, reached from here and from
        the store alike; and Facebook's SDK no longer loads on a page that
        only lists channels.
      */}
      <MessagingSetup initial={data.channels} />
    </>
  );
}
