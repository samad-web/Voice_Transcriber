import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry } from "@/lib/owner-context";
import { CallAccessClient, type CallAccessData } from "./call-access-client";

export const metadata: Metadata = { title: "Call access" };

/**
 * Who outside this business may look at its call recordings (migration 0122).
 *
 * ── WHY THIS PAGE IS NOT FEATURE-GATED ────────────────────────────────────
 *
 * Every other owner page runs `requireFeature()` first. This one deliberately
 * does not. The features table (0093) is provisioning - what the VENDOR has
 * switched on for this tenant - and a control over whether the vendor may
 * read the tenant's recordings must not itself be something the vendor can
 * switch off. A tenant that cannot reach this page cannot revoke, and a
 * revocation they cannot reach is not a revocation.
 *
 * It is also not gated on the `call_intel` module for the same reason: a
 * tenant whose call intelligence is switched off still HAS recordings, and
 * still has a say in who hears them.
 *
 * Owner and manager may read it; every decision on it is owner-only, enforced
 * by `@RequireOwnerRole("owner")` on the API rather than here.
 */
export default async function CallAccessPage() {
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const result = await ownerTry<CallAccessData>("/v1/owner/call-access");

  return (
    <>
      <PageHeader
        title="Call access"
        context="Settings"
        description="Nobody outside your team can open your call logs, recordings or transcripts without your approval."
      />

      {result.ok ? (
        <CallAccessClient data={result.data} canDecide={role === "owner"} />
      ) : (
        <Card>
          <LoadFailure failure={result} what="call access settings" />
        </Card>
      )}
    </>
  );
}
