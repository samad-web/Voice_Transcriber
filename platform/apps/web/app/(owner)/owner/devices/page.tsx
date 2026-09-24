import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerGet, ownerTry } from "@/lib/owner-context";
import { DevicesClient } from "./devices-client";
import type { DevicesResponse, FleetHealthResponse } from "./actions";

export const metadata: Metadata = { title: "Phones" };

/**
 * Handsets (migration 0107).
 *
 * Deliberately NOT behind `requireOwnerFeature`: a phone is core Aura, not a
 * provisioned extra, and a tenant that cannot reach this page cannot pair the
 * device the entire product runs on. Every other gate here is per-person and
 * lives in the API - `canPair` and `canRevoke` come back on the payload. The
 * catalogue agrees: `handsets` is a LOCKED feature (features.ts), so the
 * switch an owner sees on /owner/features reads "always on" rather than
 * offering them a way to lock themselves out of their own fleet.
 *
 * ── THE SECOND FETCH ──────────────────────────────────────────────────────
 *
 * `/v1/devices/fleet-health` is where the retired `/owner/handsets` page got
 * its staleness and needs-attention chips, and folding it in here is what let
 * that page become a redirect. It answers a different question from the list:
 * the list says a handset is enrolled and active, health says whether it has
 * actually been heard from - and an "active" phone silent for a week is the
 * failure this page exists to surface early.
 *
 * It is fetched in PARALLEL and its failure is survivable. A handset list with
 * no health chips is a worse page; a handset list that refuses to render
 * because a secondary endpoint timed out is a broken one, and this is the page
 * somebody opens when they are already having trouble with a phone.
 */
export default async function DevicesPage() {
  const [result, fleetHealth] = await Promise.all([
    ownerTry<DevicesResponse>("/v1/owner/devices"),
    ownerGet<FleetHealthResponse>("/v1/devices/fleet-health"),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Phones" context="Settings" />
        <LoadFailure what="your devices" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="Phones" context="Settings" />
      <p className="-mt-2 max-w-2xl text-sm text-text-muted">
        The phones your telecallers call from. Calls made on a paired handset are recorded,
        transcribed and turned into leads. An owner decides who on the team may pair a new one -
        that is a setting on the Team page.
      </p>
      <DevicesClient data={data} health={fleetHealth?.devices ?? []} />
    </>
  );
}
