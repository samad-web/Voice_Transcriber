import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { CallQualityManager } from "./call-quality-manager";
import type { CallIntegrityFlag } from "./actions";

export const metadata: Metadata = { title: "Call Quality" };

interface ListResponse {
  flags: CallIntegrityFlag[];
}

/**
 * The call-vs-CRM integrity review queue (0070): calls whose own AI read
 * (outcome, quality score) disagrees with the deal it produced, or failed
 * to. apps/worker/src/pipeline/call-crm-integrity.ts writes these; this page
 * is where an owner/manager works through them.
 */
export default async function CallQualityPage() {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("call_quality");

  const data = await ownerGet<ListResponse>("/v1/call-integrity-flags?status=open&limit=50");

  if (!data) {
    return (
      <>
        <PageHeader title="Call Quality" context="Pipeline" />
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
      <PageHeader title="Call Quality" context="Pipeline" />
      <p className="-mt-2 text-sm text-text-muted">
        Calls where the AI read and the CRM disagree - a promising call with no
        deal, an outcome that contradicts the deal&rsquo;s status, or a deal
        that&rsquo;s gone quiet since a strong first call. Dismiss what turns
        out to be fine, resolve what you fixed.
      </p>
      <CallQualityManager initial={data.flags} />
    </>
  );
}
