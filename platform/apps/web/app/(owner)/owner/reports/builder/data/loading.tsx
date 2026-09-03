import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

export default function DataSourcesLoading() {
  return (
    <>
      <PageHeader title="Data sources" context="Report builder" />
      <Card className="space-y-3">
        <Skeleton className="h-3 w-32" />
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-md" />
          ))}
        </div>
      </Card>
      <Card className="space-y-3">
        <Skeleton className="h-3 w-36" />
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </Card>
    </>
  );
}
