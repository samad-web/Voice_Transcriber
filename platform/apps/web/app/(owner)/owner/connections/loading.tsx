import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/** Mirrors connections/page.tsx: intro copy, then a grid of provider cards (Google/Microsoft/IMAP/CalDAV). */
export default function ConnectionsLoading() {
  return (
    <>
      <PageHeader title="Connections" context="Your account" />
      <Skeleton className="h-3.5 w-full max-w-2xl" />
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="flex items-center justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-8 w-20 shrink-0 rounded-full" />
          </Card>
        ))}
      </div>
    </>
  );
}
