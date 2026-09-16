import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import type { McpConnection } from "./actions";
import { MetaAdsConnect } from "./meta-ads-client";
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
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("meta_ads");

  const data = await ownerGet<{ connections: McpConnection[] }>("/v1/mcp/connections");
  const meta = data?.connections.find((c) => c.provider === "meta") ?? null;

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
        one Page, this will not let you choose which - ask your platform admin if you need a
        different Page connected.
      </p>
      <MetaAdsConnect />

      <McpConnect initial={meta} />
    </>
  );
}
