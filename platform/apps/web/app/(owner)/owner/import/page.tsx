import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { requireOwnerFeature } from "@/lib/owner-features";
import { ChannelBar } from "../channel-bar";
import { ImportWizard } from "./import-client";

export const metadata: Metadata = { title: "Bulk Import" };

/**
 * Bulk CSV import: contacts, accounts or deals, mapped and de-duplicated by
 * hand. The whole flow is client-driven - parse the file in the browser, then
 * round-trip the parsed rows through the three server actions in
 * ./actions.ts - so there is nothing for this page to fetch server-side.
 */
export default async function ImportPage() {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("import");

  return (
    <>
      <PageHeader title="Bulk Import" context="Pipeline" />
      <ChannelBar />
      <ImportWizard />
    </>
  );
}
