import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { Inbox } from "./inbox-client";
import type { Conversation } from "./actions";

export const metadata: Metadata = { title: "Inbox — Aura" };

/**
 * Inbound messaging (migrations 0055/0056).
 *
 * The unmatched count is server-rendered from its own query for the same
 * reason the tasks page renders its overdue count that way: it is the number
 * somebody scans for, and one that arrives a beat late reads as "nothing is
 * waiting" — which here means an enquiry nobody has claimed.
 */
export default async function InboxPage() {
  const unmatched = await ownerGet<{ conversations: Conversation[]; total: number }>(
    "/v1/conversations?unmatchedOnly=true&limit=1",
  );

  return (
    <>
      <PageHeader title="Inbox" context="Pipeline" />

      {unmatched === null ? (
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          {unmatched.total > 0 ? (
            <Card>
              <MonoLabel>Unclaimed</MonoLabel>
              <p className="mt-2 text-3xl font-semibold text-text tabular-nums">
                {unmatched.total}
              </p>
              <p className="mt-1 text-xs text-text-muted">
                {unmatched.total === 1
                  ? "One thread is from a number that matches no contact."
                  : "Threads from numbers that match no contact."}{" "}
                A number saved from a call log and the same person&rsquo;s WhatsApp number are
                stored differently, so they do not always match automatically.
              </p>
            </Card>
          ) : null}

          <Card>
            <Inbox />
          </Card>
        </div>
      )}
    </>
  );
}
