import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses, buttonStyle } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet, requireFeature } from "@/lib/owner-context";
import type { McpConnection } from "./actions";
import { McpConnect } from "./mcp-connect";

export const metadata: Metadata = { title: "Meta Lead Ads" };

/**
 * Connect Meta (Facebook) Lead Ads so leads submitted through a Page's
 * lead-gen forms land in this org's pipeline.
 *
 * Two routes, offered side by side because they fail in different ways: the
 * OAuth flow needs Meta app review and a public callback URL, and the MCP
 * flow (migration 0074) needs neither but needs a server to point at. An org
 * blocked on app review is not blocked on getting its leads in.
 */
export default async function MetaAdsPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/meta-ads");
  const data = await ownerGet<{ connections: McpConnection[] }>("/v1/mcp/connections");
  const meta = data?.connections.find((c) => c.provider === "meta") ?? null;

  return (
    <>
      <PageHeader title="Meta Lead Ads" context="Settings" />
      {/* This page used to warn that the FIRST Page an account managed was
          the one that got connected, with no way to choose. The store's
          connect flow ends on a choose step now (doc 28 §11.3), so the warning
          is gone and connecting is a door into that flow. */}
      <p className="max-w-2xl text-sm text-text-muted">
        Facebook Pages connected here send their Lead Ads form submissions straight to the board. You
        sign in to Facebook, choose which Pages send leads, and come back here when you&rsquo;re done.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          href={`/owner/integrations/meta_lead_ads/connect?from=${encodeURIComponent("/owner/meta-ads")}`}
          className={buttonClasses()}
          style={buttonStyle()}
        >
          Connect Facebook Pages
        </Link>
        <Link href="/owner/integrations/meta_lead_ads" className={buttonClasses({ variant: "secondary" })}>
          Connected Pages
        </Link>
      </div>

      <McpConnect initial={meta} />
    </>
  );
}
