import { Card, Skeleton } from "@aura/ui";
import { FormFieldsSkeleton, PageHeaderSkeleton } from "@/components/skeletons";

/**
 * Mirrors agents/[id]/page.tsx (an agent that exists and is not archived): the
 * Versions card - the version list with its switch-on buttons, then the switch
 * off / archive row - followed by the agent editor's stack of cards: about,
 * describe-it-and-let-AI-draft-it, the instructions box, the details to pull
 * out, a test panel, and the save buttons. The title and eyebrow are the
 * agent's own name and kind, so the header is a skeleton. The kind-specific
 * lead-rules and reply-style panels sit below the fold and are left out.
 */
export default function AgentLoading() {
  return (
    <>
      <PageHeaderSkeleton context="AI assistants" />

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-28 rounded-full" />
        </div>
        <div className="divide-y divide-border rounded-md border border-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-3 w-28" />
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-3.5 w-8" />
                <Skeleton className="h-8 w-20 rounded-full" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Skeleton className="h-10 w-28 rounded-full" />
          <Skeleton className="h-10 w-24 rounded-full" />
        </div>
      </Card>

      {/* AgentEditor's own root: one block with a tighter rhythm (space-y-4) than <main>'s. */}
      <div className="space-y-4">
        <Card className="space-y-4">
          <Skeleton className="h-3 w-28" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormFieldsSkeleton fields={1} submit={false} />
          </div>
          <FormFieldsSkeleton fields={1} submit={false} />
        </Card>

        <Card className="space-y-3">
          <Skeleton className="h-3 w-52" />
          <Skeleton className="h-3.5 w-full max-w-prose" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-10 w-36 rounded-full" />
        </Card>

        <Card className="space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-full max-w-prose" />
          <Skeleton className="h-34 w-full" />
          <Skeleton className="ml-auto h-3 w-24" />
        </Card>

        <Card className="space-y-3">
          <Skeleton className="h-3 w-36" />
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <div key={i} className="space-y-3 rounded-md border border-border p-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_12rem]">
                  <div className="space-y-1">
                    <Skeleton className="h-3.5 w-16" />
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-2/3" />
                  </div>
                  <div className="space-y-1">
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="h-9.5 w-full" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-14 w-full" />
                </div>
                <div className="flex justify-end">
                  <Skeleton className="h-8 w-16 rounded-full" />
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <Skeleton className="h-10 w-28 rounded-full" />
              <Skeleton className="h-3 w-10" />
            </div>
          </div>
        </Card>

        <Card className="space-y-3">
          <Skeleton className="h-3 w-36" />
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-10 w-44 rounded-full" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
        </Card>

        <div className="flex flex-wrap items-center gap-2 border-t border-border py-3">
          <Skeleton className="h-10 w-44 rounded-full" />
          <Skeleton className="h-10 w-40 rounded-full" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
      </div>
    </>
  );
}
