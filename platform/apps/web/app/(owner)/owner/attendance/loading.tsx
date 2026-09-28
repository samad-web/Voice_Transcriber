import { Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TableBlockSkeleton, TabsSkeleton } from "@/components/skeletons";

/**
 * Mirrors attendance/page.tsx on its default Today tab: the boxed tab row, the
 * date line, and the live board - a name, the state pill, the shift window,
 * four durations, flags, the phone's battery and the pending-request count.
 * The optional banners (tracking off, unassigned handsets) are left out: most
 * workspaces never show them.
 */
export default function AttendanceLoading() {
  return (
    <>
      <PageHeader title="Attendance" context="Reports" />

      <TabsSkeleton variant="boxed" tabs={4} />

      <Skeleton className="h-3 w-72 max-w-full" />

      <TableBlockSkeleton
        columns={["primary", "chip", "text", "num", "num", "num", "num", "chip", "num", "num"]}
        rows={6}
      />
    </>
  );
}
