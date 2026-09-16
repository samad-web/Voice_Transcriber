import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwnerBranding, ownerGet, requireFeature } from "@/lib/owner-context";
import { BrandingForm, type BrandingView } from "./branding-client";

export const metadata: Metadata = { title: "Branding" };

/**
 * Org logo/colors (Kailash gap Milestone 4, migration 0065).
 *
 * `branding` is one jsonb column on the org row, and any subset of the eight
 * keys may be present - `{}` if never configured. `getOwnerBranding()` parses
 * it through the shared schema (so a stored value the API would now reject
 * cannot reach the form) and the layout has already resolved it for this
 * request, so reading it here costs nothing.
 *
 * Defaulted to "" per field because the form below is a set of plain controlled
 * inputs, and a controlled <input> cannot take null.
 *
 * The `ownerGet` call remains only to tell "API is down" apart from "org has no
 * branding" - `getOwnerBranding` answers `{}` to both, and rendering an empty
 * form over a dead API would invite someone to save into the void.
 */
export default async function BrandingPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/branding");
  const org = await ownerGet<{ id: string }>("/v1/org");

  if (!org) {
    return (
      <>
        <PageHeader title="Branding" context="Settings" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  const branding = await getOwnerBranding();
  const initial: BrandingView = {
    logoUrl: branding.logoUrl ?? "",
    faviconUrl: branding.faviconUrl ?? "",
    bannerUrl: branding.bannerUrl ?? "",
    primaryColor: branding.primaryColor ?? "",
    secondaryColor: branding.secondaryColor ?? "",
    appBackgroundColor: branding.appBackgroundColor ?? "",
    browserTitle: branding.browserTitle ?? "",
  };

  return (
    <>
      <PageHeader title="Branding" context="Settings" />
      <p className="max-w-2xl text-sm text-text-muted">
        The images, colours and tab title used across this org&rsquo;s console and its sign-in
        screen. Images are links to files you already host &mdash; there is no upload here. Only the
        fields you change are sent, so anything you leave alone keeps its current value.
      </p>
      <BrandingForm initial={initial} />
    </>
  );
}
