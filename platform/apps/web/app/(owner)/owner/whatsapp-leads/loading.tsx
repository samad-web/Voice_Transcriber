import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ChannelStripSkeleton } from "@/components/skeletons";

/** The review cards' names, cycled so three cards do not read as one copied three times. */
const TITLE_W = ["w-40", "w-52", "w-36"] as const;

/**
 * One WhatsApp review card: source label and wait time, the contact's name, a
 * score / band chip / number / message-count line, the model's read of the
 * thread, then Approve / Edit / Reject and the link into the conversation.
 */
function ReviewCardSkeleton({ i }: { i: number }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex h-4 items-center gap-3">
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="h-2.5 w-20" />
      </div>
      <div className="mt-1 flex h-6 items-center">
        <Skeleton className={`h-4 ${TITLE_W[i % TITLE_W.length]}`} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Skeleton className="h-3.5 w-6" />
        <Skeleton className="h-5.5 w-14 rounded-full" />
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="mt-3">
        <div className="flex h-5 items-center">
          <Skeleton className="h-3.5 w-full" />
        </div>
        <div className="mt-1 flex h-4 items-center">
          <Skeleton className="h-2.5 w-4/5" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Skeleton className="h-10 w-20 rounded-full sm:h-8" />
        <Skeleton className="h-10 w-14 rounded-full sm:h-8" />
        <Skeleton className="h-10 w-16 rounded-full sm:h-8" />
        <Skeleton className="ml-auto h-3 w-32" />
      </div>
    </div>
  );
}

/**
 * Mirrors whatsapp-leads/page.tsx: the messaging channel strip under the header,
 * a "How this works" card, then the review queue pinned to WhatsApp (an
 * Include junk pill, one line of blurb, and a stack of review cards).
 */
export default function WhatsAppLeadsLoading() {
  return (
    <>
      <PageHeader title="WhatsApp leads" context="Pipeline" />
      <ChannelStripSkeleton active={2} />

      <div className="space-y-4">
        <Card>
          <div className="flex h-4 items-center">
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
        </Card>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-8 w-24 rounded-full" />
          </div>
          <div className="flex h-5 items-center">
            <Skeleton className="h-3.5 w-3/4 max-w-2xl" />
          </div>
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <ReviewCardSkeleton key={i} i={i} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
