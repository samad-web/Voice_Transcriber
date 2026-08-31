import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { ImportWizard } from "./import-client";

export const metadata: Metadata = { title: "Bulk Import - Aura" };

/**
 * Bulk CSV import: contacts, accounts or deals, mapped and de-duplicated by
 * hand. The whole flow is client-driven - parse the file in the browser, then
 * round-trip the parsed rows through the three server actions in
 * ./actions.ts - so there is nothing for this page to fetch server-side.
 */
export default function ImportPage() {
  return (
    <>
      <PageHeader title="Bulk Import" context="Pipeline" />
      <ImportWizard />
    </>
  );
}
