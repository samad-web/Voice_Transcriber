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
 * Mirrors accounts/[id]/page.tsx. The account's name is the page title and isn't
 * known until the fetch resolves, so the header is a PageHeaderSkeleton. Then the
 * "All accounts" link and a `1fr | 20rem` grid: on the left the Follow-ups card
 * (an add row over a list of tasks) and the Timeline card (avatar rows); on the
 * right Details (domain, phone, last activity), the custom fields, People (a
 * bordered list of name over title) and the deals linked to the company.
 */
export default function AccountDetailLoading() {
  return (
    <>
      <PageHeaderSkeleton context="Account" />

      <div className="flex h-[18px] items-center">
        <Skeleton className="h-3 w-24" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <TaskListCardSkeleton rows={3} />
          <TimelineCardSkeleton rows={4} />
        </div>

        <div className="space-y-4">
          <DetailListCardSkeleton rows={3} />
          <Card>
            <div className="space-y-3">
              <div className="flex h-[18px] items-center">
                <Skeleton className="h-3 w-24" />
              </div>
              <FormFieldsSkeleton fields={2} submit={false} />
            </div>
          </Card>
          <BorderedListCardSkeleton rows={3} />
          <BorderedListCardSkeleton rows={2} sub="chip" />
        </div>
      </div>
    </>
  );
}
