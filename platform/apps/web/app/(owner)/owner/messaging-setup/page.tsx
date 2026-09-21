import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { ChannelBar } from "../channel-bar";
import { ConnectMethod } from "./connect-method";
import { embeddedSignupConfigAction } from "./actions";
// Same name as nav.ts's channel type and a different thing entirely - this one
// is a connected WhatsApp number. Only the local one is referenced here.
import type { MessagingChannel } from "./actions";

export const metadata: Metadata = { title: "WhatsApp Setup" };

export default async function MessagingSetupPage() {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("messaging_setup");

  // Both in one pass. The signup panel's readiness depends on the same channel
  // rows the form below renders, and fetching them sequentially would put a
  // second Mumbai->Seoul round trip in front of a page that already has one.
  const [result, signup] = await Promise.all([
    ownerTry<{ channels: MessagingChannel[] }>("/v1/messaging/channels"),
    embeddedSignupConfigAction(),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="WhatsApp Setup" context="Settings" />
        <LoadFailure what="your WhatsApp setup" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="WhatsApp Setup" context="Settings" />
      <ChannelBar />
      <p className="max-w-2xl text-sm text-text-muted">
        WhatsApp goes through Wasi - a WhatsApp Business Solution Provider - rather than Meta
        directly. Nothing about your Meta account is stored here.
      </p>

      {/*
        Both routes used to be stacked here, with a paragraph apologising for
        the order ("the rarer, more technical task"). An owner who does not
        know what a Business Solution Provider is cannot choose between two
        options they cannot tell apart, so ConnectMethod asks how they already
        USE the number - a fact they have - and shows one route.

        A workspace that already has a channel skips the question entirely; see
        the component. This is a settings page, not a wizard.
      */}
      <ConnectMethod channels={data.channels} signup={signup} />
    </>
  );
}
