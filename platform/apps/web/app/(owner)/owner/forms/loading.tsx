import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * Mirrors forms/page.tsx: the "New form" button, then two form cards - name
 * and status chip, the public address under it, the submission count on the
 * right, the question summary, and the row of buttons.
 *
 * Neither the create form nor the field builder is drawn: both appear only
 * after a click, so a placeholder would promise a card that is not there when
 * the data lands.
 */
export default function WebFormsLoading() {
  return (
    <>
      <PageHeader title="Web forms" context="Settings" />

      <Skeleton className="h-8 w-28 rounded-md" />

      {[0, 1].map((i) => (
        <Card key={i} className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3.5 w-64" />
            </div>
            <div className="space-y-1.5 text-right">
              <Skeleton className="ml-auto h-2.5 w-20" />
              <Skeleton className="ml-auto h-3.5 w-8" />
            </div>
          </div>
          <Skeleton className="h-3.5 w-full max-w-xl" />
          <div className="flex gap-2 border-t border-border pt-3">
            <Skeleton className="h-8 w-32 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
        </Card>
      ))}
    </>
  );
}
