import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ListCardSkeleton } from "@/components/skeletons";

/** A `MonoLabel` caption: a 16px line box with a thinner bar inside it. */
function Caption({ className }: { className: string }) {
  return (
    <div className="flex h-4 items-center">
      <Skeleton className={className} />
    </div>
  );
}

/**
 * Mirrors operators/page.tsx as the root operator sees it: the "How access
 * works" card (caption, two paragraphs, root/you chips), the "Appoint a
 * superadmin" form card (blurb, email + note inputs, an ADD button), the "Your
 * own sign-in" card (blurb, the root address and a reset button), then the
 * appointed-superadmins list - a titled strip over rows of email, added-by line
 * and row actions.
 */
export default function OperatorsLoading() {
  return (
    <>
      <PageHeader title="Superadmins" context="Platform" />

      <Card>
        <Caption className="h-3 w-32" />
        <div className="mt-2 space-y-1.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
        <div className="mt-2 space-y-1.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Skeleton className="h-6 w-56 rounded-full" />
          <Skeleton className="h-6 w-32 rounded-full" />
        </div>
      </Card>

      <Card className="space-y-3">
        <Caption className="h-3 w-36" />
        <div className="space-y-1">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9.5 w-72 rounded-sm" />
          <Skeleton className="h-9.5 w-56 rounded-sm" />
          <Skeleton className="h-10 w-20 rounded-full" />
        </div>
      </Card>

      <Card className="space-y-3">
        <Caption className="h-3 w-28" />
        <div className="space-y-1">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-7.5 w-36 rounded-md" />
        </div>
      </Card>

      <ListCardSkeleton title rows={4} trailing="button" />
    </>
  );
}
