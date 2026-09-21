import type { Metadata } from "next";
import { Card, StatCard } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { ChannelBar } from "../channel-bar";
import { Inbox } from "./inbox-client";
import type { Conversation } from "./actions";

export const metadata: Metadata = { title: "Inbox" };

/**
 * Inbound messaging (migrations 0055/0056).
 *
 * The unmatched count is server-rendered from its own query for the same
 * reason the tasks page renders its overdue count that way: it is the number
 * somebody scans for, and one that arrives a beat late reads as "nothing is
 * waiting" - which here means an enquiry nobody has claimed.
 */
export default async function InboxPage() {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("inbox");

  // Who may release an opt-out (migration 0100). Resolved here rather than in
  // the client so the console never offers a button the API will refuse -
  // OwnerRoleGuard is the actual gate; this only avoids showing a dead one.
  const owner = await getOwner();

  const unmatched = await ownerTry<{ conversations: Conversation[]; total: number }>(
    "/v1/conversations?unmatchedOnly=true&limit=1",
  );

  return (
    <>
      <PageHeader title="Inbox" context="Pipeline" />
      <ChannelBar />

      {!unmatched.ok ? (
        <LoadFailure what="the inbox" failure={unmatched} />
      ) : (
        <div className="space-y-4">
          {unmatched.data.total > 0 ? (
            // One tile rather than a full-width card: it is the page's only
            // headline number, and the sentence that used to sit under it was
            // doing two jobs - saying what the number counts, and explaining
            // why the situation arises at all. The first is the tile's
            // `context` line; the second is teaching copy and belongs beside
            // the tile, not inside it.
            <div className="grid gap-4 sm:grid-cols-[minmax(0,20rem)_1fr] sm:items-center">
              <StatCard
                label="Unclaimed"
                value={unmatched.data.total}
                context={
                  unmatched.data.total === 1
                    ? "thread matches no contact"
                    : "threads match no contact"
                }
              />
              <p className="text-sm text-text-muted">
                A number saved from a call log and the same person&rsquo;s WhatsApp number are
                stored differently, so they do not always match automatically. Claiming a thread
                onto a contact teaches the match for next time.
              </p>
            </div>
          ) : null}

          <Card>
            <Inbox canReleaseOptOut={owner?.membership.ownerRole === "owner" || owner?.membership.ownerRole === "manager"} />
          </Card>
        </div>
      )}
    </>
  );
}
