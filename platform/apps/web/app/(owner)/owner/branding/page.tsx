import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwnerBranding, ownerTry, requireFeature } from "@/lib/owner-context";
import { BrandingForm, type BrandingView } from "./branding-client";

export const metadata: Metadata = { title: "Logo & colours" };

/**
 * Org logo/colors (Kailash gap Milestone 4, migration 0065).
 *
 * `branding` is one jsonb column on the org row, and any subset of its keys
 * may be present - `{}` if never configured. `getOwnerBranding()` parses it
 * through the shared schema (so a stored value the API would now reject
 * cannot reach the form) and the layout has already resolved it for this
 * request, so reading it here costs nothing.
 *
 * Defaulted to "" per field because the form below is a set of plain controlled
 * inputs, and a controlled <input> cannot take null. `presets` defaults to []
 * for the same reason, one level up.
 *
 * The `ownerTry` call remains only to tell "API is down" apart from "org has no
 * branding" - `getOwnerBranding` answers `{}` to both, and rendering an empty
 * form over a dead API would invite someone to save into the void.
 */
export default async function BrandingPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/branding");
  const result = await ownerTry<{ id: string }>("/v1/org");

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Logo & colours" context="Settings" />
        <LoadFailure what="your branding" failure={result} />
      </>
    );
  }

  const branding = await getOwnerBranding();
  const initial: BrandingView = {
    logoUrl: branding.logoUrl ?? "",
    faviconUrl: branding.faviconUrl ?? "",
    bannerUrl: branding.bannerUrl ?? "",
    sidebarIconUrl: branding.sidebarIconUrl ?? "",
    loginBackgroundUrl: branding.loginBackgroundUrl ?? "",
    primaryColor: branding.primaryColor ?? "",
    secondaryColor: branding.secondaryColor ?? "",
    appBackgroundColor: branding.appBackgroundColor ?? "",
    textColor: branding.textColor ?? "",
    primaryHoverColor: branding.primaryHoverColor ?? "",
    secondaryHoverColor: branding.secondaryHoverColor ?? "",
    browserTitle: branding.browserTitle ?? "",
    presets: branding.presets ?? [],
  };

  return (
    <>
      <PageHeader title="Logo & colours" context="Settings" />
      <p className="max-w-2xl text-sm text-text-muted">
        The images, colours and tab title used across this org&rsquo;s console. Upload a file or
        paste a link to one you already host. Only the fields you change are sent, so anything you
        leave alone keeps its current value.
      </p>
      <BrandingForm initial={initial} />
    </>
  );
}
