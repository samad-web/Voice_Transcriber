import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { ownerGet, ownerTry, requireFeature } from "@/lib/owner-context";
import { CallQualityManager } from "./call-quality-manager";
import { DispositionsEditor } from "./dispositions-editor";
import type { CallIntegrityFlag } from "./actions";
import type { Disposition } from "./disposition-actions";

export const metadata: Metadata = { title: "Calls to check" };

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
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/call-quality");
  // Concurrent, and the vocabulary is optional: an outage there costs the
  // outcome editor, not the review queue this page exists for.
  const [result, dispositions] = await Promise.all([
    ownerTry<ListResponse>("/v1/call-integrity-flags?status=open&limit=50"),
    ownerGet<{ dispositions: Disposition[] }>("/v1/owner/call-dispositions"),
  ]);

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Calls to check" context="Conversations" />
        <LoadFailure what="the review queue" failure={result} />
      </>
    );
  }
  const data = result.data;

  return (
    <>
      <PageHeader title="Calls to check" context="Conversations" />
      <p className="-mt-2 text-sm text-text-muted">
        Calls where the AI read and the CRM disagree - a promising call with no deal, an outcome
        that contradicts the deal&rsquo;s status, or a deal that&rsquo;s gone quiet since a strong
        first call. Dismiss what turns out to be fine, resolve what you fixed.
      </p>
      <CallQualityManager initial={data.flags} />

      {/* The vocabulary the queue above is worked in. It lives on this page
          rather than in its own because the two are one job: reviewing calls,
          and deciding what the words for "reviewed" are. */}
      {dispositions ? <DispositionsEditor initial={dispositions.dispositions} /> : null}
    </>
  );
}
