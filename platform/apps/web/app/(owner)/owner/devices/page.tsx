import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { DevicesClient } from "./devices-client";
import type { DevicesResponse } from "./actions";

export const metadata: Metadata = { title: "Handsets" };

/**
 * Handsets (migration 0107).
 *
 * Deliberately NOT behind `requireOwnerFeature`: a phone is core Aura, not a
 * provisioned extra, and a tenant that cannot reach this page cannot pair the
 * device the entire product runs on. Every other gate here is per-person and
 * lives in the API - `canPair` and `canRevoke` come back on the payload.
 */
export default async function DevicesPage() {
  const data = await ownerGet<DevicesResponse>("/v1/owner/devices");

  if (!data) {
    return (
      <>
        <PageHeader title="Handsets" context="Settings" />
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
      <PageHeader title="Handsets" context="Settings" />
      <p className="-mt-2 max-w-2xl text-sm text-text-muted">
        The phones your telecallers call from. Calls made on a paired handset are recorded,
        transcribed and turned into leads. An owner decides who on the team may pair a new one -
        that is a setting on the Team page.
      </p>
      <DevicesClient data={data} />
    </>
  );
}
