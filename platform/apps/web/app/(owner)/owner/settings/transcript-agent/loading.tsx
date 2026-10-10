import { Card, Skeleton } from "@aura/ui";
import { PageHeader } from "@/components/page-header";

/**
 * The switchboard's own loader - see the note in the call-back list's for why
 * every page has one rather than sharing an ancestor's.
 *
 * Three cards, mirroring the page: the master switch with its state chip and
 * button, the mode radio list with a blurb under each, and the users table.
 */

const BLURB_W = ["w-full", "w-11/12", "w-10/12", "w-full", "w-9/12"] as const;

export default function TranscriptAgentSettingsLoading() {
  return (
    <>
      <PageHeader title="Call assistant" context="Settings" />
      <div className="flex flex-col gap-6">
        {/* The master switch. */}
        <Card>
          <div className="flex flex-col gap-4 p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-5 w-32 rounded-full" />
                </div>
                <Skeleton className="mt-2 h-3.5 w-10/12 max-w-prose" />
                <Skeleton className="mt-1 h-3.5 w-7/12 max-w-prose" />
              </div>
              <Skeleton className="h-10 w-56 shrink-0 rounded-full" />
            </div>
            <Skeleton className="h-12 w-full max-w-prose rounded-md" />
          </div>
        </Card>

        {/* The maximum mode and the capability checklist. */}
        <Card>
          <div className="flex flex-col gap-4 p-6">
            <Skeleton className="h-4 w-36" />
            <div className="flex flex-col gap-3">
              {BLURB_W.map((w, i) => (
                <div key={i} className="flex items-start gap-3">
                  <Skeleton className="mt-1 size-4 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className={`mt-1 h-3 ${w} max-w-prose`} />
                  </div>
                </div>
              ))}
            </div>
            <Skeleton className="h-10 w-48 rounded-full" />
          </div>
        </Card>

        {/* Who it is on for. */}
        <Card>
          <div className="flex flex-col gap-4 p-6">
            <Skeleton className="h-4 w-36" />
            <div className="flex flex-col gap-2">
              <div className="flex gap-3 border-b border-border pb-2">
                {["w-6", "w-24", "w-10", "w-16", "w-20", "w-14", "w-16"].map((w, i) => (
                  <Skeleton key={i} className={`h-3 ${w}`} />
                ))}
              </div>
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <Skeleton className="size-4 shrink-0" />
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-5 w-12 rounded-full" />
                  <Skeleton className="h-9.5 w-36 rounded-sm" />
                  <Skeleton className="ml-auto h-3 w-10" />
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-3 w-10" />
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
