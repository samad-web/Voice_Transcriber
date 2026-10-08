import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { FormFieldsSkeleton } from "@/components/skeletons";

/**
 * Mirrors dialer/page.tsx top to bottom: the dial policy card (a heading, a
 * paragraph, two fields side by side, then the consent row under a rule), the
 * "New campaign" button, and two campaign cards.
 *
 * The preview table is not drawn. It only exists after somebody presses "Check
 * who is dialable", so a placeholder for it would promise a block that is not
 * there when the data lands - the same reason the suppression skeleton leaves
 * out its upload panel.
 */
export default function DialerLoading() {
  return (
    <>
      <PageHeader title="Dialer" context="Conversations" />

      <Card className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-full max-w-2xl" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormFieldsSkeleton fields={2} />
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-border pt-4">
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-72" />
            <Skeleton className="h-3.5 w-full max-w-2xl" />
          </div>
          <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
        </div>
      </Card>

      <Skeleton className="h-8 w-32 rounded-md" />

      {[0, 1].map((i) => (
        <Card key={i} className="space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-48" />
              <Skeleton className="h-3.5 w-80" />
            </div>
            <div className="space-y-1.5 text-right">
              <Skeleton className="ml-auto h-2.5 w-14" />
              <Skeleton className="ml-auto h-3.5 w-10" />
            </div>
          </div>
          <div className="flex gap-2 border-t border-border pt-3">
            <Skeleton className="h-8 w-40 rounded-md" />
            <Skeleton className="h-8 w-32 rounded-md" />
            <Skeleton className="h-8 w-16 rounded-md" />
          </div>
        </Card>
      ))}
    </>
  );
}
