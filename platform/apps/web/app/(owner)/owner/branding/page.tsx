import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { BrandingForm, type BrandingView } from "./branding-client";

export const metadata: Metadata = { title: "Branding — Aura" };

/**
 * Org logo/colors (Kailash gap Milestone 4, migration 0065).
 *
 * GET /org returns the whole org row — `branding` is one jsonb column on it,
 * any subset of {logoUrl, primaryColor, secondaryColor, browserTitle} may be
 * present, `{}` if never configured. Defaulted to "" here so the form below
 * can stay a set of plain controlled inputs.
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
    primaryColor: branding.primaryColor ?? "",
    secondaryColor: branding.secondaryColor ?? "",
    browserTitle: branding.browserTitle ?? "",
  };

  return (
    <>
      <PageHeader title="Branding" context="Settings" />
      <p className="max-w-2xl text-sm text-text-muted">
        Set the logo and colors shown across this org&rsquo;s console, plus the title shown in the
        browser tab. Only the fields you change are sent — anything you leave alone keeps its
        current value.
      </p>
      <BrandingForm initial={initial} />
    </>
  );
}
