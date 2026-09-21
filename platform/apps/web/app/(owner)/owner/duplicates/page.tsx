import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry, requireFeature } from "@/lib/owner-context";
import type { DuplicateMatch } from "../types";
import { DuplicatesManager } from "./duplicates-manager";

export const metadata: Metadata = { title: "Duplicates" };

interface ListResponse {
  duplicates: DuplicateMatch[];
}

/**
 * Merge & duplicate detection (CRM Phase 1, E0.3) - exact-match only (see
 * merge.controller.ts's header: fuzzy name+company matching needs pg_trgm,
 * unverified on the production Supabase project, and is deliberately not
 * attempted here).
 */
export default async function DuplicatesPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/duplicates");
  const result = await ownerTry<ListResponse>("/v1/merge/duplicates?status=pending");

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Duplicates" context="Pipeline" />
        <LoadFailure what="duplicates" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="Duplicates" context="Pipeline" />
      <p className="-mt-2 text-sm text-text-muted">
        Contacts and accounts that share the same external system id. Pick which record to keep -
        the other's history merges into it and can be undone for 30 days.
      </p>
      <DuplicatesManager initial={data.duplicates} />
    </>
  );
}
