import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { RecycleBinClient } from "./recycle-bin-client";
import type { BinResponse } from "./actions";

export const metadata: Metadata = { title: "Recycle bin" };

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
  const data = await ownerGet<BinResponse>("/v1/owner/recycle-bin");

  if (!data) {
    return (
      <>
        <PageHeader title="Recycle bin" context="Settings" />
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
      <PageHeader title="Recycle bin" context="Settings" />
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
