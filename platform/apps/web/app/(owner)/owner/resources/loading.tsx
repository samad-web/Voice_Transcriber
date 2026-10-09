import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton } from "@/components/skeletons";

/**
 * Mirrors resources/page.tsx: the "Add something bookable" button, the type
 * filter pills, and the stock table - code, name, type, booked, status, hold,
 * actions.
 *
 * The add FORM is not drawn: it only exists once somebody presses the button,
 * so a placeholder for it would promise a card that is not there when the data
 * lands. Three filter pills rather than the real count, which nothing knows
 * until the types read returns.
 */
export default function ResourcesLoading() {
  return (
    <>
      <PageHeader title="Bookable resources" context="Sales" />

      <Skeleton className="h-8 w-48 rounded-md" />

      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-2.5 w-10" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-6 w-20 rounded-full" />
        ))}
      </div>

      <TableBlockSkeleton
        columns={["primary", "text", "text", "num", "chip", "text", "actions"]}
        rows={5}
      />
    </>
  );
}
