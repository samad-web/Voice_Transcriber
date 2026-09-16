import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { getOwner } from "@/lib/owner-context";
import { parseReviewFilter, reviewSourcesFor } from "@/lib/review-queue";
import { ReviewQueueSection } from "./review-queue-section";

export const metadata: Metadata = { title: "Review queue" };

/**
 * The human-in-the-loop queue (CRM dashboard Phase 7): WhatsApp lead proposals,
 * possible opt-outs and duplicate records, decided inline.
 *
 * No feature gate of its own: each source is filtered by the feature and the
 * personas of the page it came from (lib/review-queue.ts), so this page shows
 * exactly the union of queues this person could already open one by one.
 */
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const owner = await getOwner();
  if (!owner) notFound();

  const params = await searchParams;
  const { ownerRole, enabledModules, featureOverrides } = owner.membership;
  const filter = parseReviewFilter(params.source, reviewSourcesFor(ownerRole, enabledModules, featureOverrides));

  return (
    <>
      <PageHeader title="Review queue" context="Pipeline" />
      <ReviewQueueSection
        owner={owner}
        filter={filter}
        includeJunk={filter === "whatsapp" && params.junk === "1"}
        base="/owner/review"
        showTabs
      />
    </>
  );
}
