import type { Metadata } from "next";
import type { BusinessProfile } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { accountPageRoles } from "@/lib/account-menu";
import { getOwnerBranding, ownerTry, requireOwnerRoles } from "@/lib/owner-context";
import { BusinessProfileForm } from "./business-client";

export const metadata: Metadata = { title: "Business profile" };

/**
 * Business profile (doc 27 §4.3, migration 0126). Owner edits; manager reads;
 * every other persona goes home before anything is fetched. Core, not a
 * feature - see the Profile page for why.
 */
export default async function BusinessProfilePage() {
  const owner = await requireOwnerRoles(accountPageRoles("business"));
  const result = await ownerTry<{ profile: BusinessProfile | null }>("/v1/owner/business-profile");
  const branding = await getOwnerBranding();

  return (
    <>
      <PageHeader title="Business profile" context="Account" />
      {!result.ok ? (
        <LoadFailure what="the business profile" failure={result} />
      ) : !result.data.profile ? (
        <LoadFailure
          what="the business profile"
          failure={{ ok: false, kind: "notfound", status: 404, message: "no workspace" }}
        />
      ) : (
        <BusinessProfileForm
          profile={result.data.profile}
          canEdit={owner.membership.ownerRole === "owner"}
          logoUrl={branding.logoUrl ?? null}
        />
      )}
    </>
  );
}
