import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { FormFieldsSkeleton } from "@/components/skeletons";

/**
 * Mirrors instances/new/page.tsx: a back link, then a two-column split - the
 * "New Customer Instance" form card (company name, device server URL, a consent
 * policy / retention pair, a key TTL / max enrollments pair, the Enable CRM
 * opt-in box and a full-width submit) beside a tall card that holds the
 * provisioned credentials once the form has been sent.
 */
export default function NewInstanceLoading() {
  return (
    <>
      <PageHeader title="New Instance" context="Platform" />
      <Skeleton className="h-3.5 w-28" />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card elevated className="space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>

          <FormFieldsSkeleton fields={2} submit={false} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormFieldsSkeleton fields={2} submit={false} />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormFieldsSkeleton fields={2} submit={false} />
          </div>

          <div className="flex items-start gap-2.5 rounded-md border border-border p-3">
            <Skeleton className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-2.5 w-full" />
              <Skeleton className="h-2.5 w-full" />
              <Skeleton className="h-2.5 w-2/3" />
            </div>
          </div>

          <Skeleton className="h-10 w-full rounded-full" />
        </Card>

        <Card className="flex min-h-48 flex-col items-center justify-center gap-2">
          <Skeleton className="h-3 w-52" />
          <Skeleton className="h-2.5 w-64 max-w-full" />
          <Skeleton className="h-2.5 w-40" />
        </Card>
      </div>
    </>
  );
}
