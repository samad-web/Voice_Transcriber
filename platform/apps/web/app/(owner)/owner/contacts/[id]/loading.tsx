import { Card, Skeleton } from "@aura/ui";
import {
  BorderedListCardSkeleton,
  DetailListCardSkeleton,
  FormFieldsSkeleton,
  PageHeaderSkeleton,
  TaskListCardSkeleton,
  TimelineCardSkeleton,
} from "@/components/skeletons";

/**
 * Mirrors contacts/[id]/page.tsx. The contact's name is the page title and isn't
 * known until the fetch resolves, so the header is a PageHeaderSkeleton. Under it
 * a row tucked against the header: the "Came in via ..." source chip and the link
 * to the original lead. Then the
 * `1fr | 20rem` grid: on the left Activity (a ghost Log activity button over avatar
 * rows), Follow-ups (an add row over a list of tasks) and the Email card, which
 * is collapsed to its label and a Write an email button; on the right Details,
 * Deals, the linked conversations and the custom fields.
 */
export default function ContactDetailLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Contact" />

      <div className="-mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Skeleton className="h-6.5 w-52 rounded-full" />
        <Skeleton className="h-3 w-32" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-6">
          <TimelineCardSkeleton rows={4} />
          <TaskListCardSkeleton rows={3} />
          <Card>
            <div className="flex items-center justify-between gap-2">
              <div className="flex h-[18px] items-center">
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="h-10 w-36 rounded-full sm:h-8" />
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <DetailListCardSkeleton rows={5} />
          <BorderedListCardSkeleton rows={2} sub="chip" />
          <BorderedListCardSkeleton rows={2} />
          <Card>
            <div className="space-y-3">
              <div className="flex h-[18px] items-center">
                <Skeleton className="h-3 w-24" />
              </div>
              <FormFieldsSkeleton fields={2} submit={false} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
