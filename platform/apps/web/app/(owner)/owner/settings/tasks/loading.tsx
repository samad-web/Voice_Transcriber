import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * Mirrors settings/tasks/page.tsx: one card with a heading, two paragraphs of
 * explanation, and the toggle pinned to the right of them.
 */
export default function TaskSettingsLoading() {
  return (
    <>
      <PageHeader title="Task settings" context="Settings" />

      <Card className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-64" />
            <Skeleton className="h-3.5 w-full max-w-2xl" />
            <Skeleton className="h-3.5 w-3/4 max-w-xl" />
            <Skeleton className="h-3.5 w-2/3 max-w-lg" />
          </div>
          <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
        </div>
      </Card>
    </>
  );
}
