import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Mirrors builder/page.tsx: the template gallery, then the report list. */
export default function ReportBuilderLoading() {
  return (
    <>
      <PageHeader title="Report builder" context="Pipeline" />
      <Card className="space-y-3">
        <Skeleton className="h-3 w-40" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-md" />
          ))}
        </div>
      </Card>
      <Card className="space-y-3">
        <Skeleton className="h-3 w-28" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-1.5 py-1">
            <Skeleton className="h-4 w-52" />
            <Skeleton className="h-3 w-72" />
          </div>
        ))}
      </Card>
    </>
  );
}
