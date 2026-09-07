import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FEATURE_GROUPS, type FeatureGroup, type FeatureState } from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet } from "@/lib/owner-context";
import { FeatureBoard } from "./feature-board";

export const metadata: Metadata = { title: "Features - Aura" };

export interface FeatureRow {
  key: string;
  label: string;
  blurb: string;
  group: FeatureGroup;
  module: string;
  locked: boolean;
  requires: string[];
  state: FeatureState;
  blockedBy: string | null;
}

/**
 * The client's own feature switchboard (migration 0101).
 *
 * ── WHAT THIS PAGE IS, AND WHAT IT IS NOT ─────────────────────────────────
 *
 * It decides which parts of the product THIS BUSINESS uses. It does not decide
 * who may use them - that is the Staff section's two axes - and it does not
 * decide what the business has bought, which stays with the provider.
 *
 * Those three being separate is the reason a customer can safely be handed
 * this at all. The worst an owner can do here is hide pages from their own
 * workspace, and even that is bounded: Leads and Staff cannot be switched off,
 * and this page has no catalogue entry of its own, so it can never hide
 * itself.
 *
 * ── THE FOUR STATES ARE FOUR DIFFERENT CONVERSATIONS ──────────────────────
 *
 *   on           in use.
 *   off          you switched it off. Switch it back.
 *   blocked      something it needs is off. The page names which.
 *   unavailable  not in your plan. Call your provider.
 *
 * Collapsing them into a checkbox would send somebody to the wrong person: a
 * greyed-out switch with no explanation reads as a bug, and the first support
 * ticket is "the toggle doesn't work".
 */
export default async function FeaturesPage() {
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const role = owner.membership.ownerRole;
  // Manager reads, owner writes - the same split as the Staff section, and for
  // the same reason: a manager has to be able to answer "why is Invoices
  // missing" before raising it as a bug.
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const data = await ownerGet<{ features: FeatureRow[] }>("/v1/owner/features");

  if (!data) {
    return (
      <>
        <PageHeader title="Features" context="Workspace" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  const byGroup = FEATURE_GROUPS.map((group) => ({
    ...group,
    features: data.features.filter((f) => f.group === group.key),
  })).filter((group) => group.features.length > 0);

  return (
    <>
      <PageHeader title="Features" context="Workspace" />
      <p className="-mt-2 max-w-prose text-sm leading-relaxed text-text-muted">
        Switch off the parts of Aura this business does not use, and they disappear from everybody’s
        sidebar. Nothing is deleted — switching a feature back on brings the same records back
        exactly as they were.
      </p>

      <FeatureBoard groups={byGroup} canEdit={role === "owner"} />

      {role === "manager" ? (
        <p className="text-sm text-text-muted">
          Only an Owner can change these.
        </p>
      ) : null}
    </>
  );
}
