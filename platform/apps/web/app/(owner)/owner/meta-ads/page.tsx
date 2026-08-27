import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { MetaAdsConnect } from "./meta-ads-client";

export const metadata: Metadata = { title: "Meta Lead Ads — Aura" };

/**
 * Connect Meta (Facebook) Lead Ads (Kailash gap Milestone 4) so leads
 * submitted through a Page's lead-gen forms land in this org's pipeline.
 *
 * No data to fetch here: there is no GET /meta/connections list endpoint yet,
 * so unlike connections/page.tsx this can't render a connection-status list
 * server-side. It is deliberately just the explanation plus the button.
 */
export default function MetaAdsPage() {
  return (
    <>
      <PageHeader title="Meta Lead Ads" context="Settings" />
      <p className="max-w-2xl text-sm text-text-muted">
        Connect a Facebook Page so leads submitted through its Lead Ads forms land here
        automatically. You&rsquo;ll be sent to Facebook to sign in and grant access, then
        redirected back once it&rsquo;s done.
      </p>
      <p className="max-w-2xl text-sm text-text-muted">
        There is no page picker yet: the <strong>first</strong> Facebook Page this account
        manages is the one that gets connected. If the account you sign in with manages more than
        one Page, this will not let you choose which — ask your platform admin if you need a
        different Page connected.
      </p>
      <MetaAdsConnect />
    </>
  );
}
