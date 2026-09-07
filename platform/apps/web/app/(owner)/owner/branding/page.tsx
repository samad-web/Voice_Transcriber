import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { BrandingForm, type BrandingView } from "./branding-client";

export const metadata: Metadata = { title: "Branding - Aura" };

/**
 * Org logo/colors (Kailash gap Milestone 4, migration 0065).
 *
 * GET /org returns the whole org row - `branding` is one jsonb column on it,
 * and any subset of the eight keys may be present, `{}` if never configured.
 * Defaulted to "" here so the form below can stay a set of plain controlled
 * inputs.
 *
 * The four white-label keys (faviconUrl, bannerUrl, loginBackgroundUrl,
 * appBackgroundColor) were added to match the set the Hawcus gap analysis
 * §3.8 records. Because `branding` is jsonb they needed no migration, and a
 * tenant who configured branding before they existed reads them as "".
 */
export default async function BrandingPage() {
  const org = await ownerGet<{ id: string; branding?: Record<string, string> | null }>("/v1/org");

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

  const branding = org.branding ?? {};
  const initial: BrandingView = {
    logoUrl: branding.logoUrl ?? "",
    faviconUrl: branding.faviconUrl ?? "",
    bannerUrl: branding.bannerUrl ?? "",
    loginBackgroundUrl: branding.loginBackgroundUrl ?? "",
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
