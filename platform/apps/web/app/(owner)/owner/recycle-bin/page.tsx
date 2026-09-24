import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerTry } from "@/lib/owner-context";
import { RecycleBinClient } from "./recycle-bin-client";
import type { BinResponse } from "./actions";

export const metadata: Metadata = { title: "Deleted items" };

/**
 * The recycle bin (migration 0108).
 *
 * Not behind `requireOwnerFeature`: this is not a provisioned extra, it is the
 * safety net under deletes that already exist across the console. Gating it
 * would mean a tenant whose feature flag was off could delete a tag and have
 * no way to get it back, which is the exact state 0108 was written to remove.
 *
 * The API gates it to owner and manager, and the nav entry matches.
 */
export default async function RecycleBinPage() {
  const result = await ownerTry<BinResponse>("/v1/owner/recycle-bin");

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Deleted items" context="Settings" />
        <LoadFailure what="the recycle bin" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="Deleted items" context="Settings" />
      <p className="-mt-2 max-w-2xl text-sm text-text-muted">
        Tags, rules, datasets, targets and connections your team has deleted. They are kept for{" "}
        {data.retentionDays} days with everything that was attached to them, so restoring one brings
        back the taggings, shares or queued work that went with it. After that they are removed for
        good.
      </p>
      <RecycleBinClient data={data} />
    </>
  );
}
