import type { Metadata } from "next";
import { EmptyState } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getPortal } from "../../portal-context";

export const metadata: Metadata = { title: "Resources" };

/**
 * Screen four (Build docs/39 §19): tenant-uploaded collateral.
 *
 * ── THIS SCREEN HAS NO ENDPOINT YET, ON PURPOSE ───────────────────────────
 *
 * The table that holds a tenant's shareable collateral is `resources`,
 * migration 0165 - doc 39 §24, phase P6. It does not exist, and P4 does not
 * own it.
 *
 * Two wrong ways to handle that were considered. Building a second,
 * partner-only collateral table in 0162 would duplicate 0165 and leave
 * somebody migrating rows between them later. Shipping
 * `GET /v1/portal/resources` returning a hard-coded `[]` would be worse: it
 * reads as a working feature with no data, so the first person who looks goes
 * hunting for why the tenant's uploads are not showing, and the route lands in
 * `guard-mounting.spec.ts`'s counts as though it did something.
 *
 * So the screen ships, says plainly what it is waiting for, and costs one
 * fetch less than it would otherwise. When 0165 lands, this file gains a
 * `portalGet("/v1/portal/resources")` and loses this comment.
 *
 * It is kept in the nav rather than hidden because §19 specifies five screens
 * and a partner asking "where do I get the brochure" should find the answer
 * here rather than discover there is no such place.
 */
export default async function PortalResourcesPage() {
  const portal = await getPortal();
  const workspace = portal?.workspace.name || "the team";

  return (
    <>
      <PageHeader
        title="Resources"
        description={`Brochures, price lists and anything else ${workspace} shares with you.`}
      />
      <EmptyState
        title={`${workspace} hasn't shared any resources yet`}
        description="When they upload brochures, price lists or photos for partners, they appear here."
      />
    </>
  );
}
