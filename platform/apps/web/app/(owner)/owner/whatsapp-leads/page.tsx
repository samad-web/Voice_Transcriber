import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwner } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { ChannelBar } from "../channel-bar";
import { ReviewQueueSection } from "../review/review-queue-section";

export const metadata: Metadata = { title: "WhatsApp leads" };

/**
 * WhatsApp qualification review (migration 0080).
 *
 * The screen that closes the gap 0055 left: an enquiry from a number nobody
 * recognises used to land in the unmatched inbox and stop there. A worker sweep
 * now reads those threads and proposes a lead; this is where a person accepts
 * or refuses one. Nothing reaches the CRM without that click.
 *
 * Since Phase 7 the queue itself is the review queue's section pinned to the
 * WhatsApp source, so this page and `/owner/review` share one card and one
 * definition of approving a lead.
 */
export default async function WhatsAppLeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("whatsapp_leads");
  const owner = await getOwner();
  if (!owner) notFound();
  const params = await searchParams;

  return (
    <>
      <PageHeader title="WhatsApp leads" context="Pipeline" />
      <ChannelBar />

      <div className="space-y-4">
        <Card>
          <MonoLabel>How this works</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Inbound WhatsApp threads from numbers that match no contact are read and scored.
            Approving one creates the contact, lead and deal, and claims the thread onto that
            contact. Nothing here messages anyone. Possible opt-outs and duplicates wait in the{" "}
            <Link href="/owner/review" className="underline hover:text-text">
              review queue
            </Link>
            .
          </p>
        </Card>

        <ReviewQueueSection
          owner={owner}
          filter="whatsapp"
          includeJunk={params.junk === "1"}
          base="/owner/whatsapp-leads"
          showTabs={false}
        />
      </div>
    </>
  );
}
