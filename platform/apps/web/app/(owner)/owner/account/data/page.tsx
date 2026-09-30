import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { accountPageRoles } from "@/lib/account-menu";
import { ownerTry, requireOwnerRoles } from "@/lib/owner-context";
import { ExportsCentre } from "./exports-centre";
import type { ExportJobRow } from "./actions";

export const metadata: Metadata = { title: "Your data" };

/**
 * The exports centre (doc 35 SS8.4, migration 0148).
 *
 * ── WHO SEES WHAT ───────────────────────────────────────────────────────────
 *
 * Everyone reaches this page; the API decides the rows. An owner gets the whole
 * workspace's jobs, everybody else their own. That is why the page is not
 * owner-gated: restricting it would hide a telecaller's own downloads from them,
 * and the thing worth protecting is the FILE, not the history.
 *
 * ── AND WHY AN OWNER STILL CANNOT DOWNLOAD SOMEBODY ELSE'S FILE ─────────────
 *
 * `canDownload` comes from the API per row, rather than the console deciding it
 * from the persona. An owner reading the table sees what was exported, by whom,
 * how big and whether it was fetched - and the Download button renders only on
 * their own rows. The rule lives in one place (SS7.2) and the UI reads it.
 */
export default async function YourDataPage() {
  await requireOwnerRoles(accountPageRoles("data"));
  const result = await ownerTry<{ jobs: ExportJobRow[] }>("/v1/exports");

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Your data" context="Account" />
        <LoadFailure what="your exports" failure={result} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Your data" context="Account" />
      <ExportsCentre initialJobs={result.data.jobs} />
    </>
  );
}
