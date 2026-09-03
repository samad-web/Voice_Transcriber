import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Mirrors the editor: toolbar, page tabs, then a canvas of tiles. */
export default function ReportEditorLoading() {
  return (
    <>
      <PageHeader title="Report" context="Report builder" />
      <Card className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-5 w-48" />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-20 rounded-md" />
            ))}
          </div>
        </div>
      </Card>
      <div className="flex gap-1.5">
        <Skeleton className="h-7 w-20 rounded-sm" />
        <Skeleton className="h-7 w-20 rounded-sm" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-56 w-full rounded-lg" />
        ))}
      </div>
    </>
  );
}
