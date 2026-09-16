import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import type { LeadSourceKind } from "@aura/shared";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { publicApiOrigin } from "@/lib/public-origin";
import { requireOwnerFeature } from "@/lib/owner-features";
import { LeadSourcesClient } from "./lead-sources-client";

export const metadata: Metadata = { title: "Lead sources" };

export interface LeadSourceRow {
  id: string;
  kind: LeadSourceKind;
  name: string;
  provider: string;
  status: "active" | "paused" | "disabled";
  intake_token: string;
  config: Record<string, unknown>;
  endpointPath: string | null;
  marketing_source_id: string | null;
  marketing_source_name: string | null;
  project_id: string | null;
  project_name: string | null;
  assigned_telecaller_id: string | null;
  assigned_telecaller_name: string | null;
  has_signing_secret: boolean;
  event_count: number;
  error_count: number;
  last_event_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  lead_count: number;
  recent_failures: number;
  created_at: string;
}

export interface CatalogueChannel {
  id: LeadSourceKind;
  label: string;
  blurb: string;
  delivery: "browser" | "webhook" | "poll" | "key";
  path: string | null;
  providers: Array<{
    id: string;
    label: string;
    blurb: string;
    signature: string;
    fields: string[];
  }>;
}

export interface LinkedInStatus {
  configured: boolean;
  reason: string | null;
  connections: Array<{
    id: string;
    account_urn: string;
    account_name: string | null;
    status: string;
    last_synced_at: string | null;
    sync_failures: number;
    last_error: string | null;
  }>;
}

export default async function LeadSourcesPage() {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("lead_sources");

  const [sources, catalogue, linkedin] = await Promise.all([
    ownerGet<{ sources: LeadSourceRow[] }>("/v1/lead-sources"),
    ownerGet<{ channels: CatalogueChannel[] }>("/v1/lead-sources/catalogue"),
    ownerGet<LinkedInStatus>("/v1/linkedin/status"),
  ]);

  if (!sources || !catalogue) {
    return (
      <>
        <PageHeader title="Lead sources" context="Pipeline" />
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Lead sources" context="Pipeline" />
      <p className="-mt-2 max-w-2xl text-sm text-text-muted">
        Every way a lead can reach you. A form on your website, your enquiry
        inbox, your phone system, and your Facebook and LinkedIn ads all land on
        the same board as your calls - deduplicated against the people you
        already know, and labelled with where they came from so you can tell
        which channel is worth the money.
      </p>
      <LeadSourcesClient
        sources={sources.sources}
        channels={catalogue.channels}
        linkedin={linkedin ?? { configured: false, reason: null, connections: [] }}
        origin={publicApiOrigin()}
      />
    </>
  );
}
